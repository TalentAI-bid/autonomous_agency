import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq, and, desc, lt, ilike, sql, or } from 'drizzle-orm';
import { withTenant } from '../config/database.js';
import { contacts, companies, masterAgents, outreachEmails, opportunities, emailsSent } from '../db/schema/index.js';
import { NotFoundError, ValidationError } from '../utils/errors.js';
import { selectEmailAccount, incrementQuota } from '../tools/email-queue.tool.js';
import { sendEmail } from '../tools/smtp.tool.js';
import { acquireSmtpSlot } from '../services/smtp-rate-limiter.service.js';
import { extractJSON, complete, SMART_MODEL } from '../tools/together-ai.tool.js';
import { extractJSONFromText } from '../utils/json-extract.js';
import { buildDraftEmailSystemPrompt, buildDraftEmailUserPrompt } from '../prompts/draft-email.prompt.js';
import { buildSalesEmailPrompt, type EmailGenerationContext } from '../prompts/sales-email-generation.js';
import { buildRecruitmentEmailPrompt } from '../prompts/recruitment-email-generation.js';
import { findEmailByPattern, verifyEmailManual } from '../tools/email-finder.tool.js';
import { wrapEmailBody, plainTextToHtml } from '../templates/email-template.js';
import { logActivity, ensureDeal } from '../services/crm-activity.service.js';
import { ensureDefaultCampaign, enrollContactInSequence } from '../services/followup.service.js';
import logger from '../utils/logger.js';

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
  fastify.get<{
    Querystring: {
      cursor?: string;
      limit?: string;
      status?: string;
      source?: string;
      search?: string;
      minScore?: string;
      maxScore?: string;
      masterAgentId?: string;
      companyId?: string;
    };
  }>('/', async (request) => {
    const limit = Math.min(parseInt(request.query.limit || '20', 10), 100);
    const { cursor, status, source, search, minScore, maxScore, masterAgentId, companyId } = request.query;

    const results = await withTenant(request.tenantId, async (tx) => {
      const conditions = [eq(contacts.tenantId, request.tenantId)];

      if (status) {
        conditions.push(eq(contacts.status, status as any));
      }
      if (source) conditions.push(eq(contacts.source, source as any));
      if (masterAgentId) conditions.push(eq(contacts.masterAgentId, masterAgentId));
      if (companyId) conditions.push(eq(contacts.companyId, companyId));
      if (minScore) conditions.push(sql`${contacts.score} >= ${parseInt(minScore, 10)}`);
      if (maxScore) conditions.push(sql`${contacts.score} <= ${parseInt(maxScore, 10)}`);
      if (search) {
        conditions.push(sql`(
          ${contacts.firstName} ILIKE ${'%' + search + '%'} OR
          ${contacts.lastName} ILIKE ${'%' + search + '%'} OR
          ${contacts.email} ILIKE ${'%' + search + '%'} OR
          ${contacts.companyName} ILIKE ${'%' + search + '%'}
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

      return tx.select().from(contacts)
        .where(and(...conditions))
        .orderBy(desc(contacts.createdAt))
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
    return { data: contact };
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

    const [contact] = await withTenant(request.tenantId, async (tx) => {
      return tx.update(contacts)
        .set({ ...parsed.data, updatedAt: new Date() })
        .where(and(eq(contacts.id, id), eq(contacts.tenantId, request.tenantId)))
        .returning();
    });
    if (!contact) throw new NotFoundError('Contact', id);
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

    // Load most recent master agent for context
    let masterAgent = null;
    const maId = contact.masterAgentId ?? company?.masterAgentId;
    if (maId) {
      const [ma] = await withTenant(request.tenantId, async (tx) => {
        return tx.select().from(masterAgents)
          .where(and(eq(masterAgents.id, maId), eq(masterAgents.tenantId, request.tenantId)))
          .limit(1);
      });
      masterAgent = ma ?? null;
    }

    // For sales/recruitment master agents, use the rich auto-outreach prompts
    // (sales-email-generation / recruitment-email-generation) so manual drafts
    // match the quality of automated sends. Fall back to the basic
    // draft-email.prompt.ts otherwise.
    const useCase = masterAgent?.useCase;
    const useRichPrompts = !!masterAgent && (useCase === 'sales' || useCase === 'recruitment');

    let systemPrompt: string;
    let userPrompt: string;
    let promptVariant: string;

    if (useRichPrompts) {
      // Load best-matching opportunity (mirrors outreach.agent.ts)
      const oppConditions = [eq(opportunities.masterAgentId, masterAgent!.id)];
      if (contact.companyId) {
        oppConditions.push(or(eq(opportunities.contactId, id), eq(opportunities.companyId, contact.companyId))!);
      } else {
        oppConditions.push(eq(opportunities.contactId, id));
      }
      const [opp] = await withTenant(request.tenantId, async (tx) => {
        return tx.select().from(opportunities)
          .where(and(...oppConditions))
          .orderBy(desc(opportunities.buyingIntentScore))
          .limit(1);
      });

      const config = (masterAgent!.config as Record<string, unknown>) ?? {};
      const pipelineCtx = (config.pipelineContext as Record<string, unknown>) ?? {};
      const contactRaw = (contact.rawData ?? {}) as Record<string, unknown>;
      const companyRaw = (company?.rawData ?? {}) as Record<string, unknown>;

      const ctx: EmailGenerationContext = {
        contact: {
          firstName: contact.firstName ?? 'there',
          lastName: contact.lastName ?? undefined,
          title: contact.title ?? undefined,
          skills: (contact.skills as string[] | undefined) ?? (contactRaw.skills as string[] | undefined),
          experience: Array.isArray(contact.experience) ? contact.experience.length : undefined,
          linkedinUrl: contact.linkedinUrl ?? undefined,
          summary: (contactRaw.summary as string) ?? undefined,
          seniorityLevel: (contactRaw.seniorityLevel as string) ?? undefined,
          location: contact.location ?? undefined,
        },
        company: {
          name: company?.name ?? contact.companyName ?? undefined,
          domain: company?.domain ?? undefined,
          industry: company?.industry ?? undefined,
          size: company?.size ?? undefined,
          techStack: (company?.techStack as string[] | undefined) ?? undefined,
          funding: company?.funding ?? undefined,
          description: company?.description ?? undefined,
          recentNews: (companyRaw.recentNews as string[]) ?? undefined,
          products: (companyRaw.products as string[]) ?? undefined,
          foundedYear: (companyRaw.foundedYear as number) ?? undefined,
          headquarters: (companyRaw.headquarters as string) ?? undefined,
          competitors: (companyRaw.competitors as string[]) ?? undefined,
          recentFunding: (companyRaw.recentFunding as string) ?? undefined,
          keyPeople: (companyRaw.keyPeople as Array<{ name: string; title: string }>) ?? undefined,
        },
        sender: {
          companyName: (config.senderCompanyName as string) ?? masterAgent!.name ?? undefined,
          companyDescription: (config.senderCompanyDescription as string) ?? masterAgent!.description ?? undefined,
          services: (config.services as string[]) ?? undefined,
          caseStudies: (config.caseStudies as Array<{ title: string; result: string }>) ?? undefined,
          differentiators: (config.differentiators as string[]) ?? undefined,
          valueProposition: (config.valueProposition as string) ?? undefined,
          callToAction: (config.callToAction as string) ?? undefined,
          calendlyUrl: (config.calendlyUrl as string) ?? undefined,
          website: (config.senderWebsite as string) ?? undefined,
          senderFirstName: (config.senderFirstName as string) ?? (pipelineCtx.senderFirstName as string) ?? undefined,
          senderTitle: (config.senderTitle as string) ?? (pipelineCtx.senderTitle as string) ?? undefined,
          products: ((pipelineCtx.sales as Record<string, unknown>)?.products as Array<{ name: string; description?: string | null; keyFeatures?: string[] | null; painPointsSolved?: string[] | null }>) ?? undefined,
        },
        campaign: {
          tone: (config.emailTone as string) ?? 'professional',
          useCase,
          emailRules: (config.emailRules as string[]) ?? undefined,
          stepNumber: 1,
          totalSteps: 1,
        },
        opportunity: opp ? {
          type: opp.opportunityType,
          title: opp.title,
          description: opp.description ?? undefined,
          buyingIntentScore: opp.buyingIntentScore,
          technologies: (opp.technologies as string[]) ?? undefined,
          source: opp.source ?? undefined,
        } : undefined,
      };

      const built = useCase === 'sales'
        ? buildSalesEmailPrompt(ctx)
        : buildRecruitmentEmailPrompt(ctx);
      systemPrompt = built.system;
      userPrompt = hint ? `${built.user}\n\nADDITIONAL USER HINT: ${hint}` : built.user;
      promptVariant = `${useCase}-rich`;
    } else {
      systemPrompt = buildDraftEmailSystemPrompt(masterAgent, company);
      userPrompt = buildDraftEmailUserPrompt(contact, company, hint);
      promptVariant = 'draft-email-fallback';
    }

    const messages: Array<{ role: 'system' | 'user'; content: string }> = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ];

    logger.info({
      contactId: id,
      contactName: `${contact.firstName ?? ''} ${contact.lastName ?? ''}`.trim(),
      companyName: company?.name,
      systemPromptLen: systemPrompt.length,
      userPromptLen: userPrompt.length,
      promptVariant,
      model: SMART_MODEL,
    }, 'draft-email: starting LLM call');

    let draft: { subject: string; body: string };

    try {
      draft = await extractJSON<{ subject: string; body: string }>(
        request.tenantId,
        messages,
        2,
        { model: SMART_MODEL, temperature: 0.7 },
      );
      logger.info({ contactId: id, subject: draft.subject?.slice(0, 80) }, 'draft-email: JSON extracted successfully');
    } catch (err) {
      logger.warn({
        contactId: id,
        error: err instanceof Error ? err.message : String(err),
      }, 'draft-email: extractJSON failed, attempting raw fallback');

      // Fallback: get raw completion and try to extract, or use as-is
      try {
        const rawText = await complete(request.tenantId, messages, { model: SMART_MODEL, temperature: 0.7, max_tokens: 16384 });
        logger.info({ contactId: id, rawLen: rawText.length, rawPreview: rawText.slice(0, 200) }, 'draft-email: raw LLM response');

        try {
          draft = extractJSONFromText<{ subject: string; body: string }>(rawText);
          logger.info({ contactId: id }, 'draft-email: JSON extracted from raw fallback');
        } catch {
          // Use raw text as email body with a fallback subject
          draft = {
            subject: `Quick question about ${company?.name || 'your work'}`,
            body: rawText.trim(),
          };
          logger.warn({ contactId: id }, 'draft-email: using raw text as fallback body');
        }
      } catch (rawErr) {
        logger.error({
          contactId: id,
          error: rawErr instanceof Error ? rawErr.message : String(rawErr),
        }, 'draft-email: both extractJSON and raw fallback failed');
        throw rawErr;
      }
    }

    // Defensive: even though the prompt asks for plain text, DeepSeek
    // sometimes still emits <p>/<br>/<strong> tags. The dashboard textarea
    // displays whatever we return verbatim, so we strip HTML server-side
    // to guarantee a clean draft. The conversion to HTML happens later
    // at send time (routes/contact.routes.ts /send-email).
    if (draft.body) draft.body = stripHtmlToPlainText(draft.body);
    if (draft.subject) draft.subject = draft.subject.replace(/<[^>]+>/g, '').trim();

    return { data: draft };
  });

  // POST /api/contacts/:id/send-email — Send email via configured SMTP
  fastify.post<{ Params: { id: string }; Body: { subject: string; body: string } }>('/:id/send-email', async (request) => {
    const { id } = request.params;
    const { subject, body } = request.body as { subject: string; body: string };

    if (!subject || !body) throw new ValidationError('subject and body are required');

    // Load contact
    const [contact] = await withTenant(request.tenantId, async (tx) => {
      return tx.select().from(contacts)
        .where(and(eq(contacts.id, id), eq(contacts.tenantId, request.tenantId)))
        .limit(1);
    });
    if (!contact) throw new NotFoundError('Contact', id);
    if (!contact.email) throw new ValidationError('Contact has no email address');

    // Select email account
    const account = await selectEmailAccount(request.tenantId);
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

    // Save to outreach_emails
    const [saved] = await withTenant(request.tenantId, async (tx) => {
      return tx.insert(outreachEmails).values({
        tenantId: request.tenantId,
        contactId: id,
        masterAgentId: contact.masterAgentId ?? undefined,
        subject,
        body,
        messageId: result.messageId,
        status: 'sent',
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
}
