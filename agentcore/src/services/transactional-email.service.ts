import nodemailer from 'nodemailer';
import { env } from '../config/env.js';
import logger from '../utils/logger.js';

/**
 * Transactional email sender for system messages (invitations, password resets, etc.).
 * Always uses the env SMTP credentials — NOT tenant-owned email accounts — because
 * these emails are part of the platform's authentication surface.
 */

export interface SendTransactionalOpts {
  to: string;
  subject: string;
  html: string;
  text: string;
  replyTo?: string;
}

export async function sendTransactionalEmail(opts: SendTransactionalOpts): Promise<{ messageId: string }> {
  if (!env.SMTP_HOST) {
    throw new Error('Cannot send transactional email: SMTP_HOST is not configured');
  }
  const from = env.SMTP_FROM || env.SMTP_USER;
  if (!from) {
    throw new Error('Cannot send transactional email: neither SMTP_FROM nor SMTP_USER is configured');
  }

  const transporter = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_PORT === 465,
    auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
  });

  const info = await transporter.sendMail({
    from,
    to: opts.to,
    replyTo: opts.replyTo,
    subject: opts.subject,
    html: opts.html,
    text: opts.text,
  });

  const messageId = info.messageId as string;
  logger.info({ to: opts.to, subject: opts.subject, messageId }, 'Transactional email sent');
  return { messageId };
}
