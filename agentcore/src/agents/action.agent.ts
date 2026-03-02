import { eq, and } from 'drizzle-orm';
import { BaseAgent } from './base-agent.js';
import { withTenant } from '../config/database.js';
import { contacts, companies, masterAgents, users, interviews } from '../db/schema/index.js';
import { sendEmail } from '../tools/smtp.tool.js';
import { buildSystemPrompt, buildUserPrompt } from '../prompts/action.prompt.js';
import { env } from '../config/env.js';
import logger from '../utils/logger.js';

function nextBusinessDay(): Date {
  const date = new Date();
  date.setDate(date.getDate() + 1);
  // Skip weekends
  while (date.getDay() === 0 || date.getDay() === 6) {
    date.setDate(date.getDate() + 1);
  }
  // Set to 10am UTC
  date.setUTCHours(10, 0, 0, 0);
  return date;
}

export class ActionAgent extends BaseAgent {
  async execute(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { contactId, action, masterAgentId } = input as {
      contactId: string;
      action: string;
      masterAgentId: string;
    };

    logger.info({ tenantId: this.tenantId, contactId, action }, 'ActionAgent starting');

    // 1. Load contact + masterAgent + tenant owner
    const [contact] = await withTenant(this.tenantId, async (tx) => {
      return tx.select().from(contacts)
        .where(and(eq(contacts.id, contactId), eq(contacts.tenantId, this.tenantId)))
        .limit(1);
    });
    if (!contact) throw new Error(`Contact ${contactId} not found`);

    let companyName = contact.companyName ?? '';
    if (contact.companyId) {
      const [company] = await withTenant(this.tenantId, async (tx) => {
        return tx.select().from(companies).where(eq(companies.id, contact.companyId!)).limit(1);
      });
      companyName = company?.name ?? companyName;
    }

    const [agent] = await withTenant(this.tenantId, async (tx) => {
      return tx.select().from(masterAgents)
        .where(and(eq(masterAgents.id, masterAgentId), eq(masterAgents.tenantId, this.tenantId)))
        .limit(1);
    });
    const config = (agent?.config as Record<string, unknown>) ?? {};

    // Get tenant owner for notifications
    const [owner] = await withTenant(this.tenantId, async (tx) => {
      return tx.select().from(users)
        .where(and(eq(users.tenantId, this.tenantId), eq(users.role, 'owner')))
        .limit(1);
    });

    // 2. Generate candidate report using Together AI
    const report = await this.callTogether([
      { role: 'system', content: buildSystemPrompt() },
      {
        role: 'user',
        content: buildUserPrompt({
          contact: {
            firstName: contact.firstName ?? '',
            lastName: contact.lastName ?? '',
            title: contact.title ?? '',
            companyName,
            location: contact.location ?? '',
            skills: (contact.skills as string[]) ?? [],
            experience: (contact.experience as Array<{ company: string; title: string; startDate: string; endDate: string; description?: string }>) ?? [],
            education: (contact.education as Array<{ institution: string; degree: string; field: string; year?: string }>) ?? [],
            score: contact.score ?? 0,
            scoreDetails: contact.scoreDetails as Record<string, unknown>,
            linkedinUrl: contact.linkedinUrl ?? undefined,
          },
          opportunity: {
            title: (config.targetRoles as string[])?.[0] ?? 'Open Position',
            company: agent?.name ?? 'Our Company',
            requiredSkills: (config.requiredSkills as string[]) ?? [],
            valueProposition: (config.valueProposition as string) ?? '',
          },
        }),
      },
    ]);

    let interviewId: string | undefined;
    let reportSent = false;
    let calendarSent = false;

    // 3. Schedule interview
    if (action === 'schedule_interview') {
      const scheduledAt = nextBusinessDay();

      const [interview] = await withTenant(this.tenantId, async (tx) => {
        return tx.insert(interviews).values({
          tenantId: this.tenantId,
          contactId,
          masterAgentId,
          scheduledAt,
          status: 'scheduled',
        }).returning();
      });
      interviewId = interview!.id;

      // Send calendar invite to candidate
      if (contact.email) {
        try {
          const calendarHtml = `
<p>Hi ${contact.firstName ?? 'there'},</p>
<p>Thank you for your interest! We'd love to schedule a conversation with you.</p>
<p><strong>Date/Time:</strong> ${scheduledAt.toUTCString()}</p>
<p>Please reply to confirm this time works for you, or suggest an alternative.</p>
<p>Looking forward to speaking with you!</p>`;

          await sendEmail({
            tenantId: this.tenantId,
            from: env.SMTP_USER || 'recruitment@agentcore.app',
            to: contact.email,
            subject: `Interview Invitation — ${(config.targetRoles as string[])?.[0] ?? 'Open Position'}`,
            html: calendarHtml,
          });
          calendarSent = true;
        } catch (err) {
          logger.warn({ err, contactId }, 'Failed to send calendar invite');
        }
      }

      // Send candidate report to owner
      if (owner?.email) {
        try {
          await sendEmail({
            tenantId: this.tenantId,
            from: env.SMTP_USER || 'system@agentcore.app',
            to: owner.email,
            subject: `Interview Scheduled: ${contact.firstName ?? ''} ${contact.lastName ?? ''} — ${(config.targetRoles as string[])?.[0] ?? 'Open Position'}`,
            html: `<div style="font-family: sans-serif; max-width: 800px;">
<h2>Interview Scheduled</h2>
<p><strong>Candidate:</strong> ${contact.firstName ?? ''} ${contact.lastName ?? ''}</p>
<p><strong>Date:</strong> ${scheduledAt.toUTCString()}</p>
<hr>
<h3>Candidate Report</h3>
<pre style="white-space: pre-wrap; font-family: sans-serif;">${report}</pre>
</div>`,
          });
          reportSent = true;
        } catch (err) {
          logger.warn({ err, ownerId: owner.id }, 'Failed to send candidate report');
        }
      }

      // Update contact status
      await withTenant(this.tenantId, async (tx) => {
        await tx.update(contacts)
          .set({ status: 'interview_scheduled', updatedAt: new Date() })
          .where(eq(contacts.id, contactId));
      });
    }

    await this.emitEvent('campaign:metrics', {
      contactId,
      action,
      interviewId,
      status: 'interview_scheduled',
    });

    logger.info({ tenantId: this.tenantId, contactId, interviewId, reportSent }, 'ActionAgent completed');

    return { interviewId, reportSent, calendarSent, status: 'interview_scheduled' };
  }
}
