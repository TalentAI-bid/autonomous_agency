import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq, and, desc } from 'drizzle-orm';
import { withTenant } from '../config/database.js';
import { masterAgents, agentConfigs } from '../db/schema/index.js';
import { registerTenantWorkers } from '../queues/workers.js';
import { MasterAgent } from '../agents/master-agent.js';
import { NotFoundError, ValidationError } from '../utils/errors.js';

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

    // In Prompt 2: actually pause/drain all agent queues for this master agent
    return { data: { status: 'paused' } };
  });
}
