import { eq, and, desc, sql, inArray } from 'drizzle-orm';
import { BaseAgent } from './base-agent.js';
import { withTenant } from '../config/database.js';
import { replies, emailQueue, emailThreads, contacts, deals } from '../db/schema/index.js';
import type { EmailThread } from '../db/schema/index.js';
import { ensureDeal, moveDealStage, logActivity, findStageBySlug } from '../services/crm-activity.service.js';
import {
  buildEmailAnalysisSystemPrompt,
  buildEmailAnalysisUserPrompt,
  buildThreadSummarySystemPrompt,
  buildThreadSummaryUserPrompt,
  type EmailAnalysisResult,
  type ThreadSummaryResult,
} from '../prompts/mailbox.prompt.js';
import logger from '../utils/logger.js';

export class MailboxAgent extends BaseAgent {
  async execute(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const action = input.action as string;
    await this.setCurrentAction('mailbox_action', action);

    try {
    switch (action) {
      case 'thread_email':
        return this.threadEmail(
          input.emailId as string,
          input.type as 'inbound' | 'outbound',
        );
      case 'summarize_thread':
        return this.summarizeThread(input.threadId as string);
      case 'bulk_action':
        return this.bulkAction(
          input.bulkAction as string,
          input.threadIds as string[],
        );
      case 'digest':
        return this.getDigest();
      default:
        logger.warn({ action }, 'MailboxAgent: unknown action');
        return { error: `Unknown action: ${action}` };
    }
    } finally {
      await this.clearCurrentAction();
    }
  }

  /**
   * Thread an email (inbound or outbound) and push to CRM.
   */
  private async threadEmail(
    emailId: string,
    type: 'inbound' | 'outbound',
  ): Promise<Record<string, unknown>> {
    // 1. Load the email
    let email: {
      id: string;
      contactId: string | null;
      subject: string | null;
      body: string | null;
      fromEmail: string | null;
      toEmail?: string | null;
    } | null = null;

    if (type === 'inbound') {
      const [row] = await withTenant(this.tenantId, async (tx) => {
        return tx.select({
          id: replies.id,
          contactId: replies.contactId,
          subject: replies.subject,
          body: replies.body,
          fromEmail: replies.fromEmail,
        })
          .from(replies)
          .where(eq(replies.id, emailId))
          .limit(1);
      });
      email = row ?? null;
    } else {
      const [row] = await withTenant(this.tenantId, async (tx) => {
        return tx.select({
          id: emailQueue.id,
          contactId: emailQueue.contactId,
          subject: emailQueue.subject,
          body: emailQueue.body,
          fromEmail: emailQueue.fromEmail,
          toEmail: emailQueue.toEmail,
        })
          .from(emailQueue)
          .where(eq(emailQueue.id, emailId))
          .limit(1);
      });
      email = row ?? null;
    }

    if (!email) {
      logger.warn({ emailId, type }, 'MailboxAgent: email not found');
      return { error: 'Email not found' };
    }

    // 2. Get contact info
    let contactName: string | undefined;
    if (email.contactId) {
      const [contact] = await withTenant(this.tenantId, async (tx) => {
        return tx.select({ firstName: contacts.firstName, lastName: contacts.lastName })
          .from(contacts)
          .where(eq(contacts.id, email!.contactId!))
          .limit(1);
      });
      contactName = [contact?.firstName, contact?.lastName].filter(Boolean).join(' ') || undefined;
    }

    // 3. Find or create thread
    const normalizedSubject = this.normalizeSubject(email.subject ?? '');
    const thread = await this.findOrCreateThread(email.contactId, normalizedSubject);

    // 4. Update thread counters
    await withTenant(this.tenantId, async (tx) => {
      await tx.update(emailThreads)
        .set({
          lastMessageAt: new Date(),
          messageCount: sql`${emailThreads.messageCount} + 1`,
          updatedAt: new Date(),
        })
        .where(eq(emailThreads.id, thread.id));
    });

    // 5. Link email to thread
    if (type === 'inbound') {
      await withTenant(this.tenantId, async (tx) => {
        await tx.update(replies)
          .set({ threadId: thread.id })
          .where(eq(replies.id, emailId));
      });
    } else {
      await withTenant(this.tenantId, async (tx) => {
        await tx.update(emailQueue)
          .set({ threadId: thread.id })
          .where(eq(emailQueue.id, emailId));
      });
    }

    // 6. CRM integration — ensure deal exists
    let dealId = thread.dealId;
    if (email.contactId) {
      const dealResult = await ensureDeal({
        tenantId: this.tenantId,
        contactId: email.contactId,
        masterAgentId: this.masterAgentId || undefined,
      });
      dealId = dealResult.id;

      // Link deal to thread if not already linked
      if (!thread.dealId) {
        await withTenant(this.tenantId, async (tx) => {
          await tx.update(emailThreads)
            .set({ dealId })
            .where(eq(emailThreads.id, thread.id));
        });
      }

      // 7. Log CRM activity
      await logActivity({
        tenantId: this.tenantId,
        contactId: email.contactId,
        dealId,
        masterAgentId: this.masterAgentId || undefined,
        type: type === 'inbound' ? 'email_received' : 'email_sent',
        title: `${type === 'inbound' ? 'Email received' : 'Email sent'}: ${email.subject ?? '(no subject)'}`,
        description: email.body?.slice(0, 500),
        metadata: {
          emailId,
          threadId: thread.id,
          fromEmail: email.fromEmail,
          toEmail: (email as any).toEmail,
          direction: type,
        },
      });

      // 8. Auto-move deal stage based on email context
      await this.autoMoveDealStage(type, dealId, email.contactId);
    }

    // 9. LLM analysis — extract key info and set priority/nextAction
    let analysis: EmailAnalysisResult | null = null;
    try {
      analysis = await this.analyzeEmail({
        subject: email.subject ?? '',
        body: email.body ?? '',
        fromEmail: email.fromEmail ?? '',
        direction: type,
        contactName,
      });
    } catch (err) {
      logger.warn({ err, emailId }, 'MailboxAgent: LLM analysis failed, continuing without');
    }

    if (analysis) {
      // Update thread priority and next action
      await withTenant(this.tenantId, async (tx) => {
        await tx.update(emailThreads)
          .set({
            priority: analysis!.priority,
            nextAction: analysis!.suggestedNextAction,
            status: analysis!.priority === 'high' ? 'needs_action' : 'active',
            updatedAt: new Date(),
          })
          .where(eq(emailThreads.id, thread.id));
      });

      // Update deal with extracted info
      if (dealId && (analysis.budgetOrValue || analysis.companyName)) {
        await withTenant(this.tenantId, async (tx) => {
          const updates: Record<string, unknown> = { updatedAt: new Date() };
          if (analysis!.budgetOrValue) {
            const numericValue = analysis!.budgetOrValue.replace(/[^0-9.]/g, '');
            if (numericValue) updates.value = numericValue;
          }
          if (analysis!.companyName || analysis!.suggestedNextAction) {
            const [deal] = await tx.select({ notes: deals.notes })
              .from(deals).where(eq(deals.id, dealId!)).limit(1);
            const existingNotes = deal?.notes ?? '';
            const noteAdditions: string[] = [];
            if (analysis!.companyName) noteAdditions.push(`Company: ${analysis!.companyName}`);
            if (analysis!.roleTitle) noteAdditions.push(`Role: ${analysis!.roleTitle}`);
            if (noteAdditions.length > 0) {
              updates.notes = existingNotes
                ? `${existingNotes}\n---\n${noteAdditions.join('\n')}`
                : noteAdditions.join('\n');
            }
          }
          await tx.update(deals).set(updates).where(eq(deals.id, dealId!));
        });
      }

      // Auto-move to meeting-booked if meeting mentioned
      if (analysis.meetingMentioned && dealId && email.contactId) {
        const meetingStage = await findStageBySlug(this.tenantId, 'meeting-booked');
        if (meetingStage) {
          const [currentDeal] = await withTenant(this.tenantId, async (tx) => {
            return tx.select({ stageId: deals.stageId }).from(deals).where(eq(deals.id, dealId!)).limit(1);
          });
          // Only move forward (don't move backward from later stages)
          if (currentDeal) {
            const currentStage = await this.getStagePosition(currentDeal.stageId);
            if (currentStage !== null && currentStage < meetingStage.position) {
              await moveDealStage({
                tenantId: this.tenantId,
                dealId: dealId!,
                newStageId: meetingStage.id,
                masterAgentId: this.masterAgentId || undefined,
              });
            }
          }
        }
      }
    }

    // 10. Emit real-time event
    await this.emitEvent('mailbox:thread_updated', {
      threadId: thread.id,
      emailId,
      type,
      dealId,
    });

    return {
      threadId: thread.id,
      dealId,
      analysis: analysis ?? undefined,
    };
  }

  /**
   * Generate LLM summary for a thread.
   */
  async summarizeThread(threadId: string): Promise<Record<string, unknown>> {
    // Load all messages in thread (sent + received, ordered by date)
    const inboundMessages = await withTenant(this.tenantId, async (tx) => {
      return tx.select({
        id: replies.id,
        fromEmail: replies.fromEmail,
        subject: replies.subject,
        body: replies.body,
        createdAt: replies.createdAt,
      })
        .from(replies)
        .where(eq(replies.threadId, threadId))
        .orderBy(replies.createdAt);
    });

    const outboundMessages = await withTenant(this.tenantId, async (tx) => {
      return tx.select({
        id: emailQueue.id,
        fromEmail: emailQueue.fromEmail,
        toEmail: emailQueue.toEmail,
        subject: emailQueue.subject,
        body: emailQueue.body,
        createdAt: emailQueue.createdAt,
      })
        .from(emailQueue)
        .where(eq(emailQueue.threadId, threadId))
        .orderBy(emailQueue.createdAt);
    });

    // Merge and sort chronologically
    const allMessages = [
      ...inboundMessages.map((m) => ({
        direction: 'received' as const,
        fromEmail: m.fromEmail ?? '',
        subject: m.subject ?? '',
        body: m.body ?? '',
        date: m.createdAt.toISOString(),
      })),
      ...outboundMessages.map((m) => ({
        direction: 'sent' as const,
        fromEmail: m.fromEmail,
        subject: m.subject,
        body: m.body,
        date: m.createdAt.toISOString(),
      })),
    ].sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

    if (allMessages.length === 0) {
      return { error: 'No messages in thread' };
    }

    // Call LLM for summary
    let summaryResult: ThreadSummaryResult;
    try {
      const system = buildThreadSummarySystemPrompt();
      const user = buildThreadSummaryUserPrompt(allMessages);
      summaryResult = await this.extractJSON<ThreadSummaryResult>([
        { role: 'system', content: system },
        { role: 'user', content: user },
      ]);
    } catch (err) {
      logger.warn({ err, threadId }, 'MailboxAgent: thread summarization failed');
      return { error: 'Summarization failed' };
    }

    // Save summary
    await withTenant(this.tenantId, async (tx) => {
      await tx.update(emailThreads)
        .set({
          summary: summaryResult.summary,
          nextAction: summaryResult.suggestedNextAction,
          updatedAt: new Date(),
        })
        .where(eq(emailThreads.id, threadId));
    });

    return { threadId, summary: summaryResult };
  }

  /**
   * Handle bulk operations on threads.
   */
  private async bulkAction(
    action: string,
    threadIds: string[],
  ): Promise<Record<string, unknown>> {
    if (!threadIds || threadIds.length === 0) {
      return { error: 'No thread IDs provided' };
    }

    let affected = 0;

    switch (action) {
      case 'archive': {
        await withTenant(this.tenantId, async (tx) => {
          const result = await tx.update(emailThreads)
            .set({ status: 'archived', updatedAt: new Date() })
            .where(and(
              inArray(emailThreads.id, threadIds),
              eq(emailThreads.tenantId, this.tenantId),
            ))
            .returning({ id: emailThreads.id });
          affected = result.length;
        });
        break;
      }

      case 'mark_spam': {
        // Archive threads and update contact status
        const threads = await withTenant(this.tenantId, async (tx) => {
          return tx.update(emailThreads)
            .set({ status: 'archived', updatedAt: new Date() })
            .where(and(
              inArray(emailThreads.id, threadIds),
              eq(emailThreads.tenantId, this.tenantId),
            ))
            .returning({ id: emailThreads.id, contactId: emailThreads.contactId });
        });
        affected = threads.length;

        // Mark related replies as spam
        await withTenant(this.tenantId, async (tx) => {
          await tx.update(replies)
            .set({ classification: 'spam' })
            .where(inArray(replies.threadId, threadIds));
        });
        break;
      }

      case 'unsubscribe': {
        // Archive threads, update contacts, move deals to lost
        const threads = await withTenant(this.tenantId, async (tx) => {
          return tx.update(emailThreads)
            .set({ status: 'archived', updatedAt: new Date() })
            .where(and(
              inArray(emailThreads.id, threadIds),
              eq(emailThreads.tenantId, this.tenantId),
            ))
            .returning({ id: emailThreads.id, contactId: emailThreads.contactId, dealId: emailThreads.dealId });
        });
        affected = threads.length;

        // Update contacts to archived
        const contactIds = threads.map((t) => t.contactId).filter(Boolean) as string[];
        if (contactIds.length > 0) {
          await withTenant(this.tenantId, async (tx) => {
            await tx.update(contacts)
              .set({ status: 'archived', updatedAt: new Date() })
              .where(inArray(contacts.id, contactIds));
          });
        }

        // Move deals to lost stage
        const lostStage = await findStageBySlug(this.tenantId, 'lost');
        if (lostStage) {
          const dealIds = threads.map((t) => t.dealId).filter(Boolean) as string[];
          for (const dealId of dealIds) {
            await moveDealStage({
              tenantId: this.tenantId,
              dealId,
              newStageId: lostStage.id,
              masterAgentId: this.masterAgentId || undefined,
            });
          }
        }
        break;
      }

      default:
        return { error: `Unknown bulk action: ${action}` };
    }

    return { action, affected };
  }

  /**
   * Generate mailbox digest/overview.
   */
  private async getDigest(): Promise<Record<string, unknown>> {
    const stats = await withTenant(this.tenantId, async (tx) => {
      const [needsAction] = await tx.select({ count: sql<number>`count(*)` })
        .from(emailThreads)
        .where(and(eq(emailThreads.tenantId, this.tenantId), eq(emailThreads.status, 'needs_action')));

      const [active] = await tx.select({ count: sql<number>`count(*)` })
        .from(emailThreads)
        .where(and(eq(emailThreads.tenantId, this.tenantId), eq(emailThreads.status, 'active')));

      const [waiting] = await tx.select({ count: sql<number>`count(*)` })
        .from(emailThreads)
        .where(and(eq(emailThreads.tenantId, this.tenantId), eq(emailThreads.status, 'waiting')));

      const [highPriority] = await tx.select({ count: sql<number>`count(*)` })
        .from(emailThreads)
        .where(and(
          eq(emailThreads.tenantId, this.tenantId),
          eq(emailThreads.priority, 'high'),
          eq(emailThreads.status, 'active'),
        ));

      const recentThreads = await tx.select({
        id: emailThreads.id,
        subject: emailThreads.subject,
        status: emailThreads.status,
        priority: emailThreads.priority,
        nextAction: emailThreads.nextAction,
        lastMessageAt: emailThreads.lastMessageAt,
        messageCount: emailThreads.messageCount,
      })
        .from(emailThreads)
        .where(and(
          eq(emailThreads.tenantId, this.tenantId),
          eq(emailThreads.status, 'needs_action'),
        ))
        .orderBy(desc(emailThreads.lastMessageAt))
        .limit(10);

      return {
        needsAction: Number(needsAction?.count ?? 0),
        active: Number(active?.count ?? 0),
        waiting: Number(waiting?.count ?? 0),
        highPriority: Number(highPriority?.count ?? 0),
        recentNeedsAction: recentThreads,
      };
    });

    return stats;
  }

  // ── Helpers ────────────────────────────────────────────────────────────

  private normalizeSubject(subject: string): string {
    return subject
      .replace(/^(Re|RE|re|Fwd|FWD|fwd|Fw|FW|fw):\s*/g, '')
      .replace(/^(Re|RE|re|Fwd|FWD|fwd|Fw|FW|fw):\s*/g, '') // double strip for "Re: Re:"
      .trim();
  }

  private async findOrCreateThread(
    contactId: string | null,
    normalizedSubject: string,
  ): Promise<EmailThread> {
    // Try to find existing thread by contact + subject
    if (contactId && normalizedSubject) {
      const [existing] = await withTenant(this.tenantId, async (tx) => {
        return tx.select()
          .from(emailThreads)
          .where(and(
            eq(emailThreads.tenantId, this.tenantId),
            eq(emailThreads.contactId, contactId),
            eq(emailThreads.subject, normalizedSubject),
          ))
          .orderBy(desc(emailThreads.lastMessageAt))
          .limit(1);
      });
      if (existing) return existing;
    }

    // Create new thread — validate masterAgentId to avoid FK violation on deleted agents
    const validMasterAgentId = await this.getValidMasterAgentId();
    const [thread] = await withTenant(this.tenantId, async (tx) => {
      return tx.insert(emailThreads).values({
        tenantId: this.tenantId,
        contactId,
        masterAgentId: validMasterAgentId || undefined,
        subject: normalizedSubject || null,
        lastMessageAt: new Date(),
        messageCount: 0,
        status: 'active',
        priority: 'medium',
      }).returning();
    });

    return thread!;
  }

  private async autoMoveDealStage(
    type: 'inbound' | 'outbound',
    dealId: string,
    contactId: string,
  ): Promise<void> {
    try {
      const [deal] = await withTenant(this.tenantId, async (tx) => {
        return tx.select({ stageId: deals.stageId }).from(deals).where(eq(deals.id, dealId)).limit(1);
      });
      if (!deal) return;

      const currentPosition = await this.getStagePosition(deal.stageId);
      if (currentPosition === null) return;

      let targetSlug: string | null = null;
      if (type === 'outbound' && currentPosition < 1) {
        targetSlug = 'contacted';
      } else if (type === 'inbound' && currentPosition < 2) {
        targetSlug = 'replied';
      }

      if (targetSlug) {
        const stage = await findStageBySlug(this.tenantId, targetSlug);
        if (stage) {
          await moveDealStage({
            tenantId: this.tenantId,
            dealId,
            newStageId: stage.id,
            masterAgentId: this.masterAgentId || undefined,
          });
        }
      }
    } catch (err) {
      logger.warn({ err, dealId }, 'MailboxAgent: auto-move stage failed');
    }
  }

  private async getStagePosition(stageId: string): Promise<number | null> {
    const { crmStages } = await import('../db/schema/index.js');
    const [stage] = await withTenant(this.tenantId, async (tx) => {
      return tx.select({ position: crmStages.position })
        .from(crmStages)
        .where(eq(crmStages.id, stageId))
        .limit(1);
    });
    return stage?.position ?? null;
  }

  private async analyzeEmail(email: {
    subject: string;
    body: string;
    fromEmail: string;
    direction: 'inbound' | 'outbound';
    contactName?: string;
  }): Promise<EmailAnalysisResult> {
    const system = buildEmailAnalysisSystemPrompt();
    const user = buildEmailAnalysisUserPrompt(email);
    return await this.extractJSON<EmailAnalysisResult>([
      { role: 'system', content: system },
      { role: 'user', content: user },
    ]);
  }
}
