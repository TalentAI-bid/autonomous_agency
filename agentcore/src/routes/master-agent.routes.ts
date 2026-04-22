import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq, and, desc, count, avg, gt, lt, inArray, isNull, sql } from 'drizzle-orm';
import { withTenant } from '../config/database.js';
import { masterAgents, agentConfigs, contacts, campaigns, campaignContacts, emailsSent, companies, documents, pipelineErrors } from '../db/schema/index.js';
import { registerTenantWorkers, scheduleAgentJobs } from '../queues/workers.js';
import { MasterAgent } from '../agents/master-agent.js';
import { NotFoundError, ValidationError } from '../utils/errors.js';
import { extractJSON } from '../tools/together-ai.tool.js';
import { removeAllEmailListenerJobs, removeAllEmailSendJobs } from '../services/email-poll-scheduler.service.js';
import { flushEmailQueue } from '../tools/email-queue.tool.js';
import { drainAllPipelineQueues } from '../services/queue.service.js';
import { resetSearchRateLimits } from '../tools/searxng.tool.js';
import { getQuotaSnapshot } from '../services/runtime-budget.service.js';
import { applyActionPlanAnswers, isActionPlanComplete } from '../prompts/action-plan.prompt.js';
import type { ActionPlan } from '../db/schema/master-agents.js';
import type { PipelineContext } from '../types/pipeline-context.js';
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
    scoringThreshold: z.number().min(0).max(100).default(50),
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

    // Clean up all pipeline + repeatable jobs — prevents orphaned jobs after agent deletion
    try {
      await drainAllPipelineQueues(request.tenantId);
      await removeAllEmailListenerJobs(request.tenantId);
      await removeAllEmailSendJobs(request.tenantId);
    } catch (err) {
      logger.error({ err, tenantId: request.tenantId, agentId: id }, 'Failed to clean up jobs on delete');
    }

    return { success: true };
  });

  // GET /api/master-agents/:id/action-plan
  fastify.get<{ Params: { id: string } }>('/:id/action-plan', async (request) => {
    const { id } = request.params;
    const [agent] = await withTenant(request.tenantId, async (tx) => {
      return tx.select({ actionPlan: masterAgents.actionPlan, status: masterAgents.status, useCase: masterAgents.useCase })
        .from(masterAgents)
        .where(and(eq(masterAgents.id, id), eq(masterAgents.tenantId, request.tenantId)))
        .limit(1);
    });
    if (!agent) throw new NotFoundError('MasterAgent', id);
    return { data: { actionPlan: agent.actionPlan ?? null, status: agent.status, useCase: agent.useCase } };
  });

  // PATCH /api/master-agents/:id/action-plan — submit answers
  const actionPlanPatchSchema = z.object({
    answers: z.record(z.string(), z.string().optional()),
    skip: z.boolean().optional(),
  });
  fastify.patch<{ Params: { id: string } }>('/:id/action-plan', async (request) => {
    const { id } = request.params;
    const parsed = actionPlanPatchSchema.safeParse(request.body);
    if (!parsed.success) throw new ValidationError('Invalid input', parsed.error.flatten());

    const [agent] = await withTenant(request.tenantId, async (tx) => {
      return tx.select().from(masterAgents)
        .where(and(eq(masterAgents.id, id), eq(masterAgents.tenantId, request.tenantId)))
        .limit(1);
    });
    if (!agent) throw new NotFoundError('MasterAgent', id);

    const existing = (agent.actionPlan as ActionPlan | null);
    if (!existing) throw new ValidationError('Action plan has not been generated yet — start the agent once to generate it.');

    const merged: ActionPlan = {
      ...existing,
      items: existing.items.map((item) => {
        const ans = parsed.data.answers[item.key];
        if (ans === undefined) return item;
        return { ...item, answer: ans };
      }),
    };

    if (parsed.data.skip) {
      merged.status = 'skipped';
    } else {
      merged.status = isActionPlanComplete(merged.items) ? 'completed' : 'pending';
    }
    if (merged.status !== 'pending') merged.completedAt = new Date().toISOString();

    // Fold answers into config + pipelineContext so the outreach prompts see them
    const cfg = (agent.config as Record<string, unknown>) ?? {};
    const pipelineCtx = (cfg.pipelineContext as PipelineContext | undefined);
    const folded = applyActionPlanAnswers(merged.items, cfg, pipelineCtx);

    const nextStatus = merged.status === 'completed' || merged.status === 'skipped'
      ? 'idle' // ready to be (re-)started
      : 'awaiting_action_plan';

    const [updated] = await withTenant(request.tenantId, async (tx) => {
      return tx.update(masterAgents)
        .set({
          actionPlan: merged,
          status: nextStatus,
          config: { ...folded.config, pipelineContext: folded.pipelineContext },
          updatedAt: new Date(),
        })
        .where(and(eq(masterAgents.id, id), eq(masterAgents.tenantId, request.tenantId)))
        .returning();
    });
    return { data: { actionPlan: merged, status: updated?.status } };
  });

  // GET /api/master-agents/:id/quota — daily runtime usage
  fastify.get<{ Params: { id: string } }>('/:id/quota', async (request) => {
    const { id } = request.params;
    const [agent] = await withTenant(request.tenantId, async (tx) => {
      return tx.select({ dailyRuntimeBudgetMs: masterAgents.dailyRuntimeBudgetMs, status: masterAgents.status })
        .from(masterAgents)
        .where(and(eq(masterAgents.id, id), eq(masterAgents.tenantId, request.tenantId)))
        .limit(1);
    });
    if (!agent) throw new NotFoundError('MasterAgent', id);

    const snapshot = await getQuotaSnapshot(id, agent.dailyRuntimeBudgetMs);
    return { data: { ...snapshot, status: agent.status } };
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
    const [prev] = await withTenant(request.tenantId, async (tx) => {
      return tx.select({ status: masterAgents.status }).from(masterAgents)
        .where(and(eq(masterAgents.id, id), eq(masterAgents.tenantId, request.tenantId)))
        .limit(1);
    });
    logger.info(
      { masterAgentId: id, tenantId: request.tenantId, previousStatus: prev?.status ?? null },
      'Agent resumed, re-triggering full dispatch via execute()',
    );
    const [agent] = await withTenant(request.tenantId, async (tx) => {
      return tx.update(masterAgents)
        .set({ status: 'running', updatedAt: new Date() })
        .where(and(eq(masterAgents.id, id), eq(masterAgents.tenantId, request.tenantId)))
        .returning();
    });
    if (!agent) throw new NotFoundError('MasterAgent', id);

    // Register workers for this tenant if not already done
    registerTenantWorkers(request.tenantId);

    // Drain stale jobs and reset rate limits BEFORE execute dispatches new jobs
    await drainAllPipelineQueues(request.tenantId);
    await removeAllEmailListenerJobs(request.tenantId);
    await removeAllEmailSendJobs(request.tenantId);
    await flushEmailQueue(request.tenantId);
    await resetSearchRateLimits(request.tenantId);

    // Run MasterAgent orchestrator — parses mission, generates queries, dispatches discovery jobs
    const masterAgent = new MasterAgent({ tenantId: request.tenantId, masterAgentId: id });
    try {
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
      await scheduleAgentJobs(request.tenantId, id, agentCfg);
      logger.info({ tenantId: request.tenantId, agentId: id }, 'Agent jobs scheduled from /start');

      return { data: { status: 'running', ...result } };
    } catch (err) {
      await masterAgent.close().catch(() => {});
      await withTenant(request.tenantId, async (tx) => {
        return tx.update(masterAgents)
          .set({ status: 'error', updatedAt: new Date() })
          .where(and(eq(masterAgents.id, id), eq(masterAgents.tenantId, request.tenantId)));
      });
      logger.error({ err, tenantId: request.tenantId, agentId: id }, 'MasterAgent execute failed in /start');
      throw err;
    }
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

    // Clean up all pipeline + repeatable email jobs for this tenant
    try {
      await drainAllPipelineQueues(request.tenantId);
      await removeAllEmailListenerJobs(request.tenantId);
      await removeAllEmailSendJobs(request.tenantId);
    } catch (err) {
      logger.error({ err, tenantId: request.tenantId, agentId: id }, 'Failed to clean up jobs on stop');
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

  // GET /api/master-agents/:id/emails — Sent emails for this agent (paginated)
  fastify.get<{ Params: { id: string }; Querystring: { cursor?: string; limit?: string } }>('/:id/emails', async (request) => {
    const { id } = request.params;
    const limit = Math.min(parseInt(request.query.limit || '100', 10), 100);
    const { cursor } = request.query;

    const results = await withTenant(request.tenantId, async (tx) => {
      // Find campaigns for this master agent
      const agentCampaigns = await tx
        .select({ id: campaigns.id })
        .from(campaigns)
        .where(and(eq(campaigns.masterAgentId, id), eq(campaigns.tenantId, request.tenantId)));

      if (agentCampaigns.length === 0) return [];

      const campaignIds = agentCampaigns.map((c) => c.id);

      const conditions = [inArray(campaignContacts.campaignId, campaignIds)];
      if (cursor) {
        try {
          const decoded = JSON.parse(Buffer.from(cursor, 'base64').toString());
          conditions.push(lt(emailsSent.sentAt, new Date(decoded.sentAt)));
        } catch { throw new ValidationError('Invalid cursor'); }
      }

      // Get emails through campaignContacts -> emailsSent
      return tx
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
        .where(and(...conditions))
        .orderBy(desc(emailsSent.sentAt))
        .limit(limit + 1);
    });

    const hasMore = results.length > limit;
    const data = hasMore ? results.slice(0, limit) : results;
    const nextCursor = hasMore && data.length > 0
      ? Buffer.from(JSON.stringify({ sentAt: data[data.length - 1]!.sentAt?.toISOString() })).toString('base64')
      : null;

    return { data, pagination: { hasMore, nextCursor } };
  });

  // GET /api/master-agents/:id/companies — Companies discovered by this agent (paginated)
  fastify.get<{ Params: { id: string }; Querystring: { cursor?: string; limit?: string } }>('/:id/companies', async (request) => {
    const { id } = request.params;
    const limit = Math.min(parseInt(request.query.limit || '100', 10), 100);
    const { cursor } = request.query;

    const conditions = [
      eq(companies.masterAgentId, id),
      eq(companies.tenantId, request.tenantId),
      sql`COALESCE(${companies.dataCompleteness}, 0) >= 10`,
    ];
    if (cursor) {
      try {
        const decoded = JSON.parse(Buffer.from(cursor, 'base64').toString());
        conditions.push(lt(companies.createdAt, new Date(decoded.createdAt)));
      } catch { throw new ValidationError('Invalid cursor'); }
    }

    const results = await withTenant(request.tenantId, async (tx) => {
      return tx.select().from(companies)
        .where(and(...conditions))
        .orderBy(desc(companies.createdAt))
        .limit(limit + 1);
    });

    const hasMore = results.length > limit;
    const data = hasMore ? results.slice(0, limit) : results;
    const nextCursor = hasMore && data.length > 0
      ? Buffer.from(JSON.stringify({ createdAt: data[data.length - 1]!.createdAt.toISOString() })).toString('base64')
      : null;

    return { data, pagination: { hasMore, nextCursor } };
  });

  // GET /api/master-agents/:id/documents — Documents for this agent (paginated)
  fastify.get<{ Params: { id: string }; Querystring: { cursor?: string; limit?: string } }>('/:id/documents', async (request) => {
    const { id } = request.params;
    const limit = Math.min(parseInt(request.query.limit || '100', 10), 100);
    const { cursor } = request.query;

    const conditions = [eq(documents.masterAgentId, id), eq(documents.tenantId, request.tenantId)];
    if (cursor) {
      try {
        const decoded = JSON.parse(Buffer.from(cursor, 'base64').toString());
        conditions.push(lt(documents.createdAt, new Date(decoded.createdAt)));
      } catch { throw new ValidationError('Invalid cursor'); }
    }

    const results = await withTenant(request.tenantId, async (tx) => {
      return tx.select().from(documents)
        .where(and(...conditions))
        .orderBy(desc(documents.createdAt))
        .limit(limit + 1);
    });

    const hasMore = results.length > limit;
    const data = hasMore ? results.slice(0, limit) : results;
    const nextCursor = hasMore && data.length > 0
      ? Buffer.from(JSON.stringify({ createdAt: data[data.length - 1]!.createdAt.toISOString() })).toString('base64')
      : null;

    return { data, pagination: { hasMore, nextCursor } };
  });

  // GET /api/master-agents/:id/errors — list pipeline errors for a master agent
  fastify.get<{ Params: { id: string }; Querystring: { limit?: string; unresolved?: string } }>(
    '/:id/errors',
    async (request) => {
      const { id } = request.params;
      const limit = Math.min(Math.max(parseInt(request.query.limit ?? '20', 10) || 20, 1), 100);
      const unresolvedOnly = request.query.unresolved !== 'false';

      const conditions = [
        eq(pipelineErrors.masterAgentId, id),
        eq(pipelineErrors.tenantId, request.tenantId),
      ];
      if (unresolvedOnly) conditions.push(isNull(pipelineErrors.resolvedAt));

      const data = await withTenant(request.tenantId, async (tx) => {
        return tx.select().from(pipelineErrors)
          .where(and(...conditions))
          .orderBy(desc(pipelineErrors.createdAt))
          .limit(limit);
      });

      return { data };
    },
  );

  // PATCH /api/master-agents/:id/errors/:errorId/resolve — dismiss a pipeline error
  fastify.patch<{ Params: { id: string; errorId: string } }>(
    '/:id/errors/:errorId/resolve',
    async (request) => {
      const { id, errorId } = request.params;
      const [updated] = await withTenant(request.tenantId, async (tx) => {
        return tx.update(pipelineErrors)
          .set({ resolvedAt: new Date() })
          .where(
            and(
              eq(pipelineErrors.id, errorId),
              eq(pipelineErrors.masterAgentId, id),
              eq(pipelineErrors.tenantId, request.tenantId),
            ),
          )
          .returning();
      });
      if (!updated) throw new NotFoundError('PipelineError', errorId);
      return { data: updated };
    },
  );
}
