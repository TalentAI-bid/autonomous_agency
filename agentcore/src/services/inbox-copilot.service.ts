// LinkedIn Inbox Copilot — drafts a reply to the latest inbound message
// in a LinkedIn DM thread. Builds an ExtractedContext (deterministic
// signals + DB enrichment + LLM-extracted signals from the classifier),
// then drafts a strategy-aligned reply via the LAYER 1 / LAYER 2
// prompt. Persists the conversation, every scraped message, and the
// draft itself to linkedin_conversations / linkedin_messages for audit
// + analytics.
//
// Standalone — does not write to outreach_emails, does not interact with
// the autonomous outreach pipeline. The user always pastes/sends manually
// through LinkedIn's own UI.

import { Redis } from 'ioredis';
import { eq, and, count } from 'drizzle-orm';
import { env } from '../config/env.js';
import { withTenant } from '../config/database.js';
import {
  linkedinConversations,
  linkedinMessages,
  contacts,
  companies,
  outreachEmails,
  interviews,
} from '../db/schema/index.js';
import type { MessagingConfig } from '../db/schema/tenants.js';
import { extractJSON, type ChatMessage } from '../tools/together-ai.tool.js';
import { findForbidden } from './cold-email-drafter.service.js';
import { ensureMessagingConfig } from './messaging-config.service.js';
import { resolveSenderFirstName } from './sender.service.js';
import { createRedisConnection } from '../queues/setup.js';
import { ValidationError, AppError } from '../utils/errors.js';
import { logEvent } from './timeline.service.js';
import { recordResponse } from './prospect-stage.service.js';
import { microTriage } from './triage.service.js';
import logger from '../utils/logger.js';

import {
  CLASSIFIER_SYSTEM_PROMPT,
  buildClassifierUserPrompt,
} from '../prompts/copilot/intent-classifier.prompt.js';
import {
  REPLY_SYSTEM_PROMPT,
  buildReplyUserPrompt,
  buildFollowupUserPrompt,
  isCopilotMode,
  COPILOT_MODES,
  type CopilotMode,
} from '../prompts/copilot/reply-generation.prompt.js';
import type { ExtractedContext } from '../prompts/copilot/extracted-context.js';
import {
  MESSAGE_TYPE_INSTRUCTIONS,
  type MessageType,
} from '../prompts/studio/_message-type-instructions.js';
import {
  COPILOT_INTENTS,
  INTENT_REPLY_STRATEGIES,
  isCopilotIntent,
  type CopilotIntent,
} from '../prompts/copilot/intent-reply-strategies.js';

export interface CopilotInput {
  tenantId: string;
  userId: string;
  recipientLinkedinUrl: string;
  recipientName: string;
  recipientCompany?: string;
  recipientTitle?: string;
  conversationHistory: Array<{
    direction: 'inbound' | 'outbound';
    body: string;
    sentAt: string;
  }>;
  /**
   * What kind of reply the user is asking for. Defaults to
   * 'generate_from_scratch' (legacy sidebar behaviour). The four rewrite
   * modes require a non-empty `existingDraft`.
   */
  mode?: CopilotMode;
  /** The user's in-progress draft text (for rewrite modes). */
  existingDraft?: string;
}

export type ConversationMode = 'reply' | 'followup';

export interface CopilotResult {
  draft: {
    body: string;
    /** For reply mode this is the classified intent; for follow-up mode it's the chosen message type (e.g. first_followup). */
    intent: CopilotIntent | string;
    strategy: string;
    confidence: number;
    alternativeShortVersion?: string;
    needsReview?: boolean;
    /** Model identifier so the UI can show users which model produced this draft. */
    model: string;
    /** Detected mode — 'reply' when last message is inbound, 'followup' otherwise. */
    conversationMode: ConversationMode;
  };
  conversation: {
    id: string;
    totalMessages: number;
  };
}

const redis: Redis = createRedisConnection();
redis.on('error', (err: Error) => {
  if (err.message?.includes('ECONNRESET') || err.message?.includes('ECONNREFUSED')) return;
  console.error('[Redis:copilot] error:', err.message);
});

async function enforceRateLimit(tenantId: string, userId: string): Promise<void> {
  const dateUTC = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const key = `tenant:${tenantId}:user:${userId}:copilot:${dateUTC}`;
  const limit = env.COPILOT_DAILY_LIMIT;
  try {
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, 25 * 3600);
    if (count > limit) {
      throw new AppError(
        `Daily copilot limit reached (${limit}). Resets at 00:00 UTC.`,
        429,
        'RATE_LIMIT_EXCEEDED',
      );
    }
  } catch (err) {
    if (err instanceof AppError) throw err;
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'copilot rate-limit redis error (failing open)');
  }
}

// ─── Deterministic context helpers ──────────────────────────────────

function detectTone(text: string): 'formal' | 'casual' | 'mixed' {
  if (!text) return 'mixed';
  const casualMarkers = (text.match(/\b(hey|yeah|cool|sure|gonna|wanna|lol|haha|lmk|btw|fyi)\b/gi) || []).length;
  const formalMarkers = (text.match(/\b(regards|sincerely|kindly|appreciate|furthermore|moreover)\b/gi) || []).length;
  const exclamations = (text.match(/!/g) || []).length;
  const contractions = (text.match(/'\w/g) || []).length;
  const casualScore = casualMarkers + exclamations + contractions;
  const formalScore = formalMarkers;
  if (casualScore > formalScore + 2) return 'casual';
  if (formalScore > casualScore + 1) return 'formal';
  return 'mixed';
}

function avgWords(messages: Array<{ body: string }>): number {
  if (messages.length === 0) return 0;
  const totalWords = messages.reduce(
    (sum, m) => sum + (m.body?.trim().split(/\s+/).filter(Boolean).length ?? 0),
    0,
  );
  return Math.round(totalWords / messages.length);
}

function daysBetween(later: Date, earlier: Date): number {
  const ms = later.getTime() - earlier.getTime();
  return Math.max(0, Math.floor(ms / (1000 * 60 * 60 * 24)));
}

function estimateResponseSpeed(
  history: CopilotInput['conversationHistory'],
): 'fast' | 'medium' | 'slow' | 'unknown' {
  // Median hours between each inbound message and the most recent
  // outbound message that preceded it. Zero inbound → unknown.
  const gapsHours: number[] = [];
  let lastOutboundAt: Date | null = null;
  for (const m of history) {
    const t = new Date(m.sentAt);
    if (isNaN(t.getTime())) continue;
    if (m.direction === 'outbound') {
      lastOutboundAt = t;
    } else if (m.direction === 'inbound' && lastOutboundAt) {
      gapsHours.push((t.getTime() - lastOutboundAt.getTime()) / (1000 * 60 * 60));
      lastOutboundAt = null;
    }
  }
  if (gapsHours.length === 0) return 'unknown';
  gapsHours.sort((a, b) => a - b);
  const median = gapsHours[Math.floor(gapsHours.length / 2)];
  if (median < 24) return 'fast';
  if (median < 72) return 'medium';
  return 'slow';
}

// ─── DB enrichment ──────────────────────────────────────────────────

interface DbEnrichment {
  source: string | null;
  prior_outreach_attempts: number;
  prior_meeting_history: Array<{
    scheduled_at: string;
    status: 'scheduled' | 'completed' | 'cancelled' | 'no_show';
  }>;
  prior_notes: string | null;
  company_intel: {
    industry: string | null;
    size: string | null;
    funding: string | null;
    description: string | null;
    pain_points: string[];
    recent_news: string | null;
  };
}

const EMPTY_DB_ENRICHMENT: DbEnrichment = {
  source: null,
  prior_outreach_attempts: 0,
  prior_meeting_history: [],
  prior_notes: null,
  company_intel: {
    industry: null,
    size: null,
    funding: null,
    description: null,
    pain_points: [],
    recent_news: null,
  },
};

async function fetchLeadDatabaseContext(
  tenantId: string,
  linkedinUrl: string,
): Promise<DbEnrichment> {
  if (!linkedinUrl) return EMPTY_DB_ENRICHMENT;
  try {
    return await withTenant(tenantId, async (tx) => {
      const [contact] = await tx
        .select()
        .from(contacts)
        .where(
          and(
            eq(contacts.tenantId, tenantId),
            eq(contacts.linkedinUrl, linkedinUrl),
          ),
        )
        .limit(1);

      if (!contact) return EMPTY_DB_ENRICHMENT;

      const [outreachCountRow] = await tx
        .select({ value: count() })
        .from(outreachEmails)
        .where(eq(outreachEmails.contactId, contact.id));

      const interviewRows = await tx
        .select({
          scheduledAt: interviews.scheduledAt,
          status: interviews.status,
        })
        .from(interviews)
        .where(eq(interviews.contactId, contact.id));

      let companyIntel = EMPTY_DB_ENRICHMENT.company_intel;
      if (contact.companyId) {
        const [company] = await tx
          .select()
          .from(companies)
          .where(eq(companies.id, contact.companyId))
          .limit(1);
        if (company) {
          const rawData = (company.rawData ?? {}) as Record<string, unknown>;
          const recentNews =
            (typeof rawData.news === 'string' && rawData.news) ||
            (typeof rawData.recentNews === 'string' && rawData.recentNews) ||
            null;
          const painPoints = Array.isArray(company.painPoints)
            ? company.painPoints
                .map((p) => (p && typeof p.description === 'string' ? p.description : ''))
                .filter(Boolean)
                .slice(0, 3)
            : [];
          companyIntel = {
            industry: company.industry ?? null,
            size: company.size ?? null,
            funding: company.funding ?? null,
            description: company.description ?? null,
            pain_points: painPoints,
            recent_news: recentNews,
          };
        }
      }

      const contactRawData = (contact.rawData ?? {}) as Record<string, unknown>;
      const priorNotes =
        typeof contactRawData.notes === 'string' && contactRawData.notes ? contactRawData.notes : null;

      return {
        source: contact.source ?? null,
        prior_outreach_attempts: Number(outreachCountRow?.value ?? 0),
        prior_meeting_history: interviewRows
          .filter((r) => r.scheduledAt)
          .map((r) => ({
            scheduled_at: r.scheduledAt!.toISOString(),
            status: r.status,
          })),
        prior_notes: priorNotes,
        company_intel: companyIntel,
      };
    });
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), tenantId, linkedinUrl },
      'copilot_db_enrichment_failed (failing open with empty enrichment)',
    );
    return EMPTY_DB_ENRICHMENT;
  }
}

// ─── ExtractedContext builder ───────────────────────────────────────

interface ClassifierSignals {
  topics_discussed: string[];
  recipient_unanswered_questions: string[];
  sender_unanswered_questions: string[];
  expressed_interests: string[];
  expressed_concerns: string[];
  expressed_constraints: string[];
}

const EMPTY_SIGNALS: ClassifierSignals = {
  topics_discussed: [],
  recipient_unanswered_questions: [],
  sender_unanswered_questions: [],
  expressed_interests: [],
  expressed_concerns: [],
  expressed_constraints: [],
};

function buildExtractedContext(
  input: CopilotInput,
  signals: ClassifierSignals | undefined,
  dbCtx: DbEnrichment,
): ExtractedContext {
  const history = input.conversationHistory;
  const inboundMessages = history.filter((m) => m.direction === 'inbound');
  const allInboundText = inboundMessages.map((m) => m.body).join(' ');
  const now = new Date();

  const firstAt = history
    .map((m) => new Date(m.sentAt))
    .filter((d) => !isNaN(d.getTime()))
    .sort((a, b) => a.getTime() - b.getTime())[0];
  const lastInboundAt = [...history]
    .reverse()
    .find((m) => m.direction === 'inbound');
  const lastInboundDate = lastInboundAt ? new Date(lastInboundAt.sentAt) : null;

  const s = signals ?? EMPTY_SIGNALS;

  return {
    recipient_tone: detectTone(allInboundText),
    recipient_avg_message_length_words: avgWords(inboundMessages),
    recipient_response_speed: estimateResponseSpeed(history),

    is_first_interaction: inboundMessages.length === 0,
    days_since_first_message: firstAt ? daysBetween(now, firstAt) : 0,
    days_since_last_inbound: lastInboundDate && !isNaN(lastInboundDate.getTime())
      ? daysBetween(now, lastInboundDate)
      : null,
    total_exchanges: history.length,

    topics_discussed: s.topics_discussed,
    recipient_unanswered_questions: s.recipient_unanswered_questions,
    sender_unanswered_questions: s.sender_unanswered_questions,
    expressed_interests: s.expressed_interests,
    expressed_concerns: s.expressed_concerns,
    expressed_constraints: s.expressed_constraints,

    source: dbCtx.source,
    prior_outreach_attempts: dbCtx.prior_outreach_attempts,
    prior_meeting_history: dbCtx.prior_meeting_history,
    prior_notes: dbCtx.prior_notes,
    company_intel: dbCtx.company_intel,
  };
}

// ─── Classifier + generator ─────────────────────────────────────────

interface ClassifierRaw {
  intent?: string;
  confidence?: number;
  reasoning?: string;
  key_signal?: string;
  topics_discussed?: string[];
  recipient_unanswered_questions?: string[];
  sender_unanswered_questions?: string[];
  expressed_interests?: string[];
  expressed_concerns?: string[];
  expressed_constraints?: string[];
}

interface ReplyRaw {
  body?: string;
  intent_detected?: string;
  strategy_used?: string;
  confidence?: number;
  alternative_short_version?: string;
  used_verified_facts?: string[];
  qualitative_claims_used?: string[];
}

function sanitizeStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((x): x is string => typeof x === 'string')
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 8);
}

async function classifyIntent(
  tenantId: string,
  input: CopilotInput,
): Promise<{ intent: CopilotIntent; confidence: number; signals: ClassifierSignals }> {
  const messages: ChatMessage[] = [
    { role: 'system', content: CLASSIFIER_SYSTEM_PROMPT },
    {
      role: 'user',
      content: buildClassifierUserPrompt({
        conversationHistory: input.conversationHistory,
        recipientName: input.recipientName,
      }),
    },
  ];
  const raw = await extractJSON<ClassifierRaw>(tenantId, messages, 2, {
    model: env.BEDROCK_EMAIL_MODEL,
    temperature: 0.2, // intent classification — be deterministic
    max_tokens: 500,
  });
  const intent = isCopilotIntent(raw.intent) ? raw.intent : 'interested_qualifying';
  const confidence = typeof raw.confidence === 'number' ? Math.max(0, Math.min(100, Math.round(raw.confidence))) : 50;
  const signals: ClassifierSignals = {
    topics_discussed: sanitizeStringArray(raw.topics_discussed),
    recipient_unanswered_questions: sanitizeStringArray(raw.recipient_unanswered_questions),
    sender_unanswered_questions: sanitizeStringArray(raw.sender_unanswered_questions),
    expressed_interests: sanitizeStringArray(raw.expressed_interests),
    expressed_concerns: sanitizeStringArray(raw.expressed_concerns),
    expressed_constraints: sanitizeStringArray(raw.expressed_constraints),
  };
  return { intent, confidence, signals };
}

interface GeneratedReply {
  body: string;
  alternative?: string;
  confidence: number;
  needsReview: boolean;
  used_verified_facts: string[];
  qualitative_claims_used: string[];
}

async function generateReply(
  tenantId: string,
  input: CopilotInput,
  intent: CopilotIntent,
  tenantConfig: MessagingConfig,
  mode: CopilotMode,
  extractedContext: ExtractedContext,
): Promise<GeneratedReply> {
  const strategy = INTENT_REPLY_STRATEGIES[intent];
  const userPrompt = buildReplyUserPrompt({
    conversationHistory: input.conversationHistory,
    recipientName: input.recipientName,
    recipientCompany: input.recipientCompany,
    recipientTitle: input.recipientTitle,
    intent,
    strategy,
    tenantConfig,
    mode,
    existingDraft: input.existingDraft,
    extractedContext,
  });
  return runReplyGeneration(tenantId, userPrompt);
}

async function generateFollowup(
  tenantId: string,
  input: CopilotInput,
  messageType: MessageType,
  tenantConfig: MessagingConfig,
  extractedContext: ExtractedContext,
): Promise<GeneratedReply> {
  const userPrompt = buildFollowupUserPrompt({
    conversationHistory: input.conversationHistory,
    recipientName: input.recipientName,
    recipientCompany: input.recipientCompany,
    recipientTitle: input.recipientTitle,
    tenantConfig,
    messageType,
    messageTypeInstructions: MESSAGE_TYPE_INSTRUCTIONS[messageType],
    extractedContext,
  });
  return runReplyGeneration(tenantId, userPrompt);
}

/**
 * Shared Kimi-call + forbidden-phrase-guard pipeline used by both reply
 * and follow-up modes. The system prompt and JSON output schema are
 * identical across modes; only the user prompt differs.
 */
async function runReplyGeneration(
  tenantId: string,
  userPrompt: string,
): Promise<GeneratedReply> {
  const baseMessages: ChatMessage[] = [
    { role: 'system', content: REPLY_SYSTEM_PROMPT },
    { role: 'user', content: userPrompt },
  ];

  let raw = await extractJSON<ReplyRaw>(tenantId, baseMessages, 2, {
    model: env.BEDROCK_EMAIL_MODEL,
    temperature: env.BEDROCK_EMAIL_TEMPERATURE,
    max_tokens: 500,
  });
  let body = (raw.body ?? '').trim();
  let needsReview = false;

  // Forbidden-phrase scan with one retry — mirrors cold-email-drafter pattern.
  let hit = findForbidden(body);
  if (hit) {
    logger.warn({ tenantId, forbiddenPhrase: hit }, 'copilot_forbidden_phrase: regenerating once');
    const retry: ChatMessage[] = [
      ...baseMessages,
      { role: 'assistant', content: JSON.stringify(raw) },
      {
        role: 'user',
        content: `Your previous draft tripped a forbidden pattern: "${hit}". Rewrite without that phrase or anything matching the same template. Return ONLY the JSON object.`,
      },
    ];
    raw = await extractJSON<ReplyRaw>(tenantId, retry, 2, {
      model: env.BEDROCK_EMAIL_MODEL,
      temperature: env.BEDROCK_EMAIL_TEMPERATURE,
      max_tokens: 500,
    });
    body = (raw.body ?? '').trim();
    hit = findForbidden(body);
    if (hit) {
      needsReview = true;
      logger.warn({ tenantId, forbiddenPhrase: hit }, 'copilot_forbidden_phrase_after_retry: returning with needsReview');
    }
  }

  return {
    body,
    alternative: raw.alternative_short_version?.trim() || undefined,
    confidence: typeof raw.confidence === 'number' ? Math.max(0, Math.min(100, Math.round(raw.confidence))) : 70,
    needsReview,
    used_verified_facts: sanitizeStringArray(raw.used_verified_facts),
    qualitative_claims_used: sanitizeStringArray(raw.qualitative_claims_used),
  };
}

/**
 * Find-or-create a linkedin_conversations row for the recipient. Updates
 * counts + last_message_at based on the incoming history.
 */
async function upsertConversation(
  input: CopilotInput,
): Promise<{ conversationId: string; totalMessages: number }> {
  return withTenant(input.tenantId, async (tx) => {
    const [existing] = await tx
      .select()
      .from(linkedinConversations)
      .where(
        and(
          eq(linkedinConversations.tenantId, input.tenantId),
          eq(linkedinConversations.recipientLinkedinUrl, input.recipientLinkedinUrl),
        ),
      )
      .limit(1);

    const inbound = input.conversationHistory.filter((m) => m.direction === 'inbound').length;
    const outbound = input.conversationHistory.filter((m) => m.direction === 'outbound').length;
    const total = input.conversationHistory.length;
    const sortedTimes = input.conversationHistory
      .map((m) => new Date(m.sentAt))
      .filter((d) => !isNaN(d.getTime()))
      .sort((a, b) => a.getTime() - b.getTime());
    const firstAt = sortedTimes[0] ?? new Date();
    const lastAt = sortedTimes[sortedTimes.length - 1] ?? new Date();

    // Best-effort: link to a contacts row if one already exists.
    let linkedContactId: string | null = null;
    if (input.recipientLinkedinUrl) {
      const [c] = await tx
        .select({ id: contacts.id })
        .from(contacts)
        .where(
          and(
            eq(contacts.tenantId, input.tenantId),
            eq(contacts.linkedinUrl, input.recipientLinkedinUrl),
          ),
        )
        .limit(1);
      linkedContactId = c?.id ?? null;
    }

    if (existing) {
      await tx
        .update(linkedinConversations)
        .set({
          recipientName: input.recipientName,
          recipientCompany: input.recipientCompany ?? existing.recipientCompany,
          recipientTitle: input.recipientTitle ?? existing.recipientTitle,
          contactId: linkedContactId ?? existing.contactId,
          totalMessages: total,
          outboundCount: outbound,
          inboundCount: inbound,
          firstMessageAt: existing.firstMessageAt ?? firstAt,
          lastMessageAt: lastAt,
          updatedAt: new Date(),
        })
        .where(eq(linkedinConversations.id, existing.id));
      return { conversationId: existing.id, totalMessages: total };
    }

    const [created] = await tx
      .insert(linkedinConversations)
      .values({
        tenantId: input.tenantId,
        userId: input.userId,
        recipientLinkedinUrl: input.recipientLinkedinUrl,
        recipientName: input.recipientName,
        recipientCompany: input.recipientCompany,
        recipientTitle: input.recipientTitle,
        contactId: linkedContactId,
        firstMessageAt: firstAt,
        lastMessageAt: lastAt,
        totalMessages: total,
        outboundCount: outbound,
        inboundCount: inbound,
      })
      .returning({ id: linkedinConversations.id });
    return { conversationId: created.id, totalMessages: total };
  });
}

/**
 * Reconcile scraped conversation history with the persisted message log.
 * Dedup is by (direction, body, sentAt) — adequate for an audit log;
 * doesn't try to be exact for re-edited messages.
 */
async function reconcileMessages(
  tenantId: string,
  conversationId: string,
  history: CopilotInput['conversationHistory'],
): Promise<void> {
  if (history.length === 0) return;
  // Persist new rows AND collect which ones to log as timeline events.
  // The conversation may not yet be linked to a contacts row, in which
  // case we skip the event log (timeline lives on a contact_id key).
  const newRows = await withTenant(tenantId, async (tx) => {
    const existing = await tx
      .select({ direction: linkedinMessages.direction, body: linkedinMessages.body, sentAt: linkedinMessages.sentAt })
      .from(linkedinMessages)
      .where(eq(linkedinMessages.conversationId, conversationId));
    const seen = new Set(
      existing.map((m) => `${m.direction}|${m.body}|${m.sentAt?.toISOString() ?? ''}`),
    );
    const rows = history
      .map((m) => ({ ...m, sentAtDate: new Date(m.sentAt) }))
      .filter((m) => !isNaN(m.sentAtDate.getTime()))
      .filter((m) => !seen.has(`${m.direction}|${m.body}|${m.sentAtDate.toISOString()}`))
      .map((m) => ({
        conversationId,
        direction: m.direction,
        body: m.body,
        sentAt: m.sentAtDate,
      }));
    if (rows.length > 0) {
      await tx.insert(linkedinMessages).values(rows);
    }
    return rows;
  });

  if (newRows.length === 0) return;

  // Look up the contact link on the conversation. If the conversation has
  // no contactId, no timeline events are logged — that's the right call
  // because the dashboard's timeline view is contact-scoped.
  try {
    const [conv] = await withTenant(tenantId, async (tx) => {
      return tx
        .select({ contactId: linkedinConversations.contactId })
        .from(linkedinConversations)
        .where(eq(linkedinConversations.id, conversationId))
        .limit(1);
    });
    const contactId = conv?.contactId;
    if (!contactId) return;

    let lastInboundEventId: string | undefined;
    for (const row of newRows) {
      // Only inbound messages: outbound is logged when the extension
      // confirms the human-sent send (future stage).
      if (row.direction !== 'inbound') continue;
      try {
        const { id } = await logEvent({
          tenantId,
          contactId,
          type: 'linkedin_message_received',
          eventCategory: 'response',
          actorType: 'recipient',
          title: 'LinkedIn message received',
          description: row.body.slice(0, 500),
          occurredAt: row.sentAt,
          metadata: {
            conversationId,
            channel: 'linkedin_dm',
          },
        });
        lastInboundEventId = id;
      } catch (err) {
        logger.warn({ err, conversationId, contactId }, 'Failed to log linkedin_message_received event');
      }
    }

    if (lastInboundEventId) {
      try {
        await recordResponse({ tenantId, contactId, channel: 'linkedin_dm' });
      } catch (err) {
        logger.warn({ err, contactId }, 'recordResponse failed after inbound DM');
      }
      try {
        await microTriage({ tenantId, contactId, triggerEventId: lastInboundEventId });
      } catch (err) {
        logger.warn({ err, contactId }, 'microTriage failed after inbound DM');
      }
    }
  } catch (err) {
    logger.warn({ err, conversationId }, 'Failed to resolve contact for timeline event');
  }
}

export async function generateReplyDraft(input: CopilotInput): Promise<CopilotResult> {
  // ─── Fail-loud gates ──────────────────────────────────────────────
  // Refuse to generate when context is missing — better an error than a
  // fabricated reply. See feedback_fail_loud_over_fabricate memory.
  if (input.conversationHistory.length === 0) {
    throw new ValidationError('No messages found in this thread.');
  }
  // Allow single-message threads — they're a valid follow-up scenario
  // (user sent cold outreach, recipient hasn't replied yet). The scraper
  // now deduplicates correctly, so 1 entry = 1 real message.
  // Sanity check: ≥3 messages all tagged inbound = scraper failure (a
  // real conversation must contain at least one outbound message from
  // the user). Fail loud rather than hallucinate a reply.
  if (input.conversationHistory.length >= 3) {
    const allInbound = input.conversationHistory.every((m) => m.direction === 'inbound');
    if (allInbound) {
      throw new ValidationError(
        'Scrape error: all messages tagged as received. LinkedIn DOM may have changed. Please refresh and try again.',
      );
    }
  }

  const inboundCount = input.conversationHistory.filter((m) => m.direction === 'inbound').length;
  const outboundCount = input.conversationHistory.filter((m) => m.direction === 'outbound').length;
  const last = input.conversationHistory[input.conversationHistory.length - 1];

  // ─── Mode validation (existing rewrite modes from the menu) ──────
  const mode: CopilotMode = input.mode ?? 'generate_from_scratch';
  if (!isCopilotMode(mode)) {
    throw new ValidationError(
      `Invalid mode "${input.mode}". Allowed: ${COPILOT_MODES.join(', ')}.`,
    );
  }
  if (mode !== 'generate_from_scratch' && !(input.existingDraft && input.existingDraft.trim())) {
    throw new ValidationError(
      `Mode "${mode}" requires existingDraft (the user's in-progress text).`,
    );
  }

  await enforceRateLimit(input.tenantId, input.userId);

  // Resolve messaging config — auto-derives from Company Profile +
  // Products on first call and persists. See messaging-config.service.ts.
  const config = await ensureMessagingConfig(input.tenantId);
  if (!config.value_prop || !config.value_prop.trim()) {
    throw new ValidationError(
      'Configure your messaging at /settings/messaging or at least your Company Profile at /settings/company first. value_prop is required before drafting replies.',
    );
  }
  // Sign reply drafts with the account holder's actual first name.
  // [[feedback_fail_loud_over_fabricate]]
  config.sender_name = await resolveSenderFirstName(input.tenantId);

  // ─── Conversation mode router ────────────────────────────────────
  // 'reply'    → last message inbound; classify intent + generate reply.
  // 'followup' → last message outbound; no reply received yet; route to
  //              a Studio-style follow-up bump (first/second_followup).
  const conversationMode: ConversationMode =
    last.direction === 'inbound' ? 'reply' : 'followup';

  // 1. Persist conversation + messages.
  const { conversationId, totalMessages } = await upsertConversation(input);
  await reconcileMessages(input.tenantId, conversationId, input.conversationHistory);

  // 2. DB enrichment (best-effort, fails open).
  const dbCtx = await fetchLeadDatabaseContext(input.tenantId, input.recipientLinkedinUrl);

  let draftBody: string;
  let alternativeShortVersion: string | undefined;
  let needsReview: boolean | undefined;
  let confidence: number;
  let intentForResponse: CopilotIntent | string;
  let strategyForResponse: string;
  let classifiedIntent: CopilotIntent | null = null;
  let classifyConfidence: number | undefined;
  let usedVerifiedFacts: string[] = [];
  let qualitativeClaimsUsed: string[] = [];

  if (conversationMode === 'reply') {
    // Kimi call #1 — intent classification + signal extraction.
    const cls = await classifyIntent(input.tenantId, input);
    classifiedIntent = cls.intent;
    classifyConfidence = cls.confidence;
    const extractedContext = buildExtractedContext(input, cls.signals, dbCtx);
    // Kimi call #2 — reply draft with LAYER 1 / LAYER 2 prompt.
    const reply = await generateReply(input.tenantId, input, cls.intent, config, mode, extractedContext);
    draftBody = reply.body;
    alternativeShortVersion = reply.alternative;
    needsReview = reply.needsReview || undefined;
    confidence = Math.min(reply.confidence, cls.confidence);
    intentForResponse = cls.intent;
    strategyForResponse = INTENT_REPLY_STRATEGIES[cls.intent].split('\n')[0].trim();
    usedVerifiedFacts = reply.used_verified_facts;
    qualitativeClaimsUsed = reply.qualitative_claims_used;
  } else {
    // Follow-up: skip classification (no incoming to classify). Build
    // ExtractedContext with empty signal arrays — relationship state +
    // DB enrichment still populate. Pick first/second_followup based on
    // how many outbound messages have already gone without a reply.
    const extractedContext = buildExtractedContext(input, undefined, dbCtx);
    const followupType: MessageType = outboundCount >= 2 ? 'second_followup' : 'first_followup';
    const reply = await generateFollowup(input.tenantId, input, followupType, config, extractedContext);
    draftBody = reply.body;
    alternativeShortVersion = reply.alternative;
    needsReview = reply.needsReview || undefined;
    confidence = reply.confidence;
    intentForResponse = followupType;
    strategyForResponse = `Follow-up bump (${followupType})`;
    usedVerifiedFacts = reply.used_verified_facts;
    qualitativeClaimsUsed = reply.qualitative_claims_used;
  }

  // Persist the draft. Best-effort — failures are logged, not thrown.
  try {
    await withTenant(input.tenantId, async (tx) => {
      await tx.insert(linkedinMessages).values({
        conversationId,
        direction: 'outbound',
        body: draftBody,
        sentAt: new Date(),
        classifiedIntent: classifiedIntent ?? (conversationMode === 'followup' ? `followup:${intentForResponse}` : undefined),
        classificationConfidence: classifyConfidence,
        isCopilotDraft: true,
        // Tag with conversation mode so analytics can separate
        // follow-up bumps from intent-classified replies.
        draftStrategy: `${conversationMode}:${intentForResponse}|${strategyForResponse}`.slice(0, 200),
      });
    });
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'copilot_draft_persist_failed (returning anyway)');
  }

  logger.info(
    {
      tenantId: input.tenantId,
      conversationId,
      conversationMode,
      intent: intentForResponse,
      classifyConfidence,
      replyConfidence: confidence,
      needsReview,
      bodyLen: draftBody.length,
      model: env.BEDROCK_EMAIL_MODEL,
      inboundCount,
      outboundCount,
      usedVerifiedFacts,
      qualitativeClaimsUsed,
      priorOutreachAttempts: dbCtx.prior_outreach_attempts,
      companyIndustry: dbCtx.company_intel.industry,
    },
    'copilot_reply_drafted',
  );

  return {
    draft: {
      body: draftBody,
      intent: intentForResponse,
      strategy: strategyForResponse,
      confidence,
      alternativeShortVersion,
      needsReview,
      model: env.BEDROCK_EMAIL_MODEL,
      conversationMode,
    },
    conversation: {
      id: conversationId,
      totalMessages,
    },
  };
}

// Re-export intent list so the route layer can use it for validation.
export { COPILOT_INTENTS };
