import nodemailer from 'nodemailer';
import { Redis } from 'ioredis';
import { env } from '../config/env.js';
import { createRedisConnection } from '../queues/setup.js';
import logger from '../utils/logger.js';

export interface SendEmailOpts {
  tenantId: string;
  from: string;
  to: string;
  subject: string;
  html: string;
  text?: string;
  trackingId?: string;
}

const redis: Redis = createRedisConnection();

const DAILY_EMAIL_LIMIT = 50;

function getTransporter() {
  if (!env.SMTP_HOST) throw new Error('SMTP_HOST not configured');
  return nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
  });
}

function injectTrackingPixel(html: string, trackingId: string): string {
  const pixel = `<img src="http://localhost:${env.PORT}/track/open/${trackingId}" width="1" height="1" style="display:none" alt="">`;
  if (html.includes('</body>')) {
    return html.replace('</body>', `${pixel}</body>`);
  }
  return html + pixel;
}

export async function sendEmail(opts: SendEmailOpts): Promise<{ messageId: string }> {
  const { tenantId, from, to, subject, html, text, trackingId } = opts;

  // Rate limit: 50 emails/sender/day
  const today = new Date().toISOString().slice(0, 10);
  const rateLimitKey = `tenant:${tenantId}:ratelimit:email:${from}:${today}`;
  const count = await redis.incr(rateLimitKey);
  if (count === 1) {
    await redis.expire(rateLimitKey, 86400);
  }
  if (count > DAILY_EMAIL_LIMIT) {
    throw new Error(`Daily email limit (${DAILY_EMAIL_LIMIT}) reached for sender ${from}`);
  }

  const htmlWithTracking = trackingId ? injectTrackingPixel(html, trackingId) : html;

  const transporter = getTransporter();
  const info = await transporter.sendMail({
    from,
    to,
    subject,
    html: htmlWithTracking,
    text: text ?? html.replace(/<[^>]+>/g, ''),
  });

  logger.info({ tenantId, from, to, messageId: info.messageId }, 'Email sent');
  return { messageId: info.messageId as string };
}
