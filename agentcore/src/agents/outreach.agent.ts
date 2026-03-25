import { eq, and, asc, or, desc } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import { BaseAgent } from './base-agent.js';
import { withTenant } from '../config/database.js';
import { contacts, companies, campaigns, campaignContacts, campaignSteps, emailsSent, masterAgents, emailAccounts, opportunities } from '../db/schema/index.js';
import { enqueueEmail } from '../tools/email-queue.tool.js';
import { wrapEmailBody } from '../templates/email-template.js';
import { logActivity, ensureDeal } from '../services/crm-activity.service.js';
import { buildSystemPrompt, buildUserPrompt, type OutreachEmail } from '../prompts/outreach.prompt.js';
import { buildSalesEmailPrompt, type EmailGenerationContext } from '../prompts/sales-email-generation.js';
import { buildRecruitmentEmailPrompt } from '../prompts/recruitment-email-generation.js';
import { env } from '../config/env.js';
import logger from '../utils/logger.js';

export class OutreachAgent extends BaseAgent {
  async execute(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { contactId, campaignId, stepNumber = 1, masterAgentId, dryRun = false } = input as {
      contactId: string;
      campaignId?: string;
      stepNumber?: number;
      masterAgentId: string;
      dryRun?: boolean;
    };

    logger.info({ tenantId: this.tenantId, contactId, stepNumber }, 'OutreachAgent starting');

    // 0. Check if outreach is disabled for this agent
    if (masterAgentId) {
      const [agentRow] = await withTenant(this.tenantId, async (tx) => {
        return tx.select({ config: masterAgents.config }).from(masterAgents)
          .where(and(eq(masterAgents.id, masterAgentId), eq(masterAgents.tenantId, this.tenantId)))
          .limit(1);
      });
      const agentConfig = (agentRow?.config as Record<string, unknown>) ?? {};
      if (agentConfig.enableOutreach === false) {
        logger.info({ tenantId: this.tenantId, masterAgentId, contactId }, 'OutreachAgent: outreach disabled for this agent, skipping');
        return { skipped: true, reason: 'outreach_disabled' };
      }
    }

    await this.setCurrentAction('outreach', `Generating email step ${stepNumber} for ${contactId.slice(0, 8)}`);

    // 1. Load contact + full company data
    const [contact] = await withTenant(this.tenantId, async (tx) => {
      return tx.select().from(contacts)
        .where(and(eq(contacts.id, contactId), eq(contacts.tenantId, this.tenantId)))
        .limit(1);
    });
    if (!contact) throw new Error(`Contact ${contactId} not found`);
    if (!contact.email) {
      logger.warn({ contactId }, 'OutreachAgent: no email address, skipping');
      return { skipped: true, reason: 'no_email' };
    }

    let companyName = contact.companyName ?? '';
    let companyRecord: typeof companies.$inferSelect | null = null;
    if (contact.companyId) {
      const [company] = await withTenant(this.tenantId, async (tx) => {
        return tx.select().from(companies).where(eq(companies.id, contact.companyId!)).limit(1);
      });
      if (company) {
        companyRecord = company;
        companyName = company.name ?? companyName;
      }
    }

    // 1b. Load linked opportunity
    let opportunityRecord: typeof opportunities.$inferSelect | null = null;
    const oppConditions = [eq(opportunities.masterAgentId, masterAgentId)];
    if (contact.companyId) {
      oppConditions.push(or(eq(opportunities.contactId, contactId), eq(opportunities.companyId, contact.companyId))!);
    } else {
      oppConditions.push(eq(opportunities.contactId, contactId));
    }
    const [opp] = await withTenant(this.tenantId, async (tx) => {
      return tx.select().from(opportunities)
        .where(and(...oppConditions))
        .orderBy(desc(opportunities.buyingIntentScore))
        .limit(1);
    });
    opportunityRecord = opp ?? null;

    // 2. Load masterAgent.config for email tone + value proposition
    const [agent] = await withTenant(this.tenantId, async (tx) => {
      return tx.select().from(masterAgents)
        .where(and(eq(masterAgents.id, masterAgentId), eq(masterAgents.tenantId, this.tenantId)))
        .limit(1);
    });
    const config = (agent?.config as Record<string, unknown>) ?? {};

    // 2b. Load configured email account (if set in agent config)
    let emailAccountId: string | undefined;
    let fromEmail = env.SMTP_USER || 'recruitment@agentcore.app';
    const configuredEmailAccountId = config.emailAccountId as string | undefined;
    if (configuredEmailAccountId) {
      const [emailAccount] = await withTenant(this.tenantId, async (tx) => {
        return tx.select().from(emailAccounts)
          .where(and(eq(emailAccounts.id, configuredEmailAccountId), eq(emailAccounts.tenantId, this.tenantId), eq(emailAccounts.isActive, true)))
          .limit(1);
      });
      if (emailAccount) {
        fromEmail = emailAccount.fromEmail;
        emailAccountId = emailAccount.id;
      }
    }

    // 3. Load campaign + step info (fall back to campaignId from master agent config)
    const effectiveCampaignId = campaignId ?? (config.campaignId as string) ?? null;
    let campaignContactId: string | null = null;
    let totalSteps = 3;
    let stepDelay = 0;

    if (effectiveCampaignId) {
      const [campaign] = await withTenant(this.tenantId, async (tx) => {
        return tx.select().from(campaigns).where(eq(campaigns.id, effectiveCampaignId)).limit(1);
      });

      if (campaign) {
        const steps = await withTenant(this.tenantId, async (tx) => {
          return tx.select().from(campaignSteps).where(eq(campaignSteps.campaignId, effectiveCampaignId));
        });
        totalSteps = steps.length || 3;

        const currentStep = steps.find((s) => s.stepNumber === stepNumber);
        if (currentStep) {
          stepDelay = (currentStep.delayDays ?? 3) * 86400000;
        }

        // Get or create campaignContact
        const existing = await withTenant(this.tenantId, async (tx) => {
          return tx.select().from(campaignContacts)
            .where(and(eq(campaignContacts.campaignId, effectiveCampaignId), eq(campaignContacts.contactId, contactId)))
            .limit(1);
        });
        if (existing.length > 0) {
          campaignContactId = existing[0]!.id;
        } else {
          const [newCC] = await withTenant(this.tenantId, async (tx) => {
            return tx.insert(campaignContacts).values({
              campaignId: effectiveCampaignId,
              contactId,
              currentStep: stepNumber,
              status: 'active',
              lastActionAt: new Date(),
            }).returning();
          });
          campaignContactId = newCC!.id;
        }
      }
    }

    // 3b. Load previous email history with open tracking
    const previousEmailRecords = campaignContactId
      ? await withTenant(this.tenantId, async (tx) => {
          return tx.select({
            subject: emailsSent.subject,
            sentAt: emailsSent.sentAt,
            openedAt: emailsSent.openedAt,
            repliedAt: emailsSent.repliedAt,
            stepId: emailsSent.stepId,
          })
          .from(emailsSent)
          .where(eq(emailsSent.campaignContactId, campaignContactId!))
          .orderBy(asc(emailsSent.sentAt));
        })
      : [];

    // 4. Generate email — use intelligent generation if context is available
    const ctx = this.getPipelineContext(input);
    const useCase = ctx?.useCase ?? agent?.useCase ?? (config.useCase as string) ?? undefined;
    const hasSenderContext = !!(config.senderCompanyName || config.services);

    let email: OutreachEmail;

    if ((useCase === 'sales' || useCase === 'recruitment') && hasSenderContext) {
      // Build full EmailGenerationContext
      const contactRawData = (contact.rawData ?? {}) as Record<string, unknown>;
      const companyRawData = (companyRecord?.rawData ?? {}) as Record<string, unknown>;

      const emailGenCtx: EmailGenerationContext = {
        contact: {
          firstName: contact.firstName ?? 'there',
          lastName: contact.lastName ?? undefined,
          title: contact.title ?? undefined,
          skills: (contact.skills as string[]) ?? undefined,
          experience: Array.isArray(contact.experience) ? contact.experience.length : undefined,
          linkedinUrl: contact.linkedinUrl ?? undefined,
          summary: (contactRawData.summary as string) ?? undefined,
          seniorityLevel: (contactRawData.seniorityLevel as string) ?? undefined,
          location: contact.location ?? undefined,
        },
        company: {
          name: companyRecord?.name ?? companyName ?? undefined,
          domain: companyRecord?.domain ?? undefined,
          industry: companyRecord?.industry ?? undefined,
          size: companyRecord?.size ?? undefined,
          techStack: (companyRecord?.techStack as string[]) ?? undefined,
          funding: companyRecord?.funding ?? undefined,
          description: companyRecord?.description ?? undefined,
          recentNews: (companyRawData.recentNews as string[]) ?? undefined,
          products: (companyRawData.products as string[]) ?? undefined,
          foundedYear: (companyRawData.foundedYear as number) ?? undefined,
          headquarters: (companyRawData.headquarters as string) ?? undefined,
          competitors: (companyRawData.competitors as string[]) ?? undefined,
          recentFunding: (companyRawData.recentFunding as string) ?? undefined,
          keyPeople: (companyRawData.keyPeople as Array<{ name: string; title: string }>) ?? undefined,
        },
        sender: {
          companyName: (config.senderCompanyName as string) ?? agent?.name ?? undefined,
          companyDescription: (config.senderCompanyDescription as string) ?? agent?.description ?? undefined,
          services: (config.services as string[]) ?? undefined,
          caseStudies: (config.caseStudies as Array<{ title: string; result: string }>) ?? undefined,
          differentiators: (config.differentiators as string[]) ?? undefined,
          valueProposition: (config.valueProposition as string) ?? undefined,
          callToAction: (config.callToAction as string) ?? undefined,
          calendlyUrl: (config.calendlyUrl as string) ?? undefined,
          website: (config.senderWebsite as string) ?? undefined,
          senderFirstName: (config.senderFirstName as string) ?? undefined,
          senderTitle: (config.senderTitle as string) ?? undefined,
        },
        campaign: {
          tone: (config.emailTone as string) ?? 'professional',
          useCase,
          emailRules: (config.emailRules as string[]) ?? undefined,
          stepNumber,
          totalSteps,
        },
        previousEmails: previousEmailRecords.map((e, idx) => ({
          stepNumber: idx + 1,
          subject: e.subject ?? '',
          sentAt: e.sentAt?.toISOString(),
          opened: !!e.openedAt,
          openedAt: e.openedAt?.toISOString(),
          replied: !!e.repliedAt,
        })),
        opportunity: opportunityRecord ? {
          type: opportunityRecord.opportunityType,
          title: opportunityRecord.title,
          description: opportunityRecord.description ?? undefined,
          buyingIntentScore: opportunityRecord.buyingIntentScore,
          technologies: (opportunityRecord.technologies as string[]) ?? undefined,
          source: opportunityRecord.source ?? undefined,
        } : undefined,
      };

      const { system, user } = useCase === 'sales'
        ? buildSalesEmailPrompt(emailGenCtx)
        : buildRecruitmentEmailPrompt(emailGenCtx);

      email = await this.generateEmail(system, user);
    } else {
      // Fallback to existing basic email generation (backward compatible)
      const emailRules = (config.emailRules as string[]) ?? undefined;
      email = await this.extractClaudeEmail({
        contactFirstName: contact.firstName ?? 'there',
        contactTitle: contact.title ?? '',
        companyName,
        skills: (contact.skills as string[]) ?? [],
        location: contact.location ?? '',
        opportunity: {
          title: (config.targetRoles as string[])?.[0] ?? 'an exciting opportunity',
          company: agent?.name ?? 'our company',
          valueProposition: (config.valueProposition as string) ?? '',
          tone: (config.emailTone as string) ?? 'professional',
        },
        stepNumber,
        context: {
          useCase,
          description: agent?.description ?? undefined,
          mission: agent?.mission ?? undefined,
          valueProposition: (config.valueProposition as string) ?? undefined,
          emailRules,
        },
      });
    }

    // 5. Wrap email body in professional HTML template
    const trackingId = randomUUID();
    const wrappedBody = wrapEmailBody({
      body: email.body,
      senderName: (config.senderFirstName as string) ?? undefined,
      senderTitle: (config.senderTitle as string) ?? undefined,
      senderCompany: (config.senderCompanyName as string) ?? agent?.name ?? undefined,
      senderWebsite: (config.senderWebsite as string) ?? undefined,
      calendlyUrl: (config.calendlyUrl as string) ?? undefined,
      unsubscribeUrl: `${env.PUBLIC_API_URL}/unsubscribe/${trackingId}`,
    });

    // 6. Enqueue email (or skip in dry-run mode)
    let queuedId: string | null = null;
    let messageId: string;

    const stepRecord = effectiveCampaignId
      ? await withTenant(this.tenantId, async (tx) => {
          return tx.select().from(campaignSteps)
            .where(and(eq(campaignSteps.campaignId, effectiveCampaignId), eq(campaignSteps.stepNumber, stepNumber)))
            .limit(1);
        })
      : [];

    if (dryRun) {
      messageId = `dry-run-${trackingId}`;
      logger.info({ tenantId: this.tenantId, contactId, dryRun: true }, 'OutreachAgent: dry-run, skipping email enqueue');

      // Still record in emailsSent for dry-run visibility
      await withTenant(this.tenantId, async (tx) => {
        await tx.insert(emailsSent).values({
          campaignContactId,
          stepId: stepRecord[0]?.id ?? undefined,
          fromEmail,
          toEmail: contact.email!,
          subject: email.subject,
          body: wrappedBody,
          messageId,
        });
      });
    } else {
      const result = await enqueueEmail({
        tenantId: this.tenantId,
        contactId,
        campaignContactId: campaignContactId ?? undefined,
        emailAccountId,
        fromEmail,
        toEmail: contact.email!,
        subject: email.subject,
        body: wrappedBody,
        trackingId,
        masterAgentId,
        campaignId: effectiveCampaignId ?? undefined,
        stepId: stepRecord[0]?.id ?? undefined,
      });
      queuedId = result.queuedId;
      messageId = `queued-${queuedId}`;
    }

    // 6. Update campaignContact step if available
    if (campaignContactId) {
      await withTenant(this.tenantId, async (tx) => {
        await tx.update(campaignContacts)
          .set({ currentStep: stepNumber, lastActionAt: new Date(), status: 'active' })
          .where(eq(campaignContacts.id, campaignContactId!));
      });
    }

    // 7. Update contact status + CRM (skip in dry-run)
    if (!dryRun) {
      await withTenant(this.tenantId, async (tx) => {
        await tx.update(contacts)
          .set({ status: 'contacted', updatedAt: new Date() })
          .where(eq(contacts.id, contactId));
      });

      // Ensure CRM deal exists
      try {
        await ensureDeal({
          tenantId: this.tenantId,
          contactId,
          masterAgentId,
          campaignId: effectiveCampaignId ?? undefined,
        });
      } catch (err) {
        logger.warn({ err, contactId }, 'Failed to ensure CRM deal');
      }

      // Log CRM activity
      try {
        await logActivity({
          tenantId: this.tenantId,
          contactId,
          masterAgentId,
          type: 'email_sent',
          title: `Outreach email queued: ${email.subject}`,
          metadata: { queuedId, stepNumber, campaignId: effectiveCampaignId },
        });
      } catch (err) {
        logger.warn({ err, contactId }, 'Failed to log CRM activity');
      }
    }

    // 8. Dispatch next step if applicable (skip in dry-run)
    if (!dryRun && stepNumber < totalSteps && effectiveCampaignId) {
      await this.dispatchNext('outreach', {
        contactId,
        campaignId: effectiveCampaignId,
        stepNumber: stepNumber + 1,
        masterAgentId,
      }, { delay: stepDelay || 3 * 86400000 });
    }

    this.sendMessage(null, 'reasoning', {
      contactName: `${contact.firstName ?? ''} ${contact.lastName ?? ''}`.trim(),
      emailSubject: email.subject,
      strategy: stepNumber === 1 ? 'initial_outreach' : `follow_up_${stepNumber}`,
      dryRun,
    });

    await this.emitEvent(dryRun ? 'email:drafted' : 'email:sent', { contactId, campaignId: effectiveCampaignId, stepNumber, messageId, dryRun });

    this.logActivity('email_queued', 'completed', {
      inputSummary: contact.email ?? contactId,
      details: { contactId, stepNumber, dryRun, subject: email.subject },
    });
    await this.clearCurrentAction();

    logger.info({ tenantId: this.tenantId, contactId, messageId, stepNumber, dryRun }, 'OutreachAgent completed');

    return { messageId, queuedId, subject: email.subject, body: dryRun ? email.body : undefined, stepNumber, dryRun };
  }

  private async generateEmail(system: string, user: string): Promise<OutreachEmail> {
    const response = await this.callClaude(system, user);

    try {
      const cleaned = response.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
      return JSON.parse(cleaned) as OutreachEmail;
    } catch {
      return {
        subject: 'Quick question',
        body: `<p>${response}</p>`,
      };
    }
  }

  private async extractClaudeEmail(params: {
    contactFirstName: string;
    contactTitle: string;
    companyName: string;
    skills: string[];
    location: string;
    opportunity: { title: string; company: string; valueProposition: string; tone: string };
    stepNumber: number;
    context?: { useCase?: string; description?: string; mission?: string; valueProposition?: string; emailRules?: string[] };
  }): Promise<OutreachEmail> {
    const systemPrompt = buildSystemPrompt(params.opportunity.tone, params.context);
    const userPrompt = buildUserPrompt({
      contact: {
        firstName: params.contactFirstName,
        title: params.contactTitle,
        companyName: params.companyName,
        skills: params.skills,
        location: params.location,
      },
      opportunity: { ...params.opportunity, stepNumber: params.stepNumber },
      useCase: params.context?.useCase,
    });

    const response = await this.callClaude(systemPrompt, userPrompt);

    try {
      const cleaned = response.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
      return JSON.parse(cleaned) as OutreachEmail;
    } catch {
      // Fallback: use raw text as body
      return {
        subject: `Opportunity: ${params.opportunity.title}`,
        body: `<p>${response}</p>`,
      };
    }
  }
}
