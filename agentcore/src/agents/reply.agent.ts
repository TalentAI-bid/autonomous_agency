import { eq, and } from 'drizzle-orm';
import { BaseAgent } from './base-agent.js';
import { withTenant } from '../config/database.js';
import { replies, emailsSent, campaignContacts, contacts } from '../db/schema/index.js';
import { sendEmail } from '../tools/smtp.tool.js';
import { buildSystemPrompt, buildUserPrompt, type ReplyAnalysis } from '../prompts/reply.prompt.js';
import { buildSystemPrompt as outreachSystemPrompt, buildUserPrompt as outreachUserPrompt } from '../prompts/outreach.prompt.js';
import logger from '../utils/logger.js';

export class ReplyAgent extends BaseAgent {
  async execute(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { replyId, masterAgentId } = input as { replyId: string; masterAgentId: string };

    logger.info({ tenantId: this.tenantId, replyId }, 'ReplyAgent starting');

    // 1. Load reply with joined data
    const [reply] = await withTenant(this.tenantId, async (tx) => {
      return tx.select().from(replies)
        .where(eq(replies.id, replyId))
        .limit(1);
    });
    if (!reply) throw new Error(`Reply ${replyId} not found`);

    // Load email sent record
    const emailSentRecord = reply.emailSentId
      ? await withTenant(this.tenantId, async (tx) => {
          return tx.select().from(emailsSent)
            .where(eq(emailsSent.id, reply.emailSentId!))
            .limit(1);
        })
      : [];

    const emailSent = emailSentRecord[0];

    // Load contact
    const [contact] = reply.contactId
      ? await withTenant(this.tenantId, async (tx) => {
          return tx.select().from(contacts)
            .where(and(eq(contacts.id, reply.contactId!), eq(contacts.tenantId, this.tenantId)))
            .limit(1);
        })
      : [];

    const contactId = contact?.id;

    // 2. Classify reply using Together AI
    const analysis = await this.extractJSON<ReplyAnalysis>([
      { role: 'system', content: buildSystemPrompt() },
      {
        role: 'user',
        content: buildUserPrompt({
          replyBody: reply.body ?? '',
          originalSubject: emailSent?.subject ?? '',
          contactName: contact ? `${contact.firstName ?? ''} ${contact.lastName ?? ''}`.trim() : undefined,
        }),
      },
    ]);

    // 3. Save classification + sentiment to reply
    await withTenant(this.tenantId, async (tx) => {
      await tx.update(replies)
        .set({
          classification: analysis.classification,
          sentiment: analysis.sentiment,
          autoResponse: analysis.suggestedResponse ?? undefined,
          processedAt: new Date(),
        })
        .where(eq(replies.id, replyId));
    });

    // 4. Load campaignContact if we have email data
    const campaignContactRecord = emailSent?.campaignContactId
      ? await withTenant(this.tenantId, async (tx) => {
          return tx.select().from(campaignContacts)
            .where(eq(campaignContacts.id, emailSent.campaignContactId!))
            .limit(1);
        })
      : [];
    const campaignContact = campaignContactRecord[0];

    let actionTaken: string = analysis.classification;

    // 5. Handle by classification
    switch (analysis.classification) {
      case 'interested': {
        if (contactId) {
          await withTenant(this.tenantId, async (tx) => {
            await tx.update(contacts)
              .set({ status: 'replied', updatedAt: new Date() })
              .where(eq(contacts.id, contactId));
          });
          await this.dispatchNext('action', {
            contactId,
            action: 'schedule_interview',
            masterAgentId,
          });
        }
        break;
      }

      case 'objection': {
        // Claude generates a response to the objection
        if (analysis.suggestedResponse && emailSent?.fromEmail && emailSent?.toEmail) {
          try {
            const objectionResponse = await this.callClaude(
              outreachSystemPrompt('professional'),
              `Write a brief, empathetic response to this email objection:\n\nObjection: ${reply.body}\n\nSuggested angle: ${analysis.suggestedResponse}`,
            );
            await sendEmail({
              tenantId: this.tenantId,
              from: emailSent.fromEmail,
              to: emailSent.toEmail,
              subject: `Re: ${emailSent.subject ?? ''}`,
              html: `<p>${objectionResponse.replace(/\n/g, '<br>')}</p>`,
            });
            actionTaken = 'objection_responded';
          } catch (err) {
            logger.warn({ err, replyId }, 'Failed to send objection response');
          }
        }
        break;
      }

      case 'not_now': {
        if (contactId && campaignContact) {
          // Follow up in 60 days
          await this.dispatchNext('outreach', {
            contactId,
            campaignId: campaignContact.campaignId,
            stepNumber: 1,
            masterAgentId,
          }, { delay: 60 * 86400000 });
        }
        break;
      }

      case 'out_of_office': {
        if (contactId && campaignContact && analysis.returnDate) {
          const returnMs = new Date(analysis.returnDate).getTime() - Date.now();
          const delay = Math.max(returnMs + 86400000, 86400000); // at least 1 day after return
          await this.dispatchNext('outreach', {
            contactId,
            campaignId: campaignContact.campaignId,
            stepNumber: 1,
            masterAgentId,
          }, { delay });
        }
        break;
      }

      case 'unsubscribe': {
        if (campaignContact) {
          await withTenant(this.tenantId, async (tx) => {
            await tx.update(campaignContacts)
              .set({ status: 'unsubscribed', lastActionAt: new Date() })
              .where(eq(campaignContacts.id, campaignContact.id));
          });
        }
        if (contactId) {
          await withTenant(this.tenantId, async (tx) => {
            await tx.update(contacts)
              .set({ status: 'archived', updatedAt: new Date() })
              .where(eq(contacts.id, contactId));
          });
        }
        break;
      }

      case 'bounce': {
        if (contactId) {
          await withTenant(this.tenantId, async (tx) => {
            await tx.update(contacts)
              .set({ email: undefined, emailVerified: false, updatedAt: new Date() })
              .where(eq(contacts.id, contactId));
          });
          // Try to find a new email
          await this.dispatchNext('enrichment', { contactId, masterAgentId });
        }
        break;
      }
    }

    // 6. Update campaignContact status
    if (campaignContact) {
      await withTenant(this.tenantId, async (tx) => {
        await tx.update(campaignContacts)
          .set({ status: 'replied', lastActionAt: new Date() })
          .where(eq(campaignContacts.id, campaignContact.id));
      });
    }

    await this.emitEvent('email:replied', {
      replyId,
      contactId,
      classification: analysis.classification,
      sentiment: analysis.sentiment,
    });

    logger.info({ tenantId: this.tenantId, replyId, classification: analysis.classification }, 'ReplyAgent completed');

    return {
      classification: analysis.classification,
      sentiment: analysis.sentiment,
      actionTaken,
    };
  }
}
