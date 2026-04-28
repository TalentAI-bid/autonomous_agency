import nodemailer from 'nodemailer';
import { Redis } from 'ioredis';
import { env } from '../config/env.js';
import { createRedisConnection } from '../queues/setup.js';
import { decrypt } from '../utils/crypto.js';
import type { EmailAccount } from '../db/schema/index.js';
import logger from '../utils/logger.js';
import { appendToSentFolder } from './imap-sent-append.tool.js';

export interface SendEmailOpts {
  tenantId: string;
  from: string;
  to: string;
  subject: string;
  html: string;
  text?: string;
  trackingId?: string;
  /** Optional email account config. Falls back to env SMTP settings. */
  emailAccount?: EmailAccount;
}

const redis: Redis = createRedisConnection();

const DAILY_EMAIL_LIMIT = 50;

function getTransporterFromEnv() {
  if (!env.SMTP_HOST) throw new Error('SMTP_HOST not configured');
  return nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
  });
}

function getTransporterFromAccount(account: EmailAccount) {
  if (!account.smtpHost) throw new Error(`Email account ${account.id} has no SMTP host configured`);
  const password = account.smtpPass ? decrypt(account.smtpPass) : undefined;
  const port = account.smtpPort ?? 587;
  return nodemailer.createTransport({
    host: account.smtpHost,
    port,
    secure: port === 465,
    auth: account.smtpUser ? { user: account.smtpUser, pass: password } : undefined,
  });
}

function injectTrackingPixel(html: string, trackingId: string): string {
  const pixel = `<img src="${env.PUBLIC_API_URL}/track/open/${trackingId}" width="1" height="1" style="display:none" alt="">`;
  if (html.includes('</body>')) {
    return html.replace('</body>', `${pixel}</body>`);
  }
  return html + pixel;
}

export async function sendEmail(opts: SendEmailOpts): Promise<{ messageId: string }> {
  const { tenantId, from, to, subject, html, text, trackingId, emailAccount } = opts;

  // Rate limit: 50 emails/sender/day (for env-based sending)
  if (!emailAccount) {
    const today = new Date().toISOString().slice(0, 10);
    const rateLimitKey = `tenant:${tenantId}:ratelimit:email:${from}:${today}`;
    const count = await redis.incr(rateLimitKey);
    if (count === 1) {
      await redis.expire(rateLimitKey, 86400);
    }
    if (count > DAILY_EMAIL_LIMIT) {
      throw new Error(`Daily email limit (${DAILY_EMAIL_LIMIT}) reached for sender ${from}`);
    }
  }

  const htmlWithTracking = trackingId ? injectTrackingPixel(html, trackingId) : html;

  const transporter = emailAccount
    ? getTransporterFromAccount(emailAccount)
    : getTransporterFromEnv();

  // Build deliverability headers. List-Unsubscribe + List-Unsubscribe-Post
  // is required by Gmail's bulk-sender rules (Feb 2024) and materially
  // improves inbox placement at any volume.
  const senderDomain = from.includes('@') ? from.split('@')[1]!.replace(/[>\s].*$/, '') : undefined;
  const headers: Record<string, string> = {};
  if (trackingId) {
    headers['List-Unsubscribe'] = `<${env.PUBLIC_API_URL}/track/unsubscribe/${trackingId}>${senderDomain ? `, <mailto:unsubscribe@${senderDomain}>` : ''}`;
    headers['List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click';
  }
  const replyTo = emailAccount?.replyTo ?? emailAccount?.fromEmail;

  const streamTx = nodemailer.createTransport({ streamTransport: true, buffer: true });
  const composed = await streamTx.sendMail({
    from,
    to,
    subject,
    html: htmlWithTracking,
    text: text ?? html.replace(/<[^>]+>/g, ''),
    headers: Object.keys(headers).length ? headers : undefined,
    replyTo: replyTo ?? undefined,
  });
  const rawMessage = composed.message as Buffer;

  const info = await transporter.sendMail({
    envelope: { from, to },
    raw: rawMessage,
  });

  const messageId = info.messageId as string;
  logger.info({ tenantId, from, to, messageId }, 'Email sent');

  if (emailAccount) {
    const result = await appendToSentFolder({
      tenantId,
      emailAccount,
      rawMessage,
      messageId,
    });
    if (result.appended) {
      logger.info({ tenantId, accountId: emailAccount.id, mailbox: result.mailbox, messageId }, 'IMAP appended to Sent');
    }
  }

  return { messageId };
}
