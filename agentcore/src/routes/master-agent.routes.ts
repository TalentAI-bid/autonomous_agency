import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq, and, desc, count, avg, gt, inArray } from 'drizzle-orm';
import { withTenant } from '../config/database.js';
import { masterAgents, agentConfigs, contacts, campaigns, campaignContacts, emailsSent, companies, documents } from '../db/schema/index.js';
import { registerTenantWorkers, scheduleAgentJobs } from '../queues/workers.js';
import { MasterAgent } from '../agents/master-agent.js';
import { NotFoundError, ValidationError } from '../utils/errors.js';
import { extractJSON } from '../tools/together-ai.tool.js';
import { removeAllEmailListenerJobs, removeAllEmailSendJobs } from '../services/email-poll-scheduler.service.js';
import logger from '../utils/logger.js';
import {
  buildSystemPrompt as buildPipelineSystemPrompt,
  buildUserPrompt as buildPipelineUserPrompt,
  type PipelineBuilderInput,
  type PipelineProposal,
} from '../prompts/pipeline-builder.prompt.js';

const createMasterAgentSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().optional(),
  mission: z.string().optional(),
  useCase: z.enum(['recruitment', 'sales', 'custom']),
  config: z.record(z.unknown()).optional(),
});

const updateMasterAgentSchema = createMasterAgentSchema.partial();

const updateAgentConfigSchema = z.object({
  systemPrompt: z.string().optional(),
  tools: z.array(z.string()).optional(),
  parameters: z.record(z.unknown()).optional(),
  outputSchema: z.record(z.unknown()).optional(),
  isEnabled: z.boolean().optional(),
});

export default async function masterAgentRoutes(fastify: FastifyInstance) {
  fastify.addHook('onRequest', fastify.authenticate);

  // GET /api/master-agents
  fastify.get('/', async (request) => {
    const results = await withTenant(request.tenantId, async (tx) => {
      return tx.select().from(masterAgents)
        .where(eq(masterAgents.tenantId, request.tenantId))
        .orderBy(desc(masterAgents.createdAt));
    });
    return { data: results };
  });

  // POST /api/master-agents
  fastify.post('/', async (request, reply) => {
    const parsed = createMasterAgentSchema.safeParse(request.body);
    if (!parsed.success) throw new ValidationError('Invalid input', parsed.error.flatten());

    const [agent] = await withTenant(request.tenantId, async (tx) => {
      return tx.insert(masterAgents).values({
        tenantId: request.tenantId,
        ...parsed.data,
        createdBy: request.userId,
      }).returning();
    });

    return reply.status(201).send({ data: agent });
  });

  // POST /api/master-agents/analyze-pipeline — AI pipeline analysis
  const analyzePipelineSchema = z.object({
    useCase: z.enum(['recruitment', 'sales', 'custom']),
    targetRole: z.string().optional(),
    requiredSkills: z.array(z.string()).optional(),
    experienceLevel: z.string().optional(),
    locations: z.array(z.string()).optional(),
    targetIndustry: z.string().optional(),
    companySize: z.string().optional(),
    additionalContext: z.string().optional(),
    scoringThreshold: z.number().min(0).max(100).default(70),
    emailTone: z.string().default('professional'),
    enableOutreach: z.boolean().default(true),
  });

  fastify.post('/analyze-pipeline', async (request) => {
    const parsed = analyzePipelineSchema.safeParse(request.body);
    if (!parsed.success) throw new ValidationError('Invalid input', parsed.error.flatten());

    const input = parsed.data as PipelineBuilderInput;
    const messages = [
      { role: 'system' as const, content: buildPipelineSystemPrompt() },
      { role: 'user' as const, content: buildPipelineUserPrompt(input) },
    ];

    const proposal = await extractJSON<PipelineProposal>(request.tenantId, messages);
    return { data: proposal };
  });

  // GET /api/master-agents/:id
  fastify.get<{ Params: { id: string } }>('/:id', async (request) => {
    const { id } = request.params;
    const [agent] = await withTenant(request.tenantId, async (tx) => {
      return tx.select().from(masterAgents)
        .where(and(eq(masterAgents.id, id), eq(masterAgents.tenantId, request.tenantId)))
        .limit(1);
    });
    if (!agent) throw new NotFoundError('MasterAgent', id);
    return { data: agent };
  });

  // PATCH /api/master-agents/:id
  fastify.patch<{ Params: { id: string } }>('/:id', async (request) => {
    const { id } = request.params;
    const parsed = updateMasterAgentSchema.safeParse(request.body);
    if (!parsed.success) throw new ValidationError('Invalid input', parsed.error.flatten());

    const [agent] = await withTenant(request.tenantId, async (tx) => {
      return tx.update(masterAgents)
        .set({ ...parsed.data, updatedAt: new Date() })
        .where(and(eq(masterAgents.id, id), eq(masterAgents.tenantId, request.tenantId)))
        .returning();
    });
    if (!agent) throw new NotFoundError('MasterAgent', id);
    return { data: agent };
  });

  // DELETE /api/master-agents/:id
  fastify.delete<{ Params: { id: string } }>('/:id', async (request) => {
    const { id } = request.params;
    const result = await withTenant(request.tenantId, async (tx) => {
      return tx.delete(masterAgents)
        .where(and(eq(masterAgents.id, id), eq(masterAgents.tenantId, request.tenantId)))
        .returning({ id: masterAgents.id });
    });
    if (result.length === 0) throw new NotFoundError('MasterAgent', id);

    // Clean up repeatable jobs — prevents orphaned polls after agent deletion
    try {
      await removeAllEmailListenerJobs(request.tenantId);
      await removeAllEmailSendJobs(request.tenantId);
    } catch (err) {
      logger.error({ err, tenantId: request.tenantId, agentId: id }, 'Failed to remove repeatable jobs on delete');
    }

    return { success: true };
  });

  // GET /api/master-agents/:id/agents — List sub-agent configs
  fastify.get<{ Params: { id: string } }>('/:id/agents', async (request) => {
    const { id } = request.params;
    const configs = await withTenant(request.tenantId, async (tx) => {
      return tx.select().from(agentConfigs)
        .where(and(eq(agentConfigs.masterAgentId, id), eq(agentConfigs.tenantId, request.tenantId)));
    });
    return { data: configs };
  });

  // PUT /api/master-agents/:id/agents/:type — Configure a sub-agent
  fastify.put<{ Params: { id: string; type: string } }>('/:id/agents/:type', async (request, reply) => {
    const { id, type } = request.params;
    const parsed = updateAgentConfigSchema.safeParse(request.body);
    if (!parsed.success) throw new ValidationError('Invalid input', parsed.error.flatten());

    const [config] = await withTenant(request.tenantId, async (tx) => {
      // Upsert: insert or update
      const existing = await tx.select().from(agentConfigs)
        .where(and(
          eq(agentConfigs.masterAgentId, id),
          eq(agentConfigs.agentType, type as any),
          eq(agentConfigs.tenantId, request.tenantId),
        ))
        .limit(1);

      if (existing.length > 0) {
        return tx.update(agentConfigs)
          .set({ ...parsed.data, updatedAt: new Date() })
          .where(eq(agentConfigs.id, existing[0]!.id))
          .returning();
      } else {
        return tx.insert(agentConfigs).values({
          tenantId: request.tenantId,
          masterAgentId: id,
          agentType: type as any,
          ...parsed.data,
        }).returning();
      }
    });

    return reply.status(200).send({ data: config });
  });

  // POST /api/master-agents/:id/start — Start agent orchestration
  fastify.post<{ Params: { id: string } }>('/:id/start', async (request) => {
    const { id } = request.params;
    const [agent] = await withTenant(request.tenantId, async (tx) => {
      return tx.update(masterAgents)
        .set({ status: 'running', updatedAt: new Date() })
        .where(and(eq(masterAgents.id, id), eq(masterAgents.tenantId, request.tenantId)))
        .returning();
    });
    if (!agent) throw new NotFoundError('MasterAgent', id);

    // Register workers for this tenant if not already done
    registerTenantWorkers(request.tenantId);

    // Run MasterAgent orchestrator — parses mission, generates queries, dispatches discovery jobs
    const masterAgent = new MasterAgent({ tenantId: request.tenantId, masterAgentId: id });
    const result = await masterAgent.execute({ masterAgentId: id, mission: agent.mission });
    await masterAgent.close();

    // Re-fetch config from DB after execute() — it may have updated the config
    const [freshAgent] = await withTenant(request.tenantId, async (tx) => {
      return tx.select({ config: masterAgents.config }).from(masterAgents)
        .where(and(eq(masterAgents.id, id), eq(masterAgents.tenantId, request.tenantId)))
        .limit(1);
    });
    const agentCfg = (freshAgent?.config as Record<string, unknown>) ?? {};
    logger.info({ tenantId: request.tenantId, agentId: id, configKeys: Object.keys(agentCfg) }, 'Scheduling agent jobs from /start');
    await removeAllEmailListenerJobs(request.tenantId);
    await removeAllEmailSendJobs(request.tenantId);
    await scheduleAgentJobs(request.tenantId, id, agentCfg);
    logger.info({ tenantId: request.tenantId, agentId: id }, 'Agent jobs scheduled from /start');

    return { data: { status: 'running', ...result } };
  });

  // POST /api/master-agents/:id/stop — Stop all running agents
  fastify.post<{ Params: { id: string } }>('/:id/stop', async (request) => {
    const { id } = request.params;
    const [agent] = await withTenant(request.tenantId, async (tx) => {
      return tx.update(masterAgents)
        .set({ status: 'paused', updatedAt: new Date() })
        .where(and(eq(masterAgents.id, id), eq(masterAgents.tenantId, request.tenantId)))
        .returning();
    });
    if (!agent) throw new NotFoundError('MasterAgent', id);

    // Clean up all repeatable email jobs for this tenant
    try {
      await removeAllEmailListenerJobs(request.tenantId);
      await removeAllEmailSendJobs(request.tenantId);
    } catch (err) {
      logger.error({ err, tenantId: request.tenantId, agentId: id }, 'Failed to remove repeatable jobs on stop');
    }

    return { data: { status: 'paused' } };
  });

  // GET /api/master-agents/:id/stats — Agent pipeline stats
  fastify.get<{ Params: { id: string } }>('/:id/stats', async (request) => {
    const { id } = request.params;

    const data = await withTenant(request.tenantId, async (tx) => {
      const [totalResult] = await tx
        .select({ count: count() })
        .from(contacts)
        .where(and(eq(contacts.masterAgentId, id), eq(contacts.tenantId, request.tenantId)));

      const byStatusRows = await tx
        .select({ status: contacts.status, count: count() })
        .from(contacts)
        .where(and(eq(contacts.masterAgentId, id), eq(contacts.tenantId, request.tenantId)))
        .groupBy(contacts.status);

      const [avgScoreResult] = await tx
        .select({ avg: avg(contacts.score) })
        .from(contacts)
        .where(and(eq(contacts.masterAgentId, id), eq(contacts.tenantId, request.tenantId), gt(contacts.score, 0)));

      return {
        totalContacts: totalResult?.count || 0,
        byStatus: Object.fromEntries(byStatusRows.map((r) => [r.status, r.count])),
        avgScore: avgScoreResult?.avg ? Math.round(Number(avgScoreResult.avg)) : null,
      };
    });

    return { data };
  });

  // GET /api/master-agents/:id/emails — Sent emails for this agent
  fastify.get<{ Params: { id: string } }>('/:id/emails', async (request) => {
    const { id } = request.params;

    const data = await withTenant(request.tenantId, async (tx) => {
      // Find campaigns for this master agent
      const agentCampaigns = await tx
        .select({ id: campaigns.id })
        .from(campaigns)
        .where(and(eq(campaigns.masterAgentId, id), eq(campaigns.tenantId, request.tenantId)));

      if (agentCampaigns.length === 0) return [];

      const campaignIds = agentCampaigns.map((c) => c.id);

      // Get emails through campaignContacts -> emailsSent
      const emails = await tx
        .select({
          id: emailsSent.id,
          fromEmail: emailsSent.fromEmail,
          toEmail: emailsSent.toEmail,
          subject: emailsSent.subject,
          sentAt: emailsSent.sentAt,
          openedAt: emailsSent.openedAt,
          repliedAt: emailsSent.repliedAt,
          messageId: emailsSent.messageId,
        })
        .from(emailsSent)
        .innerJoin(campaignContacts, eq(emailsSent.campaignContactId, campaignContacts.id))
        .where(inArray(campaignContacts.campaignId, campaignIds))
        .orderBy(desc(emailsSent.sentAt))
        .limit(50);

      return emails;
    });

    return { data };
  });

  // GET /api/master-agents/:id/companies — Companies discovered by this agent
  fastify.get<{ Params: { id: string } }>('/:id/companies', async (request) => {
    const { id } = request.params;

    const data = await withTenant(request.tenantId, async (tx) => {
      return tx.select().from(companies)
        .where(and(eq(companies.masterAgentId, id), eq(companies.tenantId, request.tenantId)))
        .orderBy(desc(companies.createdAt))
        .limit(100);
    });

    return { data };
  });

  // GET /api/master-agents/:id/documents — Documents for this agent
  fastify.get<{ Params: { id: string } }>('/:id/documents', async (request) => {
    const { id } = request.params;

    const data = await withTenant(request.tenantId, async (tx) => {
      return tx.select().from(documents)
        .where(and(eq(documents.masterAgentId, id), eq(documents.tenantId, request.tenantId)))
        .orderBy(desc(documents.createdAt))
        .limit(100);
    });

    return { data };
  });
}
