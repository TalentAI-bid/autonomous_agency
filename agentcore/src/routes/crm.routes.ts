import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq, and, desc, asc, lt, sql } from 'drizzle-orm';
import { withTenant } from '../config/database.js';
import { crmStages, deals, crmActivities, contacts } from '../db/schema/index.js';
import { logActivity, ensureDeal, moveDealStage, seedDefaultStages } from '../services/crm-activity.service.js';
import { NotFoundError, ValidationError } from '../utils/errors.js';

// --- Schemas ---
const createStageSchema = z.object({
  name: z.string().min(1).max(255),
  slug: z.string().min(1).max(255),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#6366f1'),
  position: z.number().min(0).default(0),
  isDefault: z.boolean().default(false),
  isWon: z.boolean().default(false),
  isLost: z.boolean().default(false),
});

const updateStageSchema = createStageSchema.partial();

const createDealSchema = z.object({
  contactId: z.string().uuid(),
  stageId: z.string().uuid(),
  masterAgentId: z.string().uuid().optional(),
  campaignId: z.string().uuid().optional(),
  title: z.string().min(1).max(500),
  value: z.string().optional(),
  currency: z.string().max(3).default('USD'),
  notes: z.string().optional(),
  expectedCloseAt: z.string().optional(),
});

const updateDealSchema = z.object({
  stageId: z.string().uuid().optional(),
  title: z.string().min(1).max(500).optional(),
  value: z.string().optional(),
  currency: z.string().max(3).optional(),
  notes: z.string().optional(),
  expectedCloseAt: z.string().optional(),
});

const createActivitySchema = z.object({
  contactId: z.string().uuid().optional(),
  dealId: z.string().uuid().optional(),
  type: z.enum([
    'email_sent', 'email_opened', 'email_replied', 'email_bounced',
    'stage_change', 'note_added', 'call_logged', 'meeting_scheduled',
    'status_change', 'score_updated', 'agent_action',
  ]),
  title: z.string().min(1).max(500),
  description: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});

export default async function crmRoutes(fastify: FastifyInstance) {
  fastify.addHook('onRequest', fastify.authenticate);

  // ── Stages ──────────────────────────────────────────────────────────────────

  // GET /api/crm/stages
  fastify.get('/stages', async (request) => {
    const results = await withTenant(request.tenantId, async (tx) => {
      return tx.select().from(crmStages)
        .where(eq(crmStages.tenantId, request.tenantId))
        .orderBy(asc(crmStages.position));
    });
    return { data: results };
  });

  // POST /api/crm/stages
  fastify.post('/stages', async (request, reply) => {
    const parsed = createStageSchema.safeParse(request.body);
    if (!parsed.success) throw new ValidationError('Invalid input', parsed.error.flatten());

    const [stage] = await withTenant(request.tenantId, async (tx) => {
      return tx.insert(crmStages).values({
        tenantId: request.tenantId,
        ...parsed.data,
      }).returning();
    });

    return reply.status(201).send({ data: stage });
  });

  // POST /api/crm/stages/seed
  fastify.post('/stages/seed', async (request) => {
    const stages = await seedDefaultStages(request.tenantId);
    return { data: stages };
  });

  // PATCH /api/crm/stages/:id
  fastify.patch<{ Params: { id: string } }>('/stages/:id', async (request) => {
    const { id } = request.params;
    const parsed = updateStageSchema.safeParse(request.body);
    if (!parsed.success) throw new ValidationError('Invalid input', parsed.error.flatten());

    const [stage] = await withTenant(request.tenantId, async (tx) => {
      return tx.update(crmStages)
        .set({ ...parsed.data, updatedAt: new Date() })
        .where(and(eq(crmStages.id, id), eq(crmStages.tenantId, request.tenantId)))
        .returning();
    });
    if (!stage) throw new NotFoundError('CrmStage', id);
    return { data: stage };
  });

  // DELETE /api/crm/stages/:id
  fastify.delete<{ Params: { id: string } }>('/stages/:id', async (request) => {
    const { id } = request.params;
    const result = await withTenant(request.tenantId, async (tx) => {
      return tx.delete(crmStages)
        .where(and(eq(crmStages.id, id), eq(crmStages.tenantId, request.tenantId)))
        .returning({ id: crmStages.id });
    });
    if (result.length === 0) throw new NotFoundError('CrmStage', id);
    return { success: true };
  });

  // ── Deals ───────────────────────────────────────────────────────────────────

  // GET /api/crm/deals (paginated)
  fastify.get('/deals', async (request) => {
    const query = request.query as { stageId?: string; contactId?: string; masterAgentId?: string; cursor?: string; limit?: string };
    const limit = Math.min(parseInt(query.limit || '20', 10), 100);

    const conditions = [eq(deals.tenantId, request.tenantId)];
    if (query.stageId) conditions.push(eq(deals.stageId, query.stageId));
    if (query.contactId) conditions.push(eq(deals.contactId, query.contactId));
    if (query.masterAgentId) conditions.push(eq(deals.masterAgentId, query.masterAgentId));
    if (query.cursor) {
      try {
        const decoded = JSON.parse(Buffer.from(query.cursor, 'base64').toString());
        conditions.push(lt(deals.createdAt, new Date(decoded.createdAt)));
      } catch { throw new ValidationError('Invalid cursor'); }
    }

    const results = await withTenant(request.tenantId, async (tx) => {
      return tx.select().from(deals)
        .where(and(...conditions))
        .orderBy(desc(deals.createdAt))
        .limit(limit + 1);
    });

    const hasMore = results.length > limit;
    const data = hasMore ? results.slice(0, limit) : results;
    const nextCursor = hasMore && data.length > 0
      ? Buffer.from(JSON.stringify({ createdAt: data[data.length - 1]!.createdAt.toISOString() })).toString('base64')
      : null;

    return { data, pagination: { hasMore, nextCursor } };
  });

  // POST /api/crm/deals
  fastify.post('/deals', async (request, reply) => {
    const parsed = createDealSchema.safeParse(request.body);
    if (!parsed.success) throw new ValidationError('Invalid input', parsed.error.flatten());

    const [deal] = await withTenant(request.tenantId, async (tx) => {
      return tx.insert(deals).values({
        tenantId: request.tenantId,
        ...parsed.data,
        expectedCloseAt: parsed.data.expectedCloseAt ? new Date(parsed.data.expectedCloseAt) : undefined,
      }).returning();
    });

    return reply.status(201).send({ data: deal });
  });

  // GET /api/crm/deals/:id
  fastify.get<{ Params: { id: string } }>('/deals/:id', async (request) => {
    const { id } = request.params;
    const [deal] = await withTenant(request.tenantId, async (tx) => {
      return tx.select().from(deals)
        .where(and(eq(deals.id, id), eq(deals.tenantId, request.tenantId)))
        .limit(1);
    });
    if (!deal) throw new NotFoundError('Deal', id);

    // Load contact info
    const [contact] = await withTenant(request.tenantId, async (tx) => {
      return tx.select().from(contacts)
        .where(eq(contacts.id, deal.contactId))
        .limit(1);
    });

    // Load stage info
    const [stage] = await withTenant(request.tenantId, async (tx) => {
      return tx.select().from(crmStages)
        .where(eq(crmStages.id, deal.stageId))
        .limit(1);
    });

    return { data: { ...deal, contact, stage } };
  });

  // PATCH /api/crm/deals/:id
  fastify.patch<{ Params: { id: string } }>('/deals/:id', async (request) => {
    const { id } = request.params;
    const parsed = updateDealSchema.safeParse(request.body);
    if (!parsed.success) throw new ValidationError('Invalid input', parsed.error.flatten());

    const updateData: Record<string, unknown> = { ...parsed.data, updatedAt: new Date() };
    if (parsed.data.expectedCloseAt) {
      updateData.expectedCloseAt = new Date(parsed.data.expectedCloseAt);
    }

    const [deal] = await withTenant(request.tenantId, async (tx) => {
      return tx.update(deals)
        .set(updateData)
        .where(and(eq(deals.id, id), eq(deals.tenantId, request.tenantId)))
        .returning();
    });
    if (!deal) throw new NotFoundError('Deal', id);
    return { data: deal };
  });

  // DELETE /api/crm/deals/:id
  fastify.delete<{ Params: { id: string } }>('/deals/:id', async (request) => {
    const { id } = request.params;
    const result = await withTenant(request.tenantId, async (tx) => {
      return tx.delete(deals)
        .where(and(eq(deals.id, id), eq(deals.tenantId, request.tenantId)))
        .returning({ id: deals.id });
    });
    if (result.length === 0) throw new NotFoundError('Deal', id);
    return { success: true };
  });

  // POST /api/crm/deals/:id/move
  fastify.post<{ Params: { id: string } }>('/deals/:id/move', async (request) => {
    const { id } = request.params;
    const body = request.body as { stageId: string };
    if (!body.stageId) throw new ValidationError('Missing stageId');

    await moveDealStage({
      tenantId: request.tenantId,
      dealId: id,
      newStageId: body.stageId,
      userId: request.userId,
    });

    return { success: true };
  });

  // ── Activities ──────────────────────────────────────────────────────────────

  // GET /api/crm/activities (paginated)
  fastify.get('/activities', async (request) => {
    const query = request.query as { contactId?: string; dealId?: string; type?: string; cursor?: string; limit?: string };
    const limit = Math.min(parseInt(query.limit ?? '20', 10), 100);

    const conditions = [eq(crmActivities.tenantId, request.tenantId)];
    if (query.contactId) conditions.push(eq(crmActivities.contactId, query.contactId));
    if (query.dealId) conditions.push(eq(crmActivities.dealId, query.dealId));
    if (query.type) conditions.push(eq(crmActivities.type, query.type as any));
    if (query.cursor) {
      try {
        const decoded = JSON.parse(Buffer.from(query.cursor, 'base64').toString());
        conditions.push(lt(crmActivities.occurredAt, new Date(decoded.occurredAt)));
      } catch { throw new ValidationError('Invalid cursor'); }
    }

    const results = await withTenant(request.tenantId, async (tx) => {
      return tx.select().from(crmActivities)
        .where(and(...conditions))
        .orderBy(desc(crmActivities.occurredAt))
        .limit(limit + 1);
    });

    const hasMore = results.length > limit;
    const data = hasMore ? results.slice(0, limit) : results;
    const nextCursor = hasMore && data.length > 0
      ? Buffer.from(JSON.stringify({ occurredAt: data[data.length - 1]!.occurredAt.toISOString() })).toString('base64')
      : null;

    return { data, pagination: { hasMore, nextCursor } };
  });

  // POST /api/crm/activities
  fastify.post('/activities', async (request, reply) => {
    const parsed = createActivitySchema.safeParse(request.body);
    if (!parsed.success) throw new ValidationError('Invalid input', parsed.error.flatten());

    const result = await logActivity({
      tenantId: request.tenantId,
      userId: request.userId,
      ...parsed.data,
    });

    return reply.status(201).send({ data: result });
  });

  // GET /api/crm/contacts/:contactId/timeline
  fastify.get<{ Params: { contactId: string } }>('/contacts/:contactId/timeline', async (request) => {
    const { contactId } = request.params;
    const results = await withTenant(request.tenantId, async (tx) => {
      return tx.select().from(crmActivities)
        .where(and(eq(crmActivities.tenantId, request.tenantId), eq(crmActivities.contactId, contactId)))
        .orderBy(desc(crmActivities.occurredAt))
        .limit(100);
    });
    return { data: results };
  });

  // GET /api/crm/board — Kanban board data
  fastify.get('/board', async (request) => {
    const stages = await withTenant(request.tenantId, async (tx) => {
      return tx.select().from(crmStages)
        .where(eq(crmStages.tenantId, request.tenantId))
        .orderBy(asc(crmStages.position));
    });

    // If no stages, seed defaults
    const effectiveStages = stages.length > 0 ? stages : await seedDefaultStages(request.tenantId);

    // Load all deals with contact info
    const allDeals = await withTenant(request.tenantId, async (tx) => {
      return tx.select({
        deal: deals,
        contactFirstName: contacts.firstName,
        contactLastName: contacts.lastName,
        contactEmail: contacts.email,
        contactTitle: contacts.title,
        contactCompanyName: contacts.companyName,
      })
        .from(deals)
        .leftJoin(contacts, eq(deals.contactId, contacts.id))
        .where(eq(deals.tenantId, request.tenantId))
        .orderBy(desc(deals.updatedAt));
    });

    // Group by stage
    const board = effectiveStages.map((stage) => ({
      ...stage,
      deals: allDeals
        .filter((d) => d.deal.stageId === stage.id)
        .map((d) => ({
          ...d.deal,
          contact: {
            firstName: d.contactFirstName,
            lastName: d.contactLastName,
            email: d.contactEmail,
            title: d.contactTitle,
            companyName: d.contactCompanyName,
          },
        })),
    }));

    return { data: board };
  });
}
