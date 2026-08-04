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

interface ImapConn {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
}

/**
 * Derive IMAP connection details from a send-only SMTP account, so we can copy
 * outbound mail into the provider's Sent folder even when no dedicated IMAP
 * listener (inbound-reply) config exists. Most providers (Hostinger, Gmail,
 * Zoho, etc.) use the SAME mailbox credentials for SMTP and IMAP and expose
 * IMAP at the `imap.<domain>` host on 993/TLS. Honors explicit overrides in
 * account.config (imapHost / imapPort / imapSecure) when present.
 */
function imapConnFromAccount(account: EmailAccount): ImapConn | null {
  if (!account.smtpUser || !account.smtpPass) return null;

  const cfg = (account.config ?? {}) as Record<string, unknown>;
  let host = typeof cfg.imapHost === 'string' && cfg.imapHost.trim() ? cfg.imapHost.trim() : undefined;
  if (!host && account.smtpHost) {
    // smtp.hostinger.com → imap.hostinger.com (replace the smtp. label only).
    // Shared hosts that use the same hostname for both keep it unchanged.
    host = account.smtpHost.replace(/(^|\.)smtp\./i, (_m, p1) => `${p1}imap.`);
  }
  if (!host) return null;

  const port = typeof cfg.imapPort === 'number' ? cfg.imapPort : 993;
  const secure = typeof cfg.imapSecure === 'boolean' ? cfg.imapSecure : true;

  let pass: string;
  try {
    pass = decrypt(account.smtpPass);
  } catch {
    return null;
  }
  return { host, port, secure, user: account.smtpUser, pass };
}

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

  // Prefer a dedicated IMAP listener config; otherwise fall back to the
  // account's own SMTP credentials against the provider's IMAP host. This is
  // what makes Sent-folder copies work for send-only accounts with no inbound
  // listener configured (the common case).
  let conn: ImapConn | null = null;
  if (listener) {
    try {
      conn = {
        host: listener.host,
        port: listener.port,
        secure: listener.useTls,
        user: listener.username,
        pass: decrypt(listener.password),
      };
    } catch (err) {
      logger.warn({ err, accountId: emailAccount.id }, 'IMAP append: failed to decrypt listener password');
    }
  }
  if (!conn) {
    conn = imapConnFromAccount(emailAccount);
    if (conn) {
      logger.info({ accountId: emailAccount.id, host: conn.host }, 'IMAP append: using account SMTP credentials (no listener config)');
    }
  }

  if (!conn) {
    logger.warn({ accountId: emailAccount.id, smtpUser: emailAccount.smtpUser }, 'IMAP append skipped: no listener config and no usable account IMAP credentials');
    return { appended: false, reason: 'no imap credentials' };
  }

  let client: ImapFlowClient | null = null;
  try {
    const { ImapFlow } = await import('imapflow');
    client = new ImapFlow({
      host: conn.host,
      port: conn.port,
      secure: conn.secure,
      auth: { user: conn.user, pass: conn.pass },
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
