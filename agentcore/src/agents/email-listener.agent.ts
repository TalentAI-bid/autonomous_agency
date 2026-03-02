import { eq, and, desc } from 'drizzle-orm';
import { BaseAgent } from './base-agent.js';
import { withTenant } from '../config/database.js';
import { emailListenerConfigs, emailsSent, contacts, replies } from '../db/schema/index.js';
import type { EmailListenerConfig } from '../db/schema/index.js';
import { decrypt } from '../utils/crypto.js';
import { logActivity } from '../services/crm-activity.service.js';
import logger from '../utils/logger.js';

interface ParsedEmail {
  from: string;
  subject: string;
  messageId: string;
  inReplyTo?: string;
  references?: string[];
  textBody: string;
  htmlBody?: string;
  uid: string;
}

export class EmailListenerAgent extends BaseAgent {
  async execute(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { configId } = input as { configId: string };

    // Load listener config
    const [config] = await withTenant(this.tenantId, async (tx) => {
      return tx.select().from(emailListenerConfigs)
        .where(and(eq(emailListenerConfigs.id, configId), eq(emailListenerConfigs.tenantId, this.tenantId)))
        .limit(1);
    });

    if (!config || !config.isActive) {
      logger.info({ configId }, 'Email listener config not found or inactive');
      return { skipped: true };
    }

    logger.info({ tenantId: this.tenantId, configId, protocol: config.protocol }, 'EmailListenerAgent starting');

    let newMessages: ParsedEmail[] = [];

    if (config.protocol === 'imap') {
      newMessages = await this.fetchImap(config);
    } else {
      newMessages = await this.fetchPop3(config);
    }

    // Update last polled time
    await withTenant(this.tenantId, async (tx) => {
      await tx.update(emailListenerConfigs)
        .set({ lastPolledAt: new Date() })
        .where(eq(emailListenerConfigs.id, configId));
    });

    let matched = 0;
    for (const msg of newMessages) {
      const didMatch = await this.processMessage(config, msg);
      if (didMatch) { matched++; }
      else { await this.processUnmatchedEmail(config, msg); }
    }

    // Update lastSeenUid
    if (newMessages.length > 0) {
      const lastUid = newMessages[newMessages.length - 1]!.uid;
      await withTenant(this.tenantId, async (tx) => {
        await tx.update(emailListenerConfigs)
          .set({ lastSeenUid: lastUid })
          .where(eq(emailListenerConfigs.id, configId));
      });
    }

    logger.info({ tenantId: this.tenantId, configId, total: newMessages.length, matched }, 'EmailListenerAgent completed');
    return { total: newMessages.length, matched };
  }

  private async fetchImap(config: EmailListenerConfig): Promise<ParsedEmail[]> {
    try {
      const { ImapFlow } = await import('imapflow');
      const password = decrypt(config.password);

      const client = new ImapFlow({
        host: config.host,
        port: config.port,
        secure: config.useTls,
        auth: { user: config.username, pass: password },
        logger: false,
      });

      await client.connect();
      const lock = await client.getMailboxLock(config.mailbox);
      const messages: ParsedEmail[] = [];

      try {
        // Search for messages with UID greater than lastSeenUid
        const searchCriteria: Record<string, unknown> = config.lastSeenUid
          ? { uid: `${parseInt(config.lastSeenUid, 10) + 1}:*` }
          : { seen: false };

        const messageIterator = client.fetch(searchCriteria, {
          uid: true,
          envelope: true,
          source: true,
        });

        for await (const msg of messageIterator) {
          const envelope = msg.envelope;
          if (!envelope) continue;

          // Parse body from source
          const source = msg.source?.toString() ?? '';
          const textBody = this.extractTextFromSource(source);

          messages.push({
            from: envelope.from?.[0]?.address ?? '',
            subject: envelope.subject ?? '',
            messageId: envelope.messageId ?? '',
            inReplyTo: envelope.inReplyTo ?? undefined,
            references: this.parseReferences(source),
            textBody,
            uid: String(msg.uid),
          });
        }
      } finally {
        lock.release();
      }

      await client.logout();

      // Filter out UIDs ≤ lastSeenUid (IMAP "uid:N+1:*" always returns at least UID N)
      const lastSeenUidNum = config.lastSeenUid ? parseInt(config.lastSeenUid, 10) : 0;
      return messages.filter(m => parseInt(m.uid, 10) > lastSeenUidNum);
    } catch (err) {
      logger.error({ err, configId: config.id }, 'IMAP fetch failed');
      throw err;
    }
  }

  private async fetchPop3(config: EmailListenerConfig): Promise<ParsedEmail[]> {
    try {
      const Pop3Command = (await import('node-pop3')).default;
      const password = decrypt(config.password);

      const pop3 = new Pop3Command({
        host: config.host,
        port: config.port,
        tls: config.useTls,
        user: config.username,
        password,
      });

      const list = await pop3.UIDL() as Array<[string, string]>;
      const messages: ParsedEmail[] = [];
      const lastSeenUid = config.lastSeenUid ?? '0';

      for (const [msgNum, uid] of list) {
        if (uid <= lastSeenUid) continue;

        try {
          const rawMessage = await pop3.RETR(Number(msgNum)) as string;
          const parsed = this.parseRawEmail(rawMessage, uid);
          if (parsed) messages.push(parsed);
        } catch (err) {
          logger.warn({ err, msgNum, uid }, 'Failed to fetch POP3 message');
        }
      }

      await pop3.QUIT();
      return messages;
    } catch (err) {
      logger.error({ err, configId: config.id }, 'POP3 fetch failed');
      throw err;
    }
  }

  private parseRawEmail(raw: string, uid: string): ParsedEmail | null {
    const from = this.extractHeader(raw, 'From') ?? '';
    const subject = this.extractHeader(raw, 'Subject') ?? '';
    const messageId = this.extractHeader(raw, 'Message-ID') ?? '';
    const inReplyTo = this.extractHeader(raw, 'In-Reply-To') ?? undefined;
    const referencesStr = this.extractHeader(raw, 'References') ?? '';
    const references = referencesStr ? referencesStr.split(/\s+/).filter(Boolean) : [];

    // Extract body (simple: after first blank line)
    const bodyStart = raw.indexOf('\r\n\r\n');
    const textBody = bodyStart > -1 ? raw.slice(bodyStart + 4).trim() : '';

    return { from, subject, messageId, inReplyTo, references, textBody, uid };
  }

  private extractHeader(raw: string, name: string): string | null {
    const regex = new RegExp(`^${name}:\\s*(.+?)$`, 'mi');
    const match = raw.match(regex);
    return match?.[1]?.trim() ?? null;
  }

  private extractTextFromSource(source: string): string {
    const bodyStart = source.indexOf('\r\n\r\n');
    if (bodyStart === -1) return source;
    return source.slice(bodyStart + 4).trim().slice(0, 10000);
  }

  private parseReferences(source: string): string[] {
    const match = source.match(/^References:\s*(.+?)(?:\r?\n(?!\s))/ms);
    if (!match) return [];
    return match[1]!.split(/\s+/).filter(Boolean);
  }

  /**
   * Match an inbound email to an outbound emailsSent record.
   * Returns true if matched and processed.
   */
  private async processMessage(config: EmailListenerConfig, msg: ParsedEmail): Promise<boolean> {
    // Strategy 1: In-Reply-To matches emailsSent.messageId
    if (msg.inReplyTo) {
      const match = await this.findEmailByMessageId(msg.inReplyTo);
      if (match) {
        await this.createReply(config, msg, match.id, match.contactId);
        return true;
      }
    }

    // Strategy 2: References contains emailsSent.messageId
    if (msg.references && msg.references.length > 0) {
      for (const ref of msg.references) {
        const match = await this.findEmailByMessageId(ref);
        if (match) {
          await this.createReply(config, msg, match.id, match.contactId);
          return true;
        }
      }
    }

    // Strategy 3: From email matches contacts.email → find most recent emailsSent
    const fromEmail = this.extractEmailAddress(msg.from);
    if (fromEmail) {
      const contact = await this.findContactByEmail(fromEmail);
      if (contact) {
        const recentEmail = await this.findMostRecentEmailToContact(contact.email!);
        await this.createReply(config, msg, recentEmail?.id ?? null, contact.id);
        return true;
      }
    }

    // Strategy 4: Subject "Re: X" matching (weak fallback)
    if (msg.subject.startsWith('Re: ') || msg.subject.startsWith('RE: ')) {
      const originalSubject = msg.subject.replace(/^(Re|RE|re):\s*/, '');
      const match = await this.findEmailBySubject(originalSubject);
      if (match) {
        await this.createReply(config, msg, match.id, match.contactId);
        return true;
      }
    }

    return false;
  }

  /**
   * Handle inbound emails that don't match any outbound email.
   * Creates a contact if needed, inserts a reply, and dispatches for classification.
   */
  private async processUnmatchedEmail(config: EmailListenerConfig, msg: ParsedEmail): Promise<void> {
    const fromEmail = this.extractEmailAddress(msg.from);
    if (!fromEmail) return;

    // Dedup guard: skip if reply with same fromEmail + subject already exists
    const existing = await withTenant(this.tenantId, async (tx) => {
      return tx.select({ id: replies.id }).from(replies)
        .where(and(
          eq(replies.tenantId, this.tenantId),
          eq(replies.fromEmail, fromEmail),
          eq(replies.subject, msg.subject),
        ))
        .limit(1);
    });
    if (existing.length > 0) {
      logger.info({ fromEmail, subject: msg.subject }, 'Duplicate unmatched email skipped');
      return;
    }

    // Find or create contact
    let contact = await this.findContactByEmail(fromEmail);
    if (!contact) {
      const [created] = await withTenant(this.tenantId, async (tx) => {
        return tx.insert(contacts).values({
          tenantId: this.tenantId,
          masterAgentId: this.masterAgentId,
          email: fromEmail,
          source: 'inbound',
          status: 'discovered',
        }).returning({ id: contacts.id, email: contacts.email });
      });
      contact = created ?? null;
    }

    // Insert reply with isInbound flag and tenantId
    const [reply] = await withTenant(this.tenantId, async (tx) => {
      return tx.insert(replies).values({
        tenantId: this.tenantId,
        emailSentId: null,
        contactId: contact?.id ?? null,
        body: msg.textBody,
        fromEmail,
        subject: msg.subject,
        isInbound: true,
        createdAt: new Date(),
      }).returning({ id: replies.id });
    });

    // Dispatch to mailbox agent for threading + CRM (before classification)
    if (reply) {
      await this.dispatchNext('mailbox', {
        action: 'thread_email',
        emailId: reply.id,
        type: 'inbound',
        masterAgentId: this.masterAgentId,
      });
    }

    // Dispatch to reply queue for classification
    if (reply) {
      await this.dispatchNext('reply', {
        replyId: reply.id,
        masterAgentId: this.masterAgentId,
        isGeneralInbound: true,
      });
    }

    // Log CRM activity
    if (contact?.id) {
      try {
        await logActivity({
          tenantId: this.tenantId,
          contactId: contact.id,
          masterAgentId: this.masterAgentId,
          type: 'email_received',
          title: `New inbound email: ${msg.subject}`,
          metadata: {
            from: msg.from,
            subject: msg.subject,
            replyId: reply?.id,
            isGeneralInbound: true,
          },
        });
      } catch (err) {
        logger.warn({ err }, 'Failed to log inbound email CRM activity');
      }
    }

    logger.info({ tenantId: this.tenantId, replyId: reply?.id, fromEmail, subject: msg.subject }, 'Unmatched inbound email processed');
  }

  private async findEmailByMessageId(messageId: string): Promise<{ id: string; contactId: string | null } | null> {
    const results = await withTenant(this.tenantId, async (tx) => {
      return tx.select({ id: emailsSent.id, toEmail: emailsSent.toEmail })
        .from(emailsSent)
        .where(eq(emailsSent.messageId, messageId))
        .limit(1);
    });
    if (results.length === 0) return null;

    // Find contactId from the toEmail
    const contact = results[0]!.toEmail ? await this.findContactByEmail(results[0]!.toEmail) : null;
    return { id: results[0]!.id, contactId: contact?.id ?? null };
  }

  private async findContactByEmail(email: string): Promise<{ id: string; email: string | null } | null> {
    const results = await withTenant(this.tenantId, async (tx) => {
      return tx.select({ id: contacts.id, email: contacts.email })
        .from(contacts)
        .where(and(eq(contacts.email, email), eq(contacts.tenantId, this.tenantId)))
        .limit(1);
    });
    return results[0] ?? null;
  }

  private async findMostRecentEmailToContact(email: string): Promise<{ id: string } | null> {
    const results = await withTenant(this.tenantId, async (tx) => {
      return tx.select({ id: emailsSent.id })
        .from(emailsSent)
        .where(eq(emailsSent.toEmail, email))
        .orderBy(desc(emailsSent.sentAt))
        .limit(1);
    });
    return results[0] ?? null;
  }

  private async findEmailBySubject(subject: string): Promise<{ id: string; contactId: string | null } | null> {
    const results = await withTenant(this.tenantId, async (tx) => {
      return tx.select({ id: emailsSent.id, toEmail: emailsSent.toEmail })
        .from(emailsSent)
        .where(eq(emailsSent.subject, subject))
        .orderBy(desc(emailsSent.sentAt))
        .limit(1);
    });
    if (results.length === 0) return null;
    const contact = results[0]!.toEmail ? await this.findContactByEmail(results[0]!.toEmail) : null;
    return { id: results[0]!.id, contactId: contact?.id ?? null };
  }

  private extractEmailAddress(from: string): string | null {
    const match = from.match(/<(.+?)>/) || from.match(/([^\s<>]+@[^\s<>]+)/);
    return match?.[1] ?? null;
  }

  private async createReply(
    config: EmailListenerConfig,
    msg: ParsedEmail,
    emailSentId: string | null,
    contactId: string | null,
  ): Promise<void> {
    // Dedup guard: skip if reply with same fromEmail + subject already exists
    const dedupEmail = this.extractEmailAddress(msg.from);
    if (dedupEmail) {
      const existing = await withTenant(this.tenantId, async (tx) => {
        return tx.select({ id: replies.id }).from(replies)
          .where(and(
            eq(replies.tenantId, this.tenantId),
            eq(replies.fromEmail, dedupEmail),
            eq(replies.subject, msg.subject),
          ))
          .limit(1);
      });
      if (existing.length > 0) {
        logger.info({ fromEmail: dedupEmail, subject: msg.subject }, 'Duplicate reply skipped');
        return;
      }
    }

    // Insert reply record with tenantId
    const [reply] = await withTenant(this.tenantId, async (tx) => {
      return tx.insert(replies).values({
        tenantId: this.tenantId,
        emailSentId,
        contactId,
        body: msg.textBody,
        fromEmail: this.extractEmailAddress(msg.from),
        subject: msg.subject,
        isInbound: !emailSentId,
        createdAt: new Date(),
      }).returning({ id: replies.id });
    });

    // Update emailsSent.repliedAt if matched
    if (emailSentId) {
      await withTenant(this.tenantId, async (tx) => {
        await tx.update(emailsSent)
          .set({ repliedAt: new Date() })
          .where(eq(emailsSent.id, emailSentId));
      });
    }

    // Update contact status
    if (contactId) {
      await withTenant(this.tenantId, async (tx) => {
        await tx.update(contacts)
          .set({ status: 'replied', updatedAt: new Date() })
          .where(eq(contacts.id, contactId));
      });
    }

    // Dispatch to mailbox agent for threading + CRM (before classification)
    if (reply) {
      await this.dispatchNext('mailbox', {
        action: 'thread_email',
        emailId: reply.id,
        type: 'inbound',
        masterAgentId: this.masterAgentId,
      });
    }

    // Dispatch reply agent for classification
    if (reply) {
      await this.dispatchNext('reply', {
        replyId: reply.id,
        masterAgentId: this.masterAgentId,
      });
    }

    // Log CRM activity
    if (contactId) {
      try {
        await logActivity({
          tenantId: this.tenantId,
          contactId,
          masterAgentId: this.masterAgentId,
          type: 'email_received',
          title: `Reply received: ${msg.subject}`,
          metadata: {
            from: msg.from,
            subject: msg.subject,
            replyId: reply?.id,
            emailSentId,
          },
        });
      } catch (err) {
        logger.warn({ err }, 'Failed to log reply CRM activity');
      }
    }

    logger.info({ tenantId: this.tenantId, replyId: reply?.id, contactId, emailSentId }, 'Reply created from inbound email');
  }
}
