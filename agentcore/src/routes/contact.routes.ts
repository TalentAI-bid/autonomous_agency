import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq, and, desc, lt, ilike, sql } from 'drizzle-orm';
import { withTenant } from '../config/database.js';
import { contacts, companies, masterAgents, outreachEmails, emailsSent, emailAccounts, prospectStages, userTenants } from '../db/schema/index.js';
import type { EmailAccount } from '../db/schema/index.js';
import { AppError, NotFoundError, ValidationError } from '../utils/errors.js';
import { selectEmailAccount, incrementQuota } from '../tools/email-queue.tool.js';
import { sendEmail } from '../tools/smtp.tool.js';
import { acquireSmtpSlot } from '../services/smtp-rate-limiter.service.js';
import { draftColdEmail, type ColdEmailResult } from '../services/cold-email-drafter.service.js';
import { generateGmapsRecommendation } from '../services/gmaps-recommendation.service.js';
import { buildColdEmailSender } from '../services/messaging-config.service.js';
import { findEmailByPattern, verifyEmailManual } from '../tools/email-finder.tool.js';
import { wrapEmailBody, plainTextToHtml } from '../templates/email-template.js';
import { logActivity, ensureDeal } from '../services/crm-activity.service.js';
import { ensureDefaultCampaign, enrollContactInSequence } from '../services/followup.service.js';
import { logEvent, getContactTimeline } from '../services/timeline.service.js';
import { checkAndIncrementCapture } from '../services/capture-rate-limit.service.js';
import { recordTouch, recordResponse } from '../services/prospect-stage.service.js';
import logger from '../utils/logger.js';

// Sales Operations Platform — capture / lookup / timeline / management.
// Allowed source-type vocabulary on POST /api/contacts/capture. Free-text
// in the DB (so future surfaces can introduce values), but the dashboard
// + extension submit one of these.
const SOURCE_TYPES = [
  'ai_discovery',
  'manual_linkedin',
  'referral',
  'extension_capture',
  'imported_csv',
  'manual_other',
  'event',
  'inbound',
  'news_article',
] as const;

const captureSchema = z.object({
  name: z.string().trim().min(1).max(255).optional(),
  firstName: z.string().trim().max(255).optional(),
  lastName: z.string().trim().max(255).optional(),
  email: z.string().trim().email().max(320).optional(),
  linkedinUrl: z.string().trim().url().max(500).optional(),
  company: z.string().trim().max(255).optional(),
  title: z.string().trim().max(255).optional(),
  location: z.string().trim().max(255).optional(),
  phone: z.string().trim().max(64).optional(),
  whatsapp: z.string().trim().max(64).optional(),
  headline: z.string().trim().max(2000).optional(),
  about: z.string().trim().max(8000).optional(),
  sourceType: z.string().trim().max(64).optional(),
  sourceMetadata: z.record(z.unknown()).optional(),
  tags: z.array(z.string().trim().min(1).max(64)).max(50).optional(),
  initialNote: z.string().trim().max(8000).optional(),
});

/**
 * Normalize a LinkedIn URL for dedup / lookup. Strips query + hash,
 * trailing slash. Does NOT lowercase the path (LinkedIn handles are
 * case-insensitive but URL slugs are stored mixed-case by the rest of
 * the codebase, so preserving case keeps joins simple).
 */
function normalizeLinkedinUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const u = new URL(trimmed);
    let path = u.pathname.replace(/\/+$/, '');
    if (!path.startsWith('/')) path = '/' + path;
    return `${u.protocol}//${u.host}${path}`;
  } catch {
    return trimmed.replace(/\/+$/, '').split('?')[0]!.split('#')[0]!;
  }
}

function splitName(name: string | undefined, firstName: string | undefined, lastName: string | undefined): { firstName?: string; lastName?: string } {
  if (firstName || lastName) return { firstName, lastName };
  if (!name) return {};
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return { firstName: parts[0] };
  return { firstName: parts[0], lastName: parts.slice(1).join(' ') };
}

function computeNextTags(current: string[], add: string[], remove: string[]): string[] {
  const set = new Set(current);
  for (const t of add) set.add(t);
  for (const t of remove) set.delete(t);
  return Array.from(set);
}

// Defensive: convert any HTML the LLM might still emit back to plain text
// with sane line breaks. Used on /draft-email response so the dashboard
// textarea always shows clean prose.
function stripHtmlToPlainText(input: string): string {
  if (!input) return '';
  return input
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6])>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const createContactSchema = z.object({
  firstName: z.string().max(255).optional(),
  lastName: z.string().max(255).optional(),
  email: z.string().email().optional(),
  linkedinUrl: z.string().url().max(500).optional(),
  title: z.string().max(255).optional(),
  companyName: z.string().max(255).optional(),
  location: z.string().max(255).optional(),
  skills: z.array(z.string()).optional(),
  source: z.enum(['linkedin_search', 'linkedin_profile', 'cv_upload', 'manual', 'web_search']).optional(),
  status: z.enum(['discovered', 'enriched', 'scored', 'contacted', 'replied', 'qualified', 'interview_scheduled', 'rejected', 'archived']).optional(),
  // Required: contacts are always owned by an agent. UI is now scoped under
  // /agents/[agentId]/contacts/* — orphans would be unreachable from the dashboard.
  masterAgentId: z.string().uuid(),
});

const updateContactSchema = createContactSchema.partial();

const importContactsSchema = z.array(createContactSchema).min(1).max(1000);

export default async function contactRoutes(fastify: FastifyInstance) {
  fastify.addHook('onRequest', fastify.authenticate);

  // GET /api/contacts — Paginated list with filters
  // Sales Ops Stage 2: adds `stage`, `tag`, `sourceType` filters and joins
  // prospect_stages so each row carries currentStage in the response.
  fastify.get<{
    Querystring: {
      cursor?: string;
      limit?: string;
      status?: string;
      source?: string;
      sourceType?: string;
      stage?: string;
      tag?: string;
      search?: string;
      minScore?: string;
      maxScore?: string;
      masterAgentId?: string;
      companyId?: string;
    };
  }>('/', async (request) => {
    const limit = Math.min(parseInt(request.query.limit || '20', 10), 100);
    const {
      cursor, status, source, sourceType, stage, tag, search,
      minScore, maxScore, masterAgentId, companyId,
    } = request.query;

    const results = await withTenant(request.tenantId, async (tx) => {
      const conditions = [eq(contacts.tenantId, request.tenantId)];

      if (status) conditions.push(eq(contacts.status, status as any));
      if (source) conditions.push(eq(contacts.source, source as any));
      if (sourceType) conditions.push(eq(contacts.sourceType, sourceType));
      if (masterAgentId) conditions.push(eq(contacts.masterAgentId, masterAgentId));
      if (companyId) conditions.push(eq(contacts.companyId, companyId));
      if (minScore) conditions.push(sql`${contacts.score} >= ${parseInt(minScore, 10)}`);
      if (maxScore) conditions.push(sql`${contacts.score} <= ${parseInt(maxScore, 10)}`);
      if (tag) conditions.push(sql`${contacts.customTags} @> ARRAY[${tag}]::text[]`);
      if (stage) {
        conditions.push(sql`EXISTS (
          SELECT 1 FROM prospect_stages ps
          WHERE ps.contact_id = ${contacts.id} AND ps.current_stage = ${stage}
        )`);
      }
      if (search) {
        const pattern = '%' + search + '%';
        conditions.push(sql`(
          ${contacts.firstName} ILIKE ${pattern} OR
          ${contacts.lastName} ILIKE ${pattern} OR
          ${contacts.email} ILIKE ${pattern} OR
          ${contacts.companyName} ILIKE ${pattern} OR
          ${contacts.title} ILIKE ${pattern} OR
          ${contacts.headline} ILIKE ${pattern}
        )`);
      }
      if (cursor) {
        try {
          const decoded = JSON.parse(Buffer.from(cursor, 'base64').toString());
          conditions.push(lt(contacts.createdAt, new Date(decoded.createdAt)));
        } catch {
          throw new ValidationError('Invalid cursor format');
        }
      }

      return tx
        .select({
          contact: contacts,
          currentStage: prospectStages.currentStage,
          stageEnteredAt: prospectStages.stageEnteredAt,
          lastTouchAt: prospectStages.lastTouchAt,
          lastResponseAt: prospectStages.lastResponseAt,
          totalTouches: prospectStages.totalTouches,
        })
        .from(contacts)
        .leftJoin(prospectStages, eq(prospectStages.contactId, contacts.id))
        .where(and(...conditions))
        .orderBy(desc(contacts.createdAt))
        .limit(limit + 1);
    });

    const hasMore = results.length > limit;
    const page = hasMore ? results.slice(0, limit) : results;
    const data = page.map((r) => {
      // Drop the large gmaps HTML blobs from list rows — the list UI never reads
      // sourceMetadata, and reviewsHtml/aboutHtml can be tens of KB each. The
      // detail endpoint (GET /:id) still returns the full object.
      const sm = r.contact.sourceMetadata as Record<string, unknown> | null;
      const sourceMetadata = sm
        ? (() => { const { reviewsHtml, aboutHtml, ...rest } = sm; return rest; })()
        : sm;
      return {
        ...r.contact,
        sourceMetadata,
        currentStage: r.currentStage ?? null,
        stageEnteredAt: r.stageEnteredAt ?? null,
        lastTouchAt: r.lastTouchAt ?? null,
        lastResponseAt: r.lastResponseAt ?? null,
        totalTouches: r.totalTouches ?? 0,
      };
    });
    const nextCursor = hasMore && data.length > 0
      ? Buffer.from(JSON.stringify({
          createdAt: data[data.length - 1]!.createdAt.toISOString(),
          id: data[data.length - 1]!.id,
        })).toString('base64')
      : null;

    return { data, pagination: { hasMore, nextCursor, count: data.length } };
  });

  // GET /api/contacts/:id
  fastify.get<{ Params: { id: string } }>('/:id', async (request) => {
    const { id } = request.params;
    const [contact] = await withTenant(request.tenantId, async (tx) => {
      return tx.select().from(contacts)
        .where(and(eq(contacts.id, id), eq(contacts.tenantId, request.tenantId)))
        .limit(1);
    });
    if (!contact) throw new NotFoundError('Contact', id);

    // Sales Operations Stage 1: enrich the contact summary with current
    // pipeline stage + 5 most-recent timeline events so the dashboard
    // detail page (built in Stage 2) can land on one round-trip.
    const [stage] = await withTenant(request.tenantId, async (tx) => {
      return tx
        .select()
        .from(prospectStages)
        .where(eq(prospectStages.contactId, id))
        .limit(1);
    });
    let recentEvents: unknown[] = [];
    try {
      const page = await getContactTimeline({
        tenantId: request.tenantId,
        contactId: id,
        limit: 5,
      });
      recentEvents = page.events;
    } catch (err) {
      logger.warn({ err, contactId: id }, 'Failed to load recent events for contact summary');
    }

    return { data: { ...contact, prospectStage: stage ?? null, recentEvents } };
  });

  // POST /api/contacts
  fastify.post('/', async (request, reply) => {
    const parsed = createContactSchema.safeParse(request.body);
    if (!parsed.success) throw new ValidationError('Invalid input', parsed.error.flatten());

    const [contact] = await withTenant(request.tenantId, async (tx) => {
      return tx.insert(contacts).values({
        tenantId: request.tenantId,
        ...parsed.data,
      }).returning();
    });

    // Adding a lead = adding a card on the kanban. Idempotent.
    try {
      await ensureDeal({
        tenantId: request.tenantId,
        contactId: contact!.id,
        masterAgentId: parsed.data.masterAgentId,
      });
    } catch (err) {
      logger.warn({ err, contactId: contact!.id }, 'Failed to ensure deal for new contact');
    }

    return reply.status(201).send({ data: contact });
  });

  // PATCH /api/contacts/:id
  fastify.patch<{ Params: { id: string } }>('/:id', async (request) => {
    const { id } = request.params;
    const parsed = updateContactSchema.safeParse(request.body);
    if (!parsed.success) throw new ValidationError('Invalid input', parsed.error.flatten());

    // Capture prior status so we can fire response side-effects only on the
    // actual transition into 'replied' (manual "Mark as responded").
    const [prior] = await withTenant(request.tenantId, async (tx) => {
      return tx.select({ status: contacts.status }).from(contacts)
        .where(and(eq(contacts.id, id), eq(contacts.tenantId, request.tenantId)))
        .limit(1);
    });
    if (!prior) throw new NotFoundError('Contact', id);

    const [contact] = await withTenant(request.tenantId, async (tx) => {
      return tx.update(contacts)
        .set({ ...parsed.data, updatedAt: new Date() })
        .where(and(eq(contacts.id, id), eq(contacts.tenantId, request.tenantId)))
        .returning();
    });
    if (!contact) throw new NotFoundError('Contact', id);

    // On transition into 'replied', mirror to prospect stage (→ engaged,
    // lastResponseAt) and log a timeline event so the response is tracked.
    if (parsed.data.status === 'replied' && prior.status !== 'replied') {
      try {
        await recordResponse({ tenantId: request.tenantId, contactId: id });
        await logEvent({
          tenantId: request.tenantId,
          contactId: id,
          type: 'status_change',
          eventCategory: 'status_change',
          actorType: 'user',
          actorUserId: request.userId,
          title: 'Marked as responded',
          metadata: { from: prior.status, to: 'replied' },
        });
      } catch (err) {
        logger.warn({ err, contactId: id }, 'mark-responded side-effects failed (non-fatal)');
      }
    }

    return { data: contact };
  });

  // POST /api/contacts/:id/email/manual — User-typed email, Reacher-verified atomically
  fastify.post<{ Params: { id: string }; Body: { email: string } }>('/:id/email/manual', async (request, reply) => {
    const { id } = request.params;
    const parsed = z.object({ email: z.string().email().max(320) }).safeParse(request.body);
    if (!parsed.success) throw new ValidationError('Invalid input', parsed.error.flatten());
    const email = parsed.data.email.trim().toLowerCase();

    // 1. Load contact (tenant-scoped)
    const [existing] = await withTenant(request.tenantId, async (tx) => {
      return tx.select().from(contacts)
        .where(and(eq(contacts.id, id), eq(contacts.tenantId, request.tenantId)))
        .limit(1);
    });
    if (!existing) throw new NotFoundError('Contact', id);

    // 2. Verify against Reacher (1 daily slot)
    const verdict = await verifyEmailManual(email);
    if (!verdict.shouldSave) {
      // Reacher said the address is not deliverable — refuse to save it.
      return reply.status(400).send({
        error: 'Email rejected by verification',
        status: verdict.status,
      });
    }

    // 3. Persist with audit fields in rawData
    const prevRaw = (existing.rawData ?? {}) as Record<string, unknown>;
    const nextRaw = {
      ...prevRaw,
      emailSource: 'manual_entry',
      emailVerifyStatus: verdict.status,
      emailVerifiedAt: new Date().toISOString(),
    };

    const [updated] = await withTenant(request.tenantId, async (tx) => {
      return tx.update(contacts)
        .set({
          email,
          emailVerified: verdict.verified,
          rawData: nextRaw,
          updatedAt: new Date(),
        })
        .where(and(eq(contacts.id, id), eq(contacts.tenantId, request.tenantId)))
        .returning();
    });

    return { data: { contact: updated, status: verdict.status } };
  });

  // DELETE /api/contacts/:id
  fastify.delete<{ Params: { id: string } }>('/:id', async (request) => {
    const { id } = request.params;
    const result = await withTenant(request.tenantId, async (tx) => {
      return tx.delete(contacts)
        .where(and(eq(contacts.id, id), eq(contacts.tenantId, request.tenantId)))
        .returning({ id: contacts.id });
    });
    if (result.length === 0) throw new NotFoundError('Contact', id);
    return { success: true };
  });

  // POST /api/contacts/import — Bulk import
  fastify.post('/import', async (request, reply) => {
    const parsed = importContactsSchema.safeParse(request.body);
    if (!parsed.success) throw new ValidationError('Invalid input', parsed.error.flatten());

    const imported = await withTenant(request.tenantId, async (tx) => {
      return tx.insert(contacts)
        .values(parsed.data.map((c) => ({ tenantId: request.tenantId, ...c })))
        .returning();
    });

    return reply.status(201).send({ data: imported, count: imported.length });
  });

  // POST /api/contacts/:id/ai-recommendation — AI outreach recommendation for
  // a Google Maps local-business lead (persisted onto sourceMetadata).
  fastify.post<{ Params: { id: string } }>('/:id/ai-recommendation', async (request) => {
    const { id } = request.params;
    const [contact] = await withTenant(request.tenantId, async (tx) => {
      return tx.select({ id: contacts.id, sourceType: contacts.sourceType })
        .from(contacts)
        .where(and(eq(contacts.id, id), eq(contacts.tenantId, request.tenantId)))
        .limit(1);
    });
    if (!contact) throw new NotFoundError('Contact', id);
    if (contact.sourceType !== 'gmaps_business') {
      throw new ValidationError('AI recommendation is only available for Google Maps businesses');
    }
    const recommendation = await generateGmapsRecommendation(request.tenantId, id);
    return { data: recommendation };
  });

  // POST /api/contacts/:id/draft-email — AI-generated email draft
  fastify.post<{ Params: { id: string }; Body: { hint?: string } }>('/:id/draft-email', async (request) => {
    const { id } = request.params;
    const hint = (request.body as Record<string, unknown>)?.hint as string | undefined;

    // Load contact
    const [contact] = await withTenant(request.tenantId, async (tx) => {
      return tx.select().from(contacts)
        .where(and(eq(contacts.id, id), eq(contacts.tenantId, request.tenantId)))
        .limit(1);
    });
    if (!contact) throw new NotFoundError('Contact', id);

    // Load company if linked
    let company = null;
    if (contact.companyId) {
      const [c] = await withTenant(request.tenantId, async (tx) => {
        return tx.select().from(companies)
          .where(and(eq(companies.id, contact.companyId!), eq(companies.tenantId, request.tenantId)))
          .limit(1);
      });
      company = c ?? null;
    }

    // Single cold-email drafter (Kimi K2.5 on Bedrock). Builds the
    // {recipient, company, sender} triple the founder-voice prompt expects.
    const contactRaw = (contact.rawData ?? {}) as Record<string, unknown>;
    const companyRaw = (company?.rawData ?? {}) as Record<string, unknown>;

    const recipient = {
      firstName: contact.firstName ?? 'there',
      lastName: contact.lastName ?? undefined,
      title: contact.title ?? undefined,
      linkedinUrl: contact.linkedinUrl ?? undefined,
      location: contact.location ?? undefined,
      skills: (contact.skills as string[] | undefined) ?? (contactRaw.skills as string[] | undefined),
      summary: (contactRaw.summary as string) ?? undefined,
      seniorityLevel: (contactRaw.seniorityLevel as string) ?? undefined,
    };

    const companyCtx = company
      ? {
          name: company.name,
          domain: company.domain ?? undefined,
          industry: company.industry ?? undefined,
          size: company.size ?? undefined,
          techStack: (company.techStack as string[] | undefined) ?? undefined,
          funding: company.funding ?? undefined,
          description: company.description ?? undefined,
          recentNews: (companyRaw.recentNews as string[]) ?? undefined,
          headquarters: (companyRaw.headquarters as string) ?? undefined,
          keyPeople: (companyRaw.keyPeople as Array<{ name: string; title: string }>) ?? undefined,
          openRoles:
            (companyRaw.openPositions as Array<{ title: string; salary?: string; location?: string }> | undefined)
            ?? (companyRaw.jobListings as Array<{ title: string }> | undefined)
            ?? undefined,
        }
      : { name: contact.companyName ?? undefined };

    // Sender identity comes from the workspace this contact belongs to
    // (request.tenantId) — its Company Profile + Products — NOT per-agent
    // config. Fails loud if the workspace hasn't configured messaging.
    const sender = await buildColdEmailSender(request.tenantId);

    logger.info({
      contactId: id,
      contactName: `${contact.firstName ?? ''} ${contact.lastName ?? ''}`.trim(),
      companyName: company?.name,
    }, 'draft-email: starting cold-email LLM call');

    const result: ColdEmailResult = await draftColdEmail(
      request.tenantId,
      { recipient, company: companyCtx, sender },
      { hint },
    );

    logger.info({
      contactId: id,
      track: result.track,
      classification: result.classification,
      subject: result.subject.slice(0, 80),
      patternUsed: result.patternUsed,
      hookSource: result.hookSource,
      differentiator: result.differentiator,
      partnershipAngle: result.partnershipAngle,
      collaborationAngle: result.collaborationAngle,
      needsReview: result.meta.needsReview,
      model: result.meta.model,
    }, 'draft-email: drafted');

    // Server-side warning text the dashboard banner renders verbatim.
    const warningMessage =
      result.classification === 'DIRECT_COMPETITOR'
        ? 'This company is a direct competitor — partnership email generated. Always requires manual review before send.'
        : result.classification === 'ADJACENT_PARTNER'
          ? 'This company is an adjacent partner — collaboration email generated proposing mutual value.'
          : result.classification === 'WRONG_FIT'
            ? `Skipped: ${result.skipReason ?? 'classified as wrong fit'}`
            : undefined;

    // Defensive: even though the prompt asks for plain text, the model may
    // still emit <p>/<br>/<strong> tags. Strip HTML server-side. Conversion
    // back to HTML happens at send time below. SKIP track has empty subject
    // + body, so the strip is a no-op there.
    const data = {
      subject: result.subject.replace(/<[^>]+>/g, '').trim(),
      body: stripHtmlToPlainText(result.body),
      track: result.track,
      classification: result.classification,
      partnershipAngle: result.partnershipAngle,
      collaborationAngle: result.collaborationAngle,
      proposedExchange: result.proposedExchange,
      skipReason: result.skipReason,
      warningMessage,
    };

    return { data };
  });

  // POST /api/contacts/:id/send-email — Send email via configured SMTP
  fastify.post<{ Params: { id: string }; Body: {
    subject: string;
    body: string;
    track?: string;
    classification?: string;
    partnershipAngle?: string;
    collaborationAngle?: string;
    proposedExchange?: string;
  } }>('/:id/send-email', async (request) => {
    const { id } = request.params;
    const reqBody = request.body as {
      subject: string;
      body: string;
      track?: string;
      classification?: string;
      partnershipAngle?: string;
      collaborationAngle?: string;
      proposedExchange?: string;
    };
    const { subject, body } = reqBody;

    if (!subject || !body) throw new ValidationError('subject and body are required');

    // Load contact
    const [contact] = await withTenant(request.tenantId, async (tx) => {
      return tx.select().from(contacts)
        .where(and(eq(contacts.id, id), eq(contacts.tenantId, request.tenantId)))
        .limit(1);
    });
    if (!contact) throw new NotFoundError('Contact', id);
    if (!contact.email) throw new ValidationError('Contact has no email address');

    // Resolve the owning agent: direct (contact.master_agent_id) → indirect
    // (contact.company → companies.master_agent_id). Most contacts in this
    // codebase carry the agent only via the company, so the indirect hop is
    // necessary; without it the per-agent outbound-email setting silently
    // never applies.
    let resolvedAgentId: string | null = contact.masterAgentId ?? null;
    if (!resolvedAgentId && contact.companyId) {
      const [co] = await withTenant(request.tenantId, async (tx) => {
        return tx
          .select({ masterAgentId: companies.masterAgentId })
          .from(companies)
          .where(and(
            eq(companies.id, contact.companyId!),
            eq(companies.tenantId, request.tenantId),
          ))
          .limit(1);
      });
      resolvedAgentId = co?.masterAgentId ?? null;
    }

    let account: EmailAccount | null = null;
    if (resolvedAgentId) {
      const [agent] = await withTenant(request.tenantId, async (tx) => {
        return tx
          .select({ config: masterAgents.config })
          .from(masterAgents)
          .where(and(
            eq(masterAgents.id, resolvedAgentId!),
            eq(masterAgents.tenantId, request.tenantId),
          ))
          .limit(1);
      });
      const configuredId = (agent?.config as Record<string, unknown> | undefined)
        ?.emailAccountId as string | undefined;
      if (configuredId) {
        const [acc] = await withTenant(request.tenantId, async (tx) => {
          return tx
            .select()
            .from(emailAccounts)
            .where(and(
              eq(emailAccounts.id, configuredId),
              eq(emailAccounts.tenantId, request.tenantId),
              eq(emailAccounts.isActive, true),
            ))
            .limit(1);
        });
        if (acc) account = acc;
      }
    }

    if (!account) {
      account = await selectEmailAccount(request.tenantId);
    }
    if (!account) {
      throw new ValidationError('No email account configured. Go to Settings > Email to add one.');
    }

    // Server-wide SMTP throttle (Contabo cap = 25/min)
    await acquireSmtpSlot();

    // Build a minimal Gmail-style HTML body from the LLM's plain text.
    // The LLM is instructed to return PLAIN TEXT only (no HTML), so we
    // convert paragraphs to <p>/<br> here and pass the original text as
    // the multipart text/plain part. No trackingId / unsubscribeUrl on
    // 1:1 manual sends — those look more personal without the marketing
    // unsubscribe footer, and the recipient can just reply to opt out.
    const accountConfig = (account.config as Record<string, unknown> | undefined) ?? {};
    const htmlBody = wrapEmailBody({
      body: plainTextToHtml(body),
      senderName: account.fromName ?? (accountConfig.senderFirstName as string | undefined),
      senderTitle: accountConfig.senderTitle as string | undefined,
      senderCompany: accountConfig.senderCompany as string | undefined,
      senderWebsite: accountConfig.senderWebsite as string | undefined,
    });

    const result = await sendEmail({
      tenantId: request.tenantId,
      from: account.fromEmail,
      to: contact.email,
      subject,
      html: htmlBody,
      text: body,
      emailAccount: account,
    });

    // Increment quota
    await incrementQuota(request.tenantId, account.id);

    // Save to outreach_emails. v4 classification fields come from the
    // dashboard's send payload when the draft was generated by Kimi; for
    // legacy callers they're undefined and the columns stay NULL.
    const [saved] = await withTenant(request.tenantId, async (tx) => {
      return tx.insert(outreachEmails).values({
        tenantId: request.tenantId,
        contactId: id,
        masterAgentId: contact.masterAgentId ?? undefined,
        subject,
        body,
        messageId: result.messageId,
        status: 'sent',
        track: reqBody.track,
        classification: reqBody.classification,
        partnershipAngle: reqBody.partnershipAngle,
        collaborationAngle: reqBody.collaborationAngle,
        proposedExchange: reqBody.proposedExchange,
        sentAt: new Date(),
      }).returning();
    });

    // Update contact status to 'contacted' if still in earlier stage
    const earlyStatuses = ['discovered', 'enriched', 'scored'];
    if (earlyStatuses.includes(contact.status)) {
      await withTenant(request.tenantId, async (tx) => {
        await tx.update(contacts)
          .set({ status: 'contacted', updatedAt: new Date() })
          .where(eq(contacts.id, id));
      });
    }

    try {
      await recordTouch({
        tenantId: request.tenantId,
        contactId: id,
        channel: 'email',
        actorUserId: request.userId,
      });
    } catch (err) {
      logger.warn({ err, contactId: id }, 'recordTouch failed after manual email send');
    }

    // Mirror the send to the CRM activity timeline so the contact's
    // history shows the outbound email. The auto-outreach path logs the
    // same event via outreach.agent.ts; this closes the gap for manual
    // sends from the Compose Email modal.
    try {
      await logActivity({
        tenantId: request.tenantId,
        contactId: id,
        masterAgentId: contact.masterAgentId ?? undefined,
        type: 'email_sent',
        title: `Email sent: ${subject}`,
        metadata: {
          toEmail: contact.email,
          fromEmail: account.fromEmail,
          messageId: result.messageId,
          manual: true,
          outreachEmailId: saved!.id,
        },
      });
    } catch (err) {
      logger.warn({ err, contactId: id }, 'Failed to log manual email_sent activity');
    }

    // Surface the contact on the kanban: ensure a deal exists. Idempotent;
    // returns the existing deal if any so we don't create duplicates.
    try {
      await ensureDeal({
        tenantId: request.tenantId,
        contactId: id,
        masterAgentId: contact.masterAgentId ?? undefined,
      });
    } catch (err) {
      logger.warn({ err, contactId: id }, 'Failed to ensure deal after manual email send');
    }

    // Follow-up sequence enrollment. The manual /send-email path writes to
    // outreach_emails (above) but follow-ups read from emails_sent — so we
    // also persist a touch-1 row in emails_sent linked to the campaign_contact
    // we're about to create. Failure here is logged but non-fatal: the
    // initial email is already in flight.
    if (contact.masterAgentId) {
      try {
        const followupCampaignId = await ensureDefaultCampaign(request.tenantId, contact.masterAgentId);
        const enrolled = await enrollContactInSequence({
          tenantId: request.tenantId,
          campaignId: followupCampaignId,
          contactId: id,
          touch1Angle: 'manual_send',
          touch1SentAt: new Date(),
        });
        if (enrolled) {
          await withTenant(request.tenantId, async (tx) => {
            await tx.insert(emailsSent).values({
              campaignContactId: enrolled.id,
              fromEmail: account.fromEmail,
              toEmail: contact.email!,
              subject,
              body,
              sentAt: new Date(),
              messageId: result.messageId,
              touchNumber: 1,
            });
          });
        }
      } catch (err) {
        logger.warn({ err, contactId: id }, 'Failed to enroll contact in follow-up sequence (non-fatal)');
      }
    }

    logger.info({ tenantId: request.tenantId, contactId: id, messageId: result.messageId }, 'Outreach email sent');

    return { data: { success: true, messageId: result.messageId, outreachEmailId: saved!.id } };
  });

  // POST /api/contacts/:id/find-email — Manual fallback: pattern-guess + Reacher
  // verification. The auto pipeline also runs this via enrichment, but the button
  // lets the user trigger it on demand for a specific contact.
  fastify.post<{ Params: { id: string } }>('/:id/find-email', async (request) => {
    const { id } = request.params;

    const [contact] = await withTenant(request.tenantId, async (tx) => {
      return tx.select().from(contacts)
        .where(and(eq(contacts.id, id), eq(contacts.tenantId, request.tenantId)))
        .limit(1);
    });
    if (!contact) throw new NotFoundError('Contact', id);

    if (contact.email) {
      return {
        data: {
          email: contact.email,
          verified: contact.emailVerified,
          method: 'already_set',
          attempts: 0,
        },
      };
    }

    if (!contact.firstName || !contact.lastName) {
      throw new ValidationError('Contact is missing firstName or lastName');
    }

    let domain: string | null = null;
    if (contact.companyId) {
      const [company] = await withTenant(request.tenantId, async (tx) => {
        return tx.select({ domain: companies.domain }).from(companies)
          .where(and(eq(companies.id, contact.companyId!), eq(companies.tenantId, request.tenantId)))
          .limit(1);
      });
      domain = company?.domain ?? null;
    }

    if (!domain) {
      throw new ValidationError('Cannot find email: linked company has no domain yet');
    }

    const result = await findEmailByPattern(contact.firstName, contact.lastName, domain);
    const verified = result.email != null && (result.method === 'smtp_verified' || result.method === 'cached_pattern');

    if (result.email) {
      await withTenant(request.tenantId, async (tx) => {
        await tx.update(contacts)
          .set({ email: result.email!, emailVerified: verified, updatedAt: new Date() })
          .where(and(eq(contacts.id, id), eq(contacts.tenantId, request.tenantId)));
      });
      logger.info(
        { contactId: id, email: result.email, method: result.method, attempts: result.attempts },
        'Manual find-email: pattern match persisted',
      );
    } else {
      logger.info(
        { contactId: id, method: result.method, attempts: result.attempts, domain },
        'Manual find-email: no match',
      );
    }

    return {
      data: {
        email: result.email,
        verified,
        method: result.method,
        attempts: result.attempts,
      },
    };
  });

  // GET /api/contacts/:id/outreach-emails — List outreach emails for a contact
  fastify.get<{ Params: { id: string } }>('/:id/outreach-emails', async (request) => {
    const { id } = request.params;
    const emails = await withTenant(request.tenantId, async (tx) => {
      return tx.select().from(outreachEmails)
        .where(and(eq(outreachEmails.contactId, id), eq(outreachEmails.tenantId, request.tenantId)))
        .orderBy(desc(outreachEmails.createdAt));
    });
    return { data: emails };
  });

  // ─── Sales Operations Platform — Stage 1 ──────────────────────────────────
  // The manual-capture + lookup + timeline + management endpoints. All
  // tenant-scoped via the existing authenticate hook + withTenant.

  // GET /api/contacts/lookup?linkedinUrl=... — extension status-badge query.
  // Returns whether a contact already exists for the given LinkedIn URL.
  // Email-only lookup is intentionally not supported here (the extension
  // doesn't have the email; the dashboard form does its own dedup via capture).
  fastify.get<{ Querystring: { linkedinUrl?: string; email?: string } }>('/lookup', async (request) => {
    const { linkedinUrl: rawLinkedinUrl, email: rawEmail } = request.query;
    if (!rawLinkedinUrl && !rawEmail) {
      throw new ValidationError('linkedinUrl or email is required');
    }
    const normLinkedinUrl = normalizeLinkedinUrl(rawLinkedinUrl);
    const normEmail = rawEmail ? rawEmail.trim().toLowerCase() : null;

    const [match] = await withTenant(request.tenantId, async (tx) => {
      const conditions = [eq(contacts.tenantId, request.tenantId)];
      if (normLinkedinUrl && normEmail) {
        conditions.push(sql`(${contacts.linkedinUrl} = ${normLinkedinUrl} OR LOWER(${contacts.email}) = ${normEmail})`);
      } else if (normLinkedinUrl) {
        conditions.push(eq(contacts.linkedinUrl, normLinkedinUrl));
      } else if (normEmail) {
        conditions.push(sql`LOWER(${contacts.email}) = ${normEmail}`);
      }
      return tx
        .select({
          id: contacts.id,
          firstName: contacts.firstName,
          lastName: contacts.lastName,
          companyName: contacts.companyName,
        })
        .from(contacts)
        .where(and(...conditions))
        .limit(1);
    });

    if (!match) return { data: { exists: false } };

    // Resolve current_stage from prospect_stages — best-effort. Falls back
    // to null if the row hasn't been seeded yet (migration backfills cover
    // legacy contacts; new code seeds in capture path).
    const [stage] = await withTenant(request.tenantId, async (tx) => {
      return tx
        .select({ currentStage: prospectStages.currentStage })
        .from(prospectStages)
        .where(eq(prospectStages.contactId, match.id))
        .limit(1);
    });

    return {
      data: {
        exists: true,
        contactId: match.id,
        firstName: match.firstName,
        lastName: match.lastName,
        companyName: match.companyName,
        currentStage: stage?.currentStage ?? null,
      },
    };
  });

  // POST /api/contacts/capture — manual contact creation from dashboard form
  // or extension. Dedupes by (tenant_id, lower(email)) OR (tenant_id, linkedin_url)
  // and seeds prospect_stages + timeline event.
  fastify.post('/capture', async (request, reply) => {
    const parsed = captureSchema.safeParse(request.body);
    if (!parsed.success) throw new ValidationError('Invalid capture input', parsed.error.flatten());
    const input = parsed.data;
    if (!input.name && !input.firstName && !input.lastName) {
      throw new ValidationError('name (or firstName/lastName) is required');
    }
    const userId = request.userId;
    if (!userId) throw new ValidationError('User context required');

    const verdict = await checkAndIncrementCapture(userId);
    if (!verdict.allowed) {
      throw new AppError(
        `Daily capture limit reached (${verdict.limit}/day). Try again tomorrow.`,
        429,
        'CAPTURE_RATE_LIMIT',
        { limit: verdict.limit, remaining: 0 },
      );
    }

    const normLinkedinUrl = normalizeLinkedinUrl(input.linkedinUrl);
    const normEmail = input.email ? input.email.trim().toLowerCase() : null;
    const sourceType = input.sourceType ?? 'manual_other';
    // Light validation against the canonical vocabulary — but allow custom
    // values too. UI dropdowns will only emit the supported list.
    if (!SOURCE_TYPES.includes(sourceType as (typeof SOURCE_TYPES)[number])) {
      logger.info({ sourceType, userId }, 'capture: non-canonical sourceType accepted');
    }
    const { firstName, lastName } = splitName(input.name, input.firstName, input.lastName);

    return withTenant(request.tenantId, async (tx) => {
      // 1. Dedup lookup
      let existing: { id: string; currentStage: string | null } | null = null;
      if (normLinkedinUrl || normEmail) {
        const conds = [eq(contacts.tenantId, request.tenantId)];
        if (normLinkedinUrl && normEmail) {
          conds.push(sql`(${contacts.linkedinUrl} = ${normLinkedinUrl} OR LOWER(${contacts.email}) = ${normEmail})`);
        } else if (normLinkedinUrl) {
          conds.push(eq(contacts.linkedinUrl, normLinkedinUrl));
        } else if (normEmail) {
          conds.push(sql`LOWER(${contacts.email}) = ${normEmail}`);
        }
        const dupRows = await tx
          .select({ id: contacts.id, currentStage: prospectStages.currentStage })
          .from(contacts)
          .leftJoin(prospectStages, eq(prospectStages.contactId, contacts.id))
          .where(and(...conds))
          .limit(1);
        if (dupRows[0]) existing = { id: dupRows[0].id, currentStage: dupRows[0].currentStage ?? null };
      }

      if (existing) {
        // Best-effort: log a duplicate_capture_attempted event so the
        // contact's history shows the user tried to re-add them.
        try {
          await logEvent({
            tenantId: request.tenantId,
            contactId: existing.id,
            type: 'duplicate_capture_attempted',
            eventCategory: 'system_action',
            actorType: 'user',
            actorUserId: userId,
            title: 'Duplicate capture attempted',
            metadata: {
              attemptedEmail: normEmail,
              attemptedLinkedinUrl: normLinkedinUrl,
              sourceType,
              sourceMetadata: input.sourceMetadata,
            },
          });
        } catch (err) {
          logger.warn({ err, contactId: existing.id }, 'Failed to log duplicate_capture_attempted');
        }
        return reply.send({
          data: {
            contactId: existing.id,
            isDuplicate: true,
            existingStage: existing.currentStage,
          },
        });
      }

      // 2. Insert. Catch unique-violation as race-condition fallback.
      let insertedId: string;
      try {
        const [row] = await tx
          .insert(contacts)
          .values({
            tenantId: request.tenantId,
            firstName: firstName || undefined,
            lastName: lastName || undefined,
            email: normEmail || undefined,
            linkedinUrl: normLinkedinUrl || undefined,
            title: input.title || undefined,
            companyName: input.company || undefined,
            location: input.location || undefined,
            phone: input.phone || undefined,
            whatsapp: input.whatsapp || undefined,
            headline: input.headline || undefined,
            about: input.about || undefined,
            // Legacy enum value — keep populated so any code still reading
            // contacts.source sees a sane value. 'manual' is the closest
            // existing enum to the new manual_* vocabulary.
            source: 'manual',
            sourceType,
            sourceMetadata: input.sourceMetadata ?? {},
            customTags: input.tags ?? [],
            createdByUserId: userId,
            status: 'discovered',
          })
          .returning({ id: contacts.id });
        insertedId = row!.id;
      } catch (err) {
        // Race: another concurrent capture won. Re-run dedup lookup.
        const msg = err instanceof Error ? err.message : String(err);
        const isUnique = /duplicate key value|unique constraint|contacts_tenant_email_unique|contacts_tenant_linkedin_unique/i.test(msg);
        if (!isUnique) throw err;
        const dupRows = await tx
          .select({ id: contacts.id, currentStage: prospectStages.currentStage })
          .from(contacts)
          .leftJoin(prospectStages, eq(prospectStages.contactId, contacts.id))
          .where(
            and(
              eq(contacts.tenantId, request.tenantId),
              sql`(${contacts.linkedinUrl} = ${normLinkedinUrl ?? null} OR LOWER(${contacts.email}) = ${normEmail ?? null})`,
            ),
          )
          .limit(1);
        if (!dupRows[0]) throw err;
        return reply.send({
          data: {
            contactId: dupRows[0].id,
            isDuplicate: true,
            existingStage: dupRows[0].currentStage ?? null,
          },
        });
      }

      // 3. Seed prospect_stages.
      try {
        await tx
          .insert(prospectStages)
          .values({
            contactId: insertedId,
            tenantId: request.tenantId,
            currentStage: 'new',
          })
          .onConflictDoNothing();
      } catch (err) {
        logger.warn({ err, contactId: insertedId }, 'Failed to seed prospect_stages on capture');
      }

      // 4-6. Timeline events (contact_added, note_added, contact_tagged).
      try {
        await logEvent({
          tenantId: request.tenantId,
          contactId: insertedId,
          type: 'contact_added',
          eventCategory: 'discovery',
          actorType: 'user',
          actorUserId: userId,
          title: 'Contact added manually',
          metadata: {
            sourceType,
            sourceMetadata: input.sourceMetadata,
          },
        });
      } catch (err) {
        logger.warn({ err, contactId: insertedId }, 'Failed to log contact_added event');
      }

      if (input.initialNote) {
        try {
          await logEvent({
            tenantId: request.tenantId,
            contactId: insertedId,
            type: 'note_added',
            eventCategory: 'manual_note',
            actorType: 'user',
            actorUserId: userId,
            title: 'Note added at capture',
            description: input.initialNote,
          });
        } catch (err) {
          logger.warn({ err, contactId: insertedId }, 'Failed to log initial note');
        }
      }

      if (input.tags && input.tags.length > 0) {
        try {
          await logEvent({
            tenantId: request.tenantId,
            contactId: insertedId,
            type: 'contact_tagged',
            eventCategory: 'system_action',
            actorType: 'user',
            actorUserId: userId,
            title: `Tagged: ${input.tags.join(', ')}`,
            metadata: { tagsAdded: input.tags },
          });
        } catch (err) {
          logger.warn({ err, contactId: insertedId }, 'Failed to log contact_tagged event');
        }
      }

      return reply.status(201).send({
        data: { contactId: insertedId, isDuplicate: false },
      });
    });
  });

  // GET /api/contacts/:id/timeline — paginated event feed
  fastify.get<{ Params: { id: string }; Querystring: { cursor?: string; limit?: string; category?: string } }>(
    '/:id/timeline',
    async (request) => {
      const { id } = request.params;
      const limit = Math.min(Math.max(parseInt(request.query.limit ?? '25', 10) || 25, 1), 100);
      const category = request.query.category as
        | 'outreach' | 'response' | 'discovery' | 'status_change' | 'manual_note' | 'meeting' | 'system_action'
        | undefined;

      // Confirm the contact belongs to this tenant before reading its
      // timeline — defense in depth on top of withTenant's RLS scope.
      const [contact] = await withTenant(request.tenantId, async (tx) => {
        return tx.select({ id: contacts.id }).from(contacts)
          .where(and(eq(contacts.id, id), eq(contacts.tenantId, request.tenantId)))
          .limit(1);
      });
      if (!contact) throw new NotFoundError('Contact', id);

      const page = await getContactTimeline({
        tenantId: request.tenantId,
        contactId: id,
        cursor: request.query.cursor,
        limit,
        category,
      });

      return {
        data: page.events,
        pagination: { hasMore: page.hasMore, nextCursor: page.nextCursor, count: page.events.length },
      };
    },
  );

  // POST /api/contacts/:id/notes — append a note + timeline event
  fastify.post<{ Params: { id: string }; Body: { body: string } }>(
    '/:id/notes',
    async (request) => {
      const { id } = request.params;
      const parsed = z.object({ body: z.string().trim().min(1).max(8000) }).safeParse(request.body);
      if (!parsed.success) throw new ValidationError('Invalid input', parsed.error.flatten());

      const [contact] = await withTenant(request.tenantId, async (tx) => {
        return tx.select({ id: contacts.id }).from(contacts)
          .where(and(eq(contacts.id, id), eq(contacts.tenantId, request.tenantId)))
          .limit(1);
      });
      if (!contact) throw new NotFoundError('Contact', id);

      const event = await logEvent({
        tenantId: request.tenantId,
        contactId: id,
        type: 'note_added',
        eventCategory: 'manual_note',
        actorType: 'user',
        actorUserId: request.userId,
        title: 'Note added',
        description: parsed.data.body,
      });
      return { data: { eventId: event.id } };
    },
  );

  // POST /api/contacts/:id/dnc — mark do-not-contact
  fastify.post<{ Params: { id: string }; Body: { reason?: string } }>(
    '/:id/dnc',
    async (request) => {
      const { id } = request.params;
      const parsed = z.object({ reason: z.string().trim().max(2000).optional() }).safeParse(request.body ?? {});
      if (!parsed.success) throw new ValidationError('Invalid input', parsed.error.flatten());
      const reason = parsed.data.reason;

      const updated = await withTenant(request.tenantId, async (tx) => {
        const [c] = await tx.update(contacts)
          .set({
            doNotContact: true,
            doNotContactReason: reason,
            doNotContactAt: new Date(),
            updatedAt: new Date(),
          })
          .where(and(eq(contacts.id, id), eq(contacts.tenantId, request.tenantId)))
          .returning();
        if (!c) return null;
        await tx.update(prospectStages)
          .set({ currentStage: 'dnc', stageEnteredAt: new Date(), updatedAt: new Date() })
          .where(eq(prospectStages.contactId, id));
        return c;
      });
      if (!updated) throw new NotFoundError('Contact', id);

      try {
        await logEvent({
          tenantId: request.tenantId,
          contactId: id,
          type: 'contact_marked_dnc',
          eventCategory: 'status_change',
          actorType: 'user',
          actorUserId: request.userId,
          title: 'Marked do-not-contact',
          description: reason,
          metadata: { reason },
        });
      } catch (err) {
        logger.warn({ err, contactId: id }, 'Failed to log contact_marked_dnc');
      }
      try {
        await logEvent({
          tenantId: request.tenantId,
          contactId: id,
          type: 'stage_change',
          eventCategory: 'status_change',
          actorType: 'user',
          actorUserId: request.userId,
          title: 'Stage changed to dnc',
          metadata: { to: 'dnc', reason },
        });
      } catch (err) {
        logger.warn({ err, contactId: id }, 'Failed to log stage_change to dnc');
      }
      return { data: { contactId: id, doNotContact: true, currentStage: 'dnc' } };
    },
  );

  // POST /api/contacts/:id/tags — add/remove tags atomically
  fastify.post<{ Params: { id: string }; Body: { add?: string[]; remove?: string[] } }>(
    '/:id/tags',
    async (request) => {
      const { id } = request.params;
      const parsed = z
        .object({
          add: z.array(z.string().trim().min(1).max(64)).max(50).optional(),
          remove: z.array(z.string().trim().min(1).max(64)).max(50).optional(),
        })
        .refine((v) => (v.add?.length ?? 0) + (v.remove?.length ?? 0) > 0, {
          message: 'add or remove must contain at least one tag',
        })
        .safeParse(request.body);
      if (!parsed.success) throw new ValidationError('Invalid input', parsed.error.flatten());
      const { add = [], remove = [] } = parsed.data;

      // Read-modify-write under withTenant. Two short statements is
      // simpler than a single set-difference UPDATE and easier to reason
      // about — the read+write happens inside the same row's lock window
      // because of withTenant's session-pinned transaction.
      const updated = await withTenant(request.tenantId, async (tx) => {
        const [current] = await tx.select({ customTags: contacts.customTags })
          .from(contacts)
          .where(and(eq(contacts.id, id), eq(contacts.tenantId, request.tenantId)))
          .limit(1);
        if (!current) return null;
        const next = computeNextTags(current.customTags ?? [], add, remove);
        const [c] = await tx.update(contacts)
          .set({ customTags: next, updatedAt: new Date() })
          .where(and(eq(contacts.id, id), eq(contacts.tenantId, request.tenantId)))
          .returning({ id: contacts.id, customTags: contacts.customTags });
        return c ?? null;
      });

      if (!updated) throw new NotFoundError('Contact', id);

      if (add.length > 0) {
        try {
          await logEvent({
            tenantId: request.tenantId,
            contactId: id,
            type: 'contact_tagged',
            eventCategory: 'system_action',
            actorType: 'user',
            actorUserId: request.userId,
            title: `Tagged: ${add.join(', ')}`,
            metadata: { tagsAdded: add },
          });
        } catch (err) {
          logger.warn({ err, contactId: id }, 'Failed to log contact_tagged');
        }
      }
      if (remove.length > 0) {
        try {
          await logEvent({
            tenantId: request.tenantId,
            contactId: id,
            type: 'contact_untagged',
            eventCategory: 'system_action',
            actorType: 'user',
            actorUserId: request.userId,
            title: `Untagged: ${remove.join(', ')}`,
            metadata: { tagsRemoved: remove },
          });
        } catch (err) {
          logger.warn({ err, contactId: id }, 'Failed to log contact_untagged');
        }
      }

      return { data: { contactId: id, customTags: updated.customTags ?? [] } };
    },
  );

  // POST /api/contacts/:id/reassign — change the contact's owner.
  // Stage 1 stores this on contacts.created_by_user_id since there's no
  // separate owner_user_id column yet (and no team UI). The target user
  // must be a member of the current tenant.
  fastify.post<{ Params: { id: string }; Body: { userId: string } }>(
    '/:id/reassign',
    async (request) => {
      const { id } = request.params;
      const parsed = z.object({ userId: z.string().uuid() }).safeParse(request.body);
      if (!parsed.success) throw new ValidationError('Invalid input', parsed.error.flatten());
      const targetUserId = parsed.data.userId;

      const [member] = await withTenant(request.tenantId, async (tx) => {
        return tx.select({ userId: userTenants.userId }).from(userTenants)
          .where(and(eq(userTenants.tenantId, request.tenantId), eq(userTenants.userId, targetUserId)))
          .limit(1);
      });
      if (!member) throw new ValidationError('Target user is not a member of this workspace');

      const updated = await withTenant(request.tenantId, async (tx) => {
        const [c] = await tx.update(contacts)
          .set({ createdByUserId: targetUserId, updatedAt: new Date() })
          .where(and(eq(contacts.id, id), eq(contacts.tenantId, request.tenantId)))
          .returning();
        return c ?? null;
      });
      if (!updated) throw new NotFoundError('Contact', id);

      try {
        await logEvent({
          tenantId: request.tenantId,
          contactId: id,
          type: 'contact_reassigned',
          eventCategory: 'system_action',
          actorType: 'user',
          actorUserId: request.userId,
          title: 'Contact reassigned',
          metadata: { toUserId: targetUserId },
        });
      } catch (err) {
        logger.warn({ err, contactId: id }, 'Failed to log contact_reassigned');
      }

      return { data: { contactId: id, createdByUserId: targetUserId } };
    },
  );
}
