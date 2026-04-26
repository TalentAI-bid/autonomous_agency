import { and, eq, isNull } from 'drizzle-orm';
import type { ImapFlow as ImapFlowClient } from 'imapflow';
import { withTenant } from '../config/database.js';
import { emailListenerConfigs } from '../db/schema/index.js';
import type { EmailAccount, EmailListenerConfig } from '../db/schema/index.js';
import { decrypt } from '../utils/crypto.js';
import logger from '../utils/logger.js';

export interface AppendToSentInput {
  tenantId: string;
  emailAccount: EmailAccount;
  rawMessage: Buffer;
  messageId: string;
}

export interface AppendToSentResult {
  appended: boolean;
  mailbox?: string;
  reason?: string;
}

const SENT_CANDIDATES = ['Sent', 'INBOX.Sent', 'Sent Items', 'INBOX.Sent Items'];

async function resolveListener(
  tenantId: string,
  account: EmailAccount,
): Promise<EmailListenerConfig | null> {
  return withTenant(tenantId, async (tx) => {
    const [linked] = await tx.select().from(emailListenerConfigs)
      .where(and(
        eq(emailListenerConfigs.tenantId, tenantId),
        eq(emailListenerConfigs.emailAccountId, account.id),
        eq(emailListenerConfigs.protocol, 'imap'),
        eq(emailListenerConfigs.isActive, true),
      ))
      .limit(1);
    if (linked) return linked;

    if (account.smtpUser) {
      const [byUsername] = await tx.select().from(emailListenerConfigs)
        .where(and(
          eq(emailListenerConfigs.tenantId, tenantId),
          isNull(emailListenerConfigs.emailAccountId),
          eq(emailListenerConfigs.username, account.smtpUser),
          eq(emailListenerConfigs.protocol, 'imap'),
          eq(emailListenerConfigs.isActive, true),
        ))
        .limit(1);
      if (byUsername) return byUsername;
    }

    return null;
  });
}

export async function appendToSentFolder(input: AppendToSentInput): Promise<AppendToSentResult> {
  const { tenantId, emailAccount, rawMessage, messageId } = input;

  let listener: EmailListenerConfig | null = null;
  try {
    listener = await resolveListener(tenantId, emailAccount);
  } catch (err) {
    logger.warn({ err, accountId: emailAccount.id }, 'IMAP append: failed to load listener config');
    return { appended: false, reason: 'listener lookup failed' };
  }

  if (!listener) {
    logger.warn({ accountId: emailAccount.id, smtpUser: emailAccount.smtpUser }, 'IMAP append skipped: no active IMAP listener config for account');
    return { appended: false, reason: 'no listener config' };
  }

  let client: ImapFlowClient | null = null;
  try {
    const password = decrypt(listener.password);
    const { ImapFlow } = await import('imapflow');
    client = new ImapFlow({
      host: listener.host,
      port: listener.port,
      secure: listener.useTls,
      auth: { user: listener.username, pass: password },
      logger: false,
    });

    await client.connect();

    const mailboxes = await client.list();
    const flaggedSent = mailboxes.find((m) => m.specialUse === '\\Sent');
    const candidates = [flaggedSent?.path, ...SENT_CANDIDATES].filter((p): p is string => Boolean(p));

    let appendedMailbox: string | null = null;
    let lastErr: unknown = null;
    for (const box of candidates) {
      try {
        const res = await client.append(box, rawMessage, ['\\Seen']);
        if (res) {
          appendedMailbox = box;
          break;
        }
      } catch (err) {
        lastErr = err;
      }
    }

    if (!appendedMailbox) {
      logger.warn({ err: lastErr, accountId: emailAccount.id, candidates, messageId }, 'IMAP append to Sent failed (best-effort)');
      return { appended: false, reason: 'append rejected by all candidate mailboxes' };
    }

    try {
      const lock = await client.getMailboxLock(appendedMailbox);
      try {
        const idClean = messageId.replace(/^<|>$/g, '');
        const uids = await client.search({ header: { 'message-id': idClean } });
        if (!uids || uids.length === 0) {
          logger.warn({ accountId: emailAccount.id, mailbox: appendedMailbox, messageId }, 'IMAP append verify: message not found after APPEND');
        }
      } finally {
        lock.release();
      }
    } catch (verifyErr) {
      logger.warn({ err: verifyErr, accountId: emailAccount.id, messageId }, 'IMAP append verify step failed (non-fatal)');
    }

    return { appended: true, mailbox: appendedMailbox };
  } catch (err) {
    logger.warn({ err, accountId: emailAccount.id, messageId }, 'IMAP append to Sent failed (best-effort)');
    return { appended: false, reason: err instanceof Error ? err.message : String(err) };
  } finally {
    if (client) {
      try { await client.logout(); } catch { /* ignore */ }
    }
  }
}
