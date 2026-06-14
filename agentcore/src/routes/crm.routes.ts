import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq, and, desc, asc, lt, sql } from 'drizzle-orm';
import { withTenant } from '../config/database.js';
import { crmStages, deals, crmActivities, contacts } from '../db/schema/index.js';
import { logActivity, ensureDeal, moveDealStage, seedDefaultStages, findStageBySlug } from '../services/crm-activity.service.js';
import { matchContacts } from '../services/contact-match.service.js';
import { extractJSON, SMART_MODEL } from '../tools/together-ai.tool.js';
import {
  buildCopilotActivitySystem,
  buildCopilotActivityUser,
  ACTIVITY_TYPES,
  type CopilotActivityDraft,
} from '../prompts/copilot-activity.prompt.js';
import { NotFoundError, ValidationError } from '../utils/errors.js';
import { getTenantCadence } from '../services/followup-cadence.service.js';
import { getTenantById, updateTenant } from '../services/tenant.service.js';
import { classifyStagesInBackground } from '../services/stage-classifier.service.js';
import { onDealStageChanged, setSequenceCadenceOverride } from '../services/followup-engine.service.js';
import logger from '../utils/logger.js';

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

const updateStageSchema = createStageSchema.partial().extend({
  followUpEligible: z.boolean().optional(),
});

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
  // Follow-up engine per-lead cadence override (null = tenant default).
  cadenceOverride: z.enum(['fast', 'mid', 'slow']).nullable().optional(),
});

// Activity types that imply a real contact touchpoint and should surface
// the contact on the kanban via ensureDeal. Notes and pure system events
// are excluded so the pipeline doesn't get spammed.
const QUALIFYING_TYPES = new Set<string>([
  'call_logged', 'meeting_scheduled',
  'manual_email_sent', 'manual_email_received',
  'linkedin_connection_sent', 'linkedin_connection_accepted',
  'linkedin_message_sent', 'linkedin_message_received', 'linkedin_followup_sent',
  'email_sent', 'email_replied', 'email_received',
]);

const createActivitySchema = z.object({
  contactId: z.string().uuid().optional(),
  dealId: z.string().uuid().optional(),
  type: z.enum([
    'email_sent', 'email_opened', 'email_replied', 'email_received', 'email_bounced',
    'stage_change', 'note_added', 'call_logged', 'meeting_scheduled',
    'status_change', 'score_updated', 'agent_action',
    'linkedin_connection_sent', 'linkedin_connection_accepted',
    'linkedin_message_sent', 'linkedin_message_received', 'linkedin_followup_sent',
    'manual_email_sent', 'manual_email_received',
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

    // Re-classify follow-up eligibility now that the pipeline changed.
    classifyStagesInBackground(request.tenantId);

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

    // An explicit followUpEligible edit pins the flag — the AI classifier
    // never overwrites a user decision. Won/lost stages are always ineligible.
    const updateData: Record<string, unknown> = { ...parsed.data, updatedAt: new Date() };
    if (parsed.data.followUpEligible !== undefined) {
      updateData.followUpClassifiedBy = 'user';
    }
    if (parsed.data.isWon || parsed.data.isLost) {
      updateData.followUpEligible = false;
    }

    const [before] = await withTenant(request.tenantId, async (tx) => {
      return tx.select({ name: crmStages.name, classifiedBy: crmStages.followUpClassifiedBy })
        .from(crmStages)
        .where(and(eq(crmStages.id, id), eq(crmStages.tenantId, request.tenantId)))
        .limit(1);
    });

    const [stage] = await withTenant(request.tenantId, async (tx) => {
      return tx.update(crmStages)
        .set(updateData)
        .where(and(eq(crmStages.id, id), eq(crmStages.tenantId, request.tenantId)))
        .returning();
    });
    if (!stage) throw new NotFoundError('CrmStage', id);

    // A rename changes the stage's meaning — re-classify (user-pinned stages
    // are skipped inside the classifier).
    if (parsed.data.name && before && before.name !== parsed.data.name && before.classifiedBy !== 'user') {
      classifyStagesInBackground(request.tenantId);
    }

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

  // ── Follow-up cadence (tenant-level strategy for the follow-up engine) ──────

  // GET /api/crm/followup-cadence
  fastify.get('/followup-cadence', async (request) => {
    const cadence = await getTenantCadence(request.tenantId);
    return { data: cadence };
  });

  // PUT /api/crm/followup-cadence
  fastify.put('/followup-cadence', async (request) => {
    const parsed = z.object({
      strategy: z.enum(['fast', 'mid', 'slow']),
      intervals: z.record(z.array(z.number().int().min(1).max(90)).min(1).max(6)).optional(),
    }).safeParse(request.body);
    if (!parsed.success) throw new ValidationError('Invalid input', parsed.error.flatten());

    // Read-merge-write: tenants.settings is a shared JSONB blob — never clobber
    // other keys (companyProfile, …).
    const tenant = await getTenantById(request.tenantId);
    const settings = (tenant.settings as Record<string, unknown>) ?? {};
    await updateTenant(request.tenantId, {
      settings: {
        ...settings,
        followupCadence: {
          ...(settings.followupCadence as Record<string, unknown> | undefined),
          strategy: parsed.data.strategy,
          ...(parsed.data.intervals ? { intervals: parsed.data.intervals } : {}),
        },
      },
    });
    return { data: await getTenantCadence(request.tenantId) };
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

    // Follow-up engine: a deal created directly into an eligible stage
    // starts its sequence.
    try {
      const [stage] = await withTenant(request.tenantId, async (tx) => {
        return tx.select().from(crmStages).where(eq(crmStages.id, parsed.data.stageId)).limit(1);
      });
      if (stage) await onDealStageChanged(request.tenantId, deal!.id, stage);
    } catch (err) {
      logger.warn({ err, dealId: deal!.id }, 'create deal: follow-up engine hook failed');
    }

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

    const { stageId, cadenceOverride, ...rest } = parsed.data;
    const updateData: Record<string, unknown> = { ...rest, updatedAt: new Date() };
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

    // Stage changes go through moveDealStage — the single chokepoint that
    // logs the activity AND drives the follow-up engine lifecycle.
    if (stageId && stageId !== deal.stageId) {
      await moveDealStage({
        tenantId: request.tenantId,
        dealId: id,
        newStageId: stageId,
        userId: request.userId,
      });
    }

    // Per-lead cadence override for the follow-up engine.
    if (cadenceOverride !== undefined) {
      await setSequenceCadenceOverride(request.tenantId, id, cadenceOverride);
    }

    const [fresh] = await withTenant(request.tenantId, async (tx) => {
      return tx.select().from(deals)
        .where(and(eq(deals.id, id), eq(deals.tenantId, request.tenantId)))
        .limit(1);
    });
    return { data: fresh ?? deal };
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

    // For touchpoint-style activities on a contact, surface the contact on
    // the kanban by ensuring a deal exists. ensureDeal is idempotent.
    if (parsed.data.contactId && QUALIFYING_TYPES.has(parsed.data.type)) {
      try {
        // Honor the copilot's suggested initial stage when present.
        let initialStageId: string | undefined;
        const stageSlug = (parsed.data.metadata?.suggestedStageSlug as string | undefined)?.trim();
        if (stageSlug) {
          const stage = await findStageBySlug(request.tenantId, stageSlug);
          initialStageId = stage?.id;
        }
        await ensureDeal({
          tenantId: request.tenantId,
          contactId: parsed.data.contactId,
          initialStageId,
        });
      } catch (err) {
        logger.warn({ err, contactId: parsed.data.contactId }, 'Failed to ensure deal for activity');
      }
    }

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

  // ── Copilot: parse free text + OCR'd image into a structured activity draft ──
  // POST /api/crm/copilot/parse-activity
  fastify.post('/copilot/parse-activity', async (request) => {
    const parsed = z.object({
      text: z.string().max(4000).optional(),
      ocrText: z.string().max(8000).optional(),
    }).safeParse(request.body);
    if (!parsed.success) throw new ValidationError('Invalid input', parsed.error.flatten());

    const { text = '', ocrText } = parsed.data;
    if (!text.trim() && !ocrText?.trim()) {
      throw new ValidationError('Provide either `text` or `ocrText`');
    }

    const system = buildCopilotActivitySystem();
    const user = buildCopilotActivityUser({ text, ocrText });

    let draft: CopilotActivityDraft;
    try {
      draft = await extractJSON<CopilotActivityDraft>(
        request.tenantId,
        [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        2,
        { model: SMART_MODEL, temperature: 0.2 },
      );
    } catch (err) {
      logger.warn({ err }, 'copilot parse-activity: LLM extract failed');
      throw new ValidationError('Could not parse the input. Try rephrasing.');
    }

    // Defensive: clamp the type to the allowed enum.
    if (!ACTIVITY_TYPES.includes(draft.type)) draft.type = 'note_added';
    if (!draft.title) draft.title = 'Activity';
    if (typeof draft.description !== 'string') draft.description = '';

    // Fuzzy-match candidate contacts.
    const candidates = await matchContacts({
      tenantId: request.tenantId,
      name: draft.contactName,
      email: draft.contactEmail,
      limit: 5,
    });

    return {
      data: {
        draft,
        candidates,
      },
    };
  });
}
