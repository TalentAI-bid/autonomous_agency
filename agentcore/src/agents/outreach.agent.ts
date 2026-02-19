import { eq, and } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import { BaseAgent } from './base-agent.js';
import { withTenant } from '../config/database.js';
import { contacts, companies, campaigns, campaignContacts, campaignSteps, emailsSent, masterAgents } from '../db/schema/index.js';
import { sendEmail } from '../tools/smtp.tool.js';
import { buildSystemPrompt, buildUserPrompt, type OutreachEmail } from '../prompts/outreach.prompt.js';
import logger from '../utils/logger.js';

export class OutreachAgent extends BaseAgent {
  async execute(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { contactId, campaignId, stepNumber = 1, masterAgentId } = input as {
      contactId: string;
      campaignId?: string;
      stepNumber?: number;
      masterAgentId: string;
    };

    logger.info({ tenantId: this.tenantId, contactId, stepNumber }, 'OutreachAgent starting');

    // 1. Load contact + company
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
    if (contact.companyId) {
      const [company] = await withTenant(this.tenantId, async (tx) => {
        return tx.select().from(companies).where(eq(companies.id, contact.companyId!)).limit(1);
      });
      companyName = company?.name ?? companyName;
    }

    // 2. Load masterAgent.config for email tone + value proposition
    const [agent] = await withTenant(this.tenantId, async (tx) => {
      return tx.select().from(masterAgents)
        .where(and(eq(masterAgents.id, masterAgentId), eq(masterAgents.tenantId, this.tenantId)))
        .limit(1);
    });
    const config = (agent?.config as Record<string, unknown>) ?? {};

    // 3. Load campaign + step info
    let campaignContactId: string | null = null;
    let totalSteps = 3;
    let stepDelay = 0;
    let fromEmail = `recruitment@agentcore.app`;

    if (campaignId) {
      const [campaign] = await withTenant(this.tenantId, async (tx) => {
        return tx.select().from(campaigns).where(eq(campaigns.id, campaignId)).limit(1);
      });

      if (campaign) {
        const steps = await withTenant(this.tenantId, async (tx) => {
          return tx.select().from(campaignSteps).where(eq(campaignSteps.campaignId, campaignId));
        });
        totalSteps = steps.length;

        const currentStep = steps.find((s) => s.stepNumber === stepNumber);
        if (currentStep) {
          stepDelay = (currentStep.delayDays ?? 3) * 86400000;
        }

        // Get or create campaignContact
        const existing = await withTenant(this.tenantId, async (tx) => {
          return tx.select().from(campaignContacts)
            .where(and(eq(campaignContacts.campaignId, campaignId), eq(campaignContacts.contactId, contactId)))
            .limit(1);
        });
        if (existing.length > 0) {
          campaignContactId = existing[0]!.id;
        } else {
          const [newCC] = await withTenant(this.tenantId, async (tx) => {
            return tx.insert(campaignContacts).values({
              campaignId,
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

    // 4. Generate email with Claude
    const email = await this.extractClaudeEmail({
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
    });

    // 5. Send email
    const trackingId = randomUUID();
    const { messageId } = await sendEmail({
      tenantId: this.tenantId,
      from: fromEmail,
      to: contact.email,
      subject: email.subject,
      html: email.body,
      trackingId,
    });

    // 6. Record email sent
    if (campaignContactId) {
      const stepRecord = campaignId
        ? await withTenant(this.tenantId, async (tx) => {
            return tx.select().from(campaignSteps)
              .where(and(eq(campaignSteps.campaignId, campaignId), eq(campaignSteps.stepNumber, stepNumber)))
              .limit(1);
          })
        : [];

      await withTenant(this.tenantId, async (tx) => {
        await tx.insert(emailsSent).values({
          campaignContactId,
          stepId: stepRecord[0]?.id ?? undefined,
          fromEmail,
          toEmail: contact.email!,
          subject: email.subject,
          body: email.body,
          sentAt: new Date(),
          messageId,
        });

        // Update campaignContact step
        await tx.update(campaignContacts)
          .set({ currentStep: stepNumber, lastActionAt: new Date(), status: 'active' })
          .where(eq(campaignContacts.id, campaignContactId!));
      });
    }

    // 7. Update contact status
    await withTenant(this.tenantId, async (tx) => {
      await tx.update(contacts)
        .set({ status: 'contacted', updatedAt: new Date() })
        .where(eq(contacts.id, contactId));
    });

    // 8. Dispatch next step if applicable
    if (stepNumber < totalSteps && campaignId) {
      await this.dispatchNext('outreach', {
        contactId,
        campaignId,
        stepNumber: stepNumber + 1,
        masterAgentId,
      }, { delay: stepDelay || 3 * 86400000 });
    }

    await this.emitEvent('email:sent', { contactId, campaignId, stepNumber, messageId });

    logger.info({ tenantId: this.tenantId, contactId, messageId, stepNumber }, 'OutreachAgent completed');

    return { messageId, subject: email.subject, stepNumber };
  }

  private async extractClaudeEmail(params: {
    contactFirstName: string;
    contactTitle: string;
    companyName: string;
    skills: string[];
    location: string;
    opportunity: { title: string; company: string; valueProposition: string; tone: string };
    stepNumber: number;
  }): Promise<OutreachEmail> {
    const systemPrompt = buildSystemPrompt(params.opportunity.tone);
    const userPrompt = buildUserPrompt({
      contact: {
        firstName: params.contactFirstName,
        title: params.contactTitle,
        companyName: params.companyName,
        skills: params.skills,
        location: params.location,
      },
      opportunity: { ...params.opportunity, stepNumber: params.stepNumber },
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
