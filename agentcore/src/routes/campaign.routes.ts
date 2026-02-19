import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq, and, desc, lt } from 'drizzle-orm';
import { withTenant } from '../config/database.js';
import { campaigns, campaignSteps, campaignContacts } from '../db/schema/index.js';
import { NotFoundError, ValidationError } from '../utils/errors.js';

const createCampaignSchema = z.object({
  name: z.string().min(1).max(255),
  type: z.enum(['email', 'linkedin', 'multi_channel']).optional(),
  masterAgentId: z.string().uuid().optional(),
  config: z.record(z.unknown()).optional(),
  steps: z.array(z.object({
    stepNumber: z.number().int().min(1),
    subject: z.string().optional(),
    template: z.string().optional(),
    delayDays: z.number().int().min(0).default(0),
    channel: z.enum(['email', 'linkedin']).default('email'),
  })).optional(),
});

const updateCampaignSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  type: z.enum(['email', 'linkedin', 'multi_channel']).optional(),
  config: z.record(z.unknown()).optional(),
  status: z.enum(['draft', 'active', 'paused', 'completed']).optional(),
});

export default async function campaignRoutes(fastify: FastifyInstance) {
  fastify.addHook('onRequest', fastify.authenticate);

  // GET /api/campaigns
  fastify.get<{ Querystring: { cursor?: string; limit?: string; status?: string } }>(
    '/',
    async (request) => {
      const limit = Math.min(parseInt(request.query.limit || '20', 10), 100);
      const { cursor, status } = request.query;

      const results = await withTenant(request.tenantId, async (tx) => {
        const conditions = [eq(campaigns.tenantId, request.tenantId)];
        if (status) conditions.push(eq(campaigns.status, status as any));
        if (cursor) {
          try {
            const decoded = JSON.parse(Buffer.from(cursor, 'base64').toString());
            conditions.push(lt(campaigns.createdAt, new Date(decoded.createdAt)));
          } catch {
            throw new ValidationError('Invalid cursor');
          }
        }
        return tx.select().from(campaigns)
          .where(and(...conditions))
          .orderBy(desc(campaigns.createdAt))
          .limit(limit + 1);
      });

      const hasMore = results.length > limit;
      const data = hasMore ? results.slice(0, limit) : results;
      const nextCursor = hasMore && data.length > 0
        ? Buffer.from(JSON.stringify({
            createdAt: data[data.length - 1]!.createdAt.toISOString(),
            id: data[data.length - 1]!.id,
          })).toString('base64')
        : null;

      return { data, pagination: { hasMore, nextCursor } };
    },
  );

  // POST /api/campaigns
  fastify.post('/', async (request, reply) => {
    const parsed = createCampaignSchema.safeParse(request.body);
    if (!parsed.success) throw new ValidationError('Invalid input', parsed.error.flatten());

    const { steps, ...campaignData } = parsed.data;

    const [campaign] = await withTenant(request.tenantId, async (tx) => {
      const [c] = await tx.insert(campaigns).values({
        tenantId: request.tenantId,
        ...campaignData,
      }).returning();

      if (steps && steps.length > 0 && c) {
        await tx.insert(campaignSteps).values(
          steps.map((s) => ({ campaignId: c.id, ...s })),
        );
      }

      return [c];
    });

    return reply.status(201).send({ data: campaign });
  });

  // GET /api/campaigns/:id
  fastify.get<{ Params: { id: string } }>('/:id', async (request) => {
    const { id } = request.params;
    const result = await withTenant(request.tenantId, async (tx) => {
      const [campaign] = await tx.select().from(campaigns)
        .where(and(eq(campaigns.id, id), eq(campaigns.tenantId, request.tenantId)))
        .limit(1);
      if (!campaign) return null;

      const steps = await tx.select().from(campaignSteps)
        .where(eq(campaignSteps.campaignId, id));

      return { ...campaign, steps };
    });

    if (!result) throw new NotFoundError('Campaign', id);
    return { data: result };
  });

  // PATCH /api/campaigns/:id
  fastify.patch<{ Params: { id: string } }>('/:id', async (request) => {
    const { id } = request.params;
    const parsed = updateCampaignSchema.safeParse(request.body);
    if (!parsed.success) throw new ValidationError('Invalid input', parsed.error.flatten());

    const [campaign] = await withTenant(request.tenantId, async (tx) => {
      return tx.update(campaigns)
        .set({ ...parsed.data, updatedAt: new Date() })
        .where(and(eq(campaigns.id, id), eq(campaigns.tenantId, request.tenantId)))
        .returning();
    });
    if (!campaign) throw new NotFoundError('Campaign', id);
    return { data: campaign };
  });

  // DELETE /api/campaigns/:id
  fastify.delete<{ Params: { id: string } }>('/:id', async (request) => {
    const { id } = request.params;
    const result = await withTenant(request.tenantId, async (tx) => {
      return tx.delete(campaigns)
        .where(and(eq(campaigns.id, id), eq(campaigns.tenantId, request.tenantId)))
        .returning({ id: campaigns.id });
    });
    if (result.length === 0) throw new NotFoundError('Campaign', id);
    return { success: true };
  });

  // POST /api/campaigns/:id/start
  fastify.post<{ Params: { id: string } }>('/:id/start', async (request) => {
    const { id } = request.params;
    const [campaign] = await withTenant(request.tenantId, async (tx) => {
      return tx.update(campaigns)
        .set({ status: 'active', updatedAt: new Date() })
        .where(and(eq(campaigns.id, id), eq(campaigns.tenantId, request.tenantId)))
        .returning();
    });
    if (!campaign) throw new NotFoundError('Campaign', id);
    // In Prompt 2: dispatch outreach jobs for all campaign contacts
    return { data: campaign };
  });

  // POST /api/campaigns/:id/pause
  fastify.post<{ Params: { id: string } }>('/:id/pause', async (request) => {
    const { id } = request.params;
    const [campaign] = await withTenant(request.tenantId, async (tx) => {
      return tx.update(campaigns)
        .set({ status: 'paused', updatedAt: new Date() })
        .where(and(eq(campaigns.id, id), eq(campaigns.tenantId, request.tenantId)))
        .returning();
    });
    if (!campaign) throw new NotFoundError('Campaign', id);
    return { data: campaign };
  });

  // GET /api/campaigns/:id/analytics
  fastify.get<{ Params: { id: string } }>('/:id/analytics', async (request) => {
    const { id } = request.params;
    const result = await withTenant(request.tenantId, async (tx) => {
      const [campaign] = await tx.select().from(campaigns)
        .where(and(eq(campaigns.id, id), eq(campaigns.tenantId, request.tenantId)))
        .limit(1);
      if (!campaign) return null;

      const contactStats = await tx.select().from(campaignContacts)
        .where(eq(campaignContacts.campaignId, id));

      const statusCounts: Record<string, number> = {};
      for (const cc of contactStats) {
        statusCounts[cc.status] = (statusCounts[cc.status] || 0) + 1;
      }

      return {
        campaign: { id: campaign.id, name: campaign.name, status: campaign.status },
        stats: campaign.stats,
        contactBreakdown: statusCounts,
        totalContacts: contactStats.length,
      };
    });

    if (!result) throw new NotFoundError('Campaign', id);
    return { data: result };
  });
}
