// Message Studio service — standalone manual-composition tool.
// Generates a one-shot outreach message for any prospect on any channel.
// No persistence to outreach pipeline; no auto-send. Output is for the
// user to copy and paste manually.
//
// Channels:
//   - email_cold: delegates to draftColdEmail() in cold-email-drafter.service.ts.
//                 Reuses all v4 rules (geography-first, anti-business-description,
//                 anti-upsell, no-uneconomic-anchor, etc.) + STEP 0 classification.
//                 The studio's track choice is forwarded via the `hint` parameter
//                 to override STEP 0.
//   - linkedin_dm, linkedin_connection_request, twitter_dm, whatsapp, telegram:
//                 channel-specific prompts under prompts/studio/, invoked through
//                 the existing Bedrock OpenAI-compatible client.

import { Redis } from 'ioredis';
import { eq } from 'drizzle-orm';
import { env } from '../config/env.js';
import { withTenant } from '../config/database.js';
import { tenants, messageCompositions } from '../db/schema/index.js';
import type { MessagingConfig } from '../db/schema/tenants.js';
import { extractJSON, type ChatMessage } from '../tools/together-ai.tool.js';
import { draftColdEmail } from './cold-email-drafter.service.js';
import { FORBIDDEN as COLD_FORBIDDEN, findForbidden } from './cold-email-drafter.service.js';
import { ensureMessagingConfig, isMessagingConfigSufficient, MESSAGING_NOT_CONFIGURED_ERROR } from './messaging-config.service.js';
import { resolveSenderFirstName } from './sender.service.js';
import { createRedisConnection } from '../queues/setup.js';
import { ValidationError, AppError } from '../utils/errors.js';
import logger from '../utils/logger.js';

import * as linkedinDm from '../prompts/studio/linkedin-dm.prompt.js';
import * as linkedinConnReq from '../prompts/studio/linkedin-connection-request.prompt.js';
import * as twitterDm from '../prompts/studio/twitter-dm.prompt.js';
import * as whatsapp from '../prompts/studio/whatsapp.prompt.js';
import * as telegram from '../prompts/studio/telegram.prompt.js';
import type { ChannelContext, StudioTrack } from '../prompts/studio/types.js';
import {
  MESSAGE_TYPES,
  MESSAGE_TYPE_INSTRUCTIONS,
  isMessageType,
  type MessageType,
} from '../prompts/studio/_message-type-instructions.js';

export type StudioChannel =
  | 'email_cold'
  | 'linkedin_dm'
  | 'linkedin_connection_request'
  | 'twitter_dm'
  | 'whatsapp'
  | 'telegram';

export interface StudioInput {
  tenantId: string;
  userId: string;
  channel: StudioChannel;
  track: StudioTrack;
  messageType?: MessageType;
  recipient: { name: string; company?: string; title?: string; location?: string; linkedinUrl?: string };
  customContext?: string;
}

export interface StudioResult {
  id: string;
  channel: StudioChannel;
  track: StudioTrack;
  messageType: MessageType;
  subject?: string;
  body: string;
  classification?: string;
  characterCount: number;
  createdAt: string;
}

// Reuse the same FORBIDDEN list the cold-email drafter uses so the studio
// can't emit banned phrases either.
COLD_FORBIDDEN; // referenced for clarity; findForbidden() does the scan

const TRACK_TO_COLD_INSTRUCTION: Record<StudioTrack, string> = {
  sales:
    'force_track: NORMAL_OUTREACH — classify the prospect as POTENTIAL_BUYER and write a standard sales pitch regardless of STEP 0 classification.',
  partnership:
    'force_track: PARTNERSHIP_OUTREACH — classify the prospect as DIRECT_COMPETITOR and write a partnership-track email (acknowledge parallel, non-overlap, specific exchange, low-commitment CTA) regardless of STEP 0 classification.',
  collaboration:
    'force_track: COLLABORATION_OUTREACH — classify the prospect as ADJACENT_PARTNER and write a collaboration-track email (acknowledge what they do, name complementarity, small ask) regardless of STEP 0 classification.',
};

interface NonEmailChannelModule {
  SYSTEM_PROMPT: string;
  buildUserPrompt: (ctx: ChannelContext) => string;
}

const NON_EMAIL_PROMPTS: Record<Exclude<StudioChannel, 'email_cold'>, NonEmailChannelModule> = {
  linkedin_dm: linkedinDm,
  linkedin_connection_request: linkedinConnReq,
  twitter_dm: twitterDm,
  whatsapp: whatsapp,
  telegram: telegram,
};

const redis: Redis = createRedisConnection();
redis.on('error', (err: Error) => {
  // Best-effort; the rate-limit increment is already wrapped in try/catch.
  if (err.message?.includes('ECONNRESET') || err.message?.includes('ECONNREFUSED')) return;
  console.error('[Redis:studio] error:', err.message);
});

async function enforceRateLimit(tenantId: string, userId: string): Promise<void> {
  const dateUTC = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const key = `tenant:${tenantId}:user:${userId}:studio:${dateUTC}`;
  const limit = env.STUDIO_DAILY_LIMIT;
  try {
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, 25 * 3600);
    if (count > limit) {
      throw new AppError(
        `Daily generation limit reached (${limit}). Resets at 00:00 UTC.`,
        429,
        'RATE_LIMIT_EXCEEDED',
      );
    }
  } catch (err) {
    if (err instanceof AppError) throw err;
    // Redis hiccup → fail open. Rate-limit is best-effort.
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'studio rate-limit redis error (failing open)');
  }
}

function buildSenderForEmail(config: MessagingConfig): { senderFirstName?: string; senderTitle?: string; senderLocation?: string; companyName?: string; companyDescription?: string; valueProposition?: string; differentiators?: string[]; website?: string } {
  const senderFirstName = config.sender_name?.split(/\s+/)[0];
  return {
    senderFirstName,
    senderTitle: config.sender_title,
    senderLocation: config.sender_location,
    companyName: config.sender_company,
    companyDescription: config.value_prop,
    valueProposition: config.pricing_summary || config.differentiator,
    differentiators: config.differentiator ? [config.differentiator] : undefined,
  };
}

function buildRecipientForEmail(r: StudioInput['recipient']) {
  const parts = r.name.trim().split(/\s+/);
  const firstName = parts[0] ?? r.name;
  const lastName = parts.length > 1 ? parts.slice(1).join(' ') : undefined;
  return {
    firstName,
    lastName,
    title: r.title,
    linkedinUrl: r.linkedinUrl,
    location: r.location,
  };
}

function buildCompanyForEmail(r: StudioInput['recipient']) {
  return r.company ? { name: r.company } : undefined;
}

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

interface ChannelRawOutput {
  body?: string;
  character_count?: number;
}

async function generateNonEmailMessage(
  tenantId: string,
  channel: Exclude<StudioChannel, 'email_cold'>,
  ctx: ChannelContext,
): Promise<{ body: string; needsReview?: boolean }> {
  const mod = NON_EMAIL_PROMPTS[channel];
  const messages: ChatMessage[] = [
    { role: 'system', content: mod.SYSTEM_PROMPT },
    { role: 'user', content: mod.buildUserPrompt(ctx) },
  ];

  let raw = await extractJSON<ChannelRawOutput>(tenantId, messages, 2, {
    model: env.BEDROCK_EMAIL_MODEL,
    temperature: env.BEDROCK_EMAIL_TEMPERATURE,
    max_tokens: 400,
  });

  let body = (raw.body ?? '').trim();
  let needsReview = false;

  // Hard 300-char limit for connection request — must retry on overage.
  if (channel === 'linkedin_connection_request' && body.length > 300) {
    logger.warn({ tenantId, channel, length: body.length }, 'studio_connection_request_overflow: retrying');
    const retryMessages: ChatMessage[] = [
      ...messages,
      { role: 'assistant', content: JSON.stringify(raw) },
      {
        role: 'user',
        content: `Your previous note was ${body.length} characters. Rewrite to ≤ 300 characters. Return ONLY the JSON: { "body": "...", "character_count": <int> }.`,
      },
    ];
    raw = await extractJSON<ChannelRawOutput>(tenantId, retryMessages, 2, {
      model: env.BEDROCK_EMAIL_MODEL,
      temperature: env.BEDROCK_EMAIL_TEMPERATURE,
      max_tokens: 400,
    });
    body = (raw.body ?? '').trim();
    if (body.length > 300) {
      // Force-truncate and flag for review.
      body = body.slice(0, 297) + '…';
      needsReview = true;
      logger.warn({ tenantId, channel, length: body.length }, 'studio_connection_request_force_truncated');
    }
  }

  // Forbidden-phrase guard with one retry — same pattern as cold-email-drafter.
  let hit = findForbidden(body);
  if (hit) {
    logger.warn({ tenantId, channel, forbiddenPhrase: hit }, 'studio_forbidden_phrase: regenerating once');
    const retryMessages: ChatMessage[] = [
      ...messages,
      { role: 'assistant', content: JSON.stringify(raw) },
      {
        role: 'user',
        content: `Your previous draft tripped a forbidden pattern: "${hit}". Rewrite without that phrase or anything matching the same template. Return ONLY the JSON object.`,
      },
    ];
    raw = await extractJSON<ChannelRawOutput>(tenantId, retryMessages, 2, {
      model: env.BEDROCK_EMAIL_MODEL,
      temperature: env.BEDROCK_EMAIL_TEMPERATURE,
      max_tokens: 400,
    });
    body = (raw.body ?? '').trim();
    hit = findForbidden(body);
    if (hit) {
      needsReview = true;
      logger.warn({ tenantId, channel, forbiddenPhrase: hit }, 'studio_forbidden_phrase_after_retry: returning with needsReview');
    }
  }

  // Soft word-count warnings — log only, no retry. Skip for connection request
  // which uses character count, not word count.
  if (channel !== 'linkedin_connection_request') {
    const words = countWords(body);
    const bands: Record<typeof channel, [number, number]> = {
      linkedin_dm: [30, 60],
      twitter_dm: [20, 50],
      whatsapp: [20, 50],
      telegram: [20, 50],
    } as Record<typeof channel, [number, number]>;
    const band = bands[channel];
    if (band && (words < band[0] || words > band[1])) {
      logger.warn({ tenantId, channel, words, band }, 'studio_word_count_out_of_band');
    }
  }

  return { body, needsReview };
}

/**
 * Generate a studio message. Persists the result to message_compositions
 * and returns the row shape for the dashboard to display.
 */
export async function generateStudioMessage(input: StudioInput): Promise<StudioResult> {
  // 0. Validate message type. Default to 'first_message' if absent so older
  // callers continue to work.
  const messageType: MessageType = input.messageType ?? 'first_message';
  if (!isMessageType(messageType)) {
    throw new ValidationError(
      `Invalid messageType "${input.messageType}". Allowed: ${MESSAGE_TYPES.join(', ')}.`,
    );
  }
  // post_meeting needs the user to describe what was discussed — without
  // it the model has nothing to recap and would hallucinate. Surface the
  // requirement explicitly rather than producing a vague thank-you note.
  if (messageType === 'post_meeting' && !input.customContext?.trim()) {
    throw new ValidationError(
      'Post-Meeting messages require customContext describing what was discussed.',
    );
  }

  // 1. Rate limit per user.
  await enforceRateLimit(input.tenantId, input.userId);

  // 2. Resolve messaging config — auto-derives from Company Profile +
  // Products and persists on first call. See messaging-config.service.ts.
  const config = await ensureMessagingConfig(input.tenantId);
  if (!isMessagingConfigSufficient(config)) {
    throw new ValidationError(MESSAGING_NOT_CONFIGURED_ERROR);
  }
  // The sign-off must be the account holder's actual first name, never a
  // value cached in tenant.messagingConfig.sender_name. Override here so
  // every downstream prompt (cold-email, non-email channels) reads the
  // right value. Throws AppError 'MISSING_SENDER_NAME' if users.name is
  // unset — drafts must fail loud rather than ship signed by a fallback.
  config.sender_name = await resolveSenderFirstName(input.tenantId);

  let subject: string | undefined;
  let body: string;
  let classification: string | undefined;

  if (input.channel === 'email_cold') {
    // Delegate to the existing cold-email pipeline. The studio's track
    // choice overrides STEP 0 via the hint parameter. Message-type
    // guidance flows through the same hint so the existing prompt
    // doesn't need a schema change.
    const messageTypeBlock = `${MESSAGE_TYPE_INSTRUCTIONS[messageType]}`;
    const hintParts = [
      TRACK_TO_COLD_INSTRUCTION[input.track],
      messageTypeBlock,
      input.customContext ? `Additional user context: ${input.customContext}` : null,
    ].filter(Boolean) as string[];
    const cold = await draftColdEmail(
      input.tenantId,
      {
        recipient: buildRecipientForEmail(input.recipient),
        company: buildCompanyForEmail(input.recipient),
        sender: buildSenderForEmail(config),
      },
      { hint: hintParts.join('\n\n') },
    );
    subject = cold.subject || undefined;
    body = cold.body;
    classification = cold.classification;
    if (!body) {
      // SKIP track — return the skip reason as the body so the user sees it.
      body = cold.skipReason ? `[Skipped: ${cold.skipReason}]` : '[Skipped]';
    }
  } else {
    const ctx: ChannelContext = {
      recipient: input.recipient,
      track: input.track,
      messageType,
      sender: config,
      customContext: input.customContext,
    };
    const { body: generated } = await generateNonEmailMessage(input.tenantId, input.channel, ctx);
    body = generated;
  }

  // Persist for audit / future analytics. Failures are non-fatal.
  let inserted: { id: string; createdAt: Date } | null = null;
  try {
    const rows = await withTenant(input.tenantId, async (tx) => {
      return tx.insert(messageCompositions).values({
        tenantId: input.tenantId,
        userId: input.userId,
        channel: input.channel,
        track: input.track,
        messageType,
        recipientName: input.recipient.name,
        recipientCompany: input.recipient.company ?? null,
        recipientTitle: input.recipient.title ?? null,
        recipientLocation: input.recipient.location ?? null,
        recipientLinkedinUrl: input.recipient.linkedinUrl ?? null,
        customContext: input.customContext ?? null,
        subject: subject ?? null,
        body,
        classification: classification ?? null,
        characterCount: body.length,
      }).returning({ id: messageCompositions.id, createdAt: messageCompositions.createdAt });
    });
    inserted = rows[0] ?? null;
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'studio_persist_failed (returning result without persistence)');
  }

  return {
    id: inserted?.id ?? '',
    channel: input.channel,
    track: input.track,
    messageType,
    subject,
    body,
    classification,
    characterCount: body.length,
    createdAt: (inserted?.createdAt ?? new Date()).toISOString(),
  };
}
