import { eq, and, asc } from 'drizzle-orm';
import { withTenant } from '../config/database.js';
import {
  contacts,
  companies,
  campaignContacts,
  emailsSent,
  masterAgents,
  campaigns,
  agentActivityLog,
} from '../db/schema/index.js';
import { extractJSON, SMART_MODEL } from '../tools/together-ai.tool.js';
import {
  buildFollowupSystemPrompt,
  buildFollowupUserPrompt,
  type FollowupGeneration,
  type FollowupPromptParams,
  type FollowupSignal,
  type FollowupSeller,
  type FollowupContact,
  type FollowupTouch,
} from '../prompts/followup-generation.prompt.js';
import logger from '../utils/logger.js';

interface GenerateParams {
  campaignContactId: string;
  step: { stepNumber: number; stepType: string; id: string };
  tenantId: string;
}

interface CompanyTriageVerdict {
  signals?: {
    hiring_signals?: Array<{ claim: string; citation: string }>;
    funding_signals?: Array<{ claim: string; citation: string }>;
    growth_signals?: Array<{ claim: string; citation: string }>;
    tech_signals?: Array<{ claim: string; citation: string }>;
  };
}

function flattenSignals(rawData: Record<string, unknown> | null | undefined): FollowupSignal[] {
  const triage = (rawData?.triage as CompanyTriageVerdict | undefined);
  if (!triage?.signals) return [];
  const out: FollowupSignal[] = [];
  for (const key of ['hiring_signals', 'funding_signals', 'growth_signals', 'tech_signals'] as const) {
    const arr = triage.signals[key];
    if (Array.isArray(arr)) {
      for (const s of arr) {
        if (s?.claim && s?.citation) out.push({ claim: s.claim, citation: s.citation });
      }
    }
  }
  return out;
}

function isValidGeneration(v: unknown): v is FollowupGeneration {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return typeof o.subject === 'string' && o.subject.length > 0
      && typeof o.body === 'string' && o.body.length > 0
      && typeof o.angleUsed === 'string';
}

/**
 * Templated fallback emails — used when the LLM call fails or returns
 * malformed JSON twice in a row. Generic but never fabricates company facts.
 */
function deterministicFallback(stepType: string, originalSubject: string, contact: FollowupContact): FollowupGeneration {
  const firstName = contact.firstName || 'there';
  if (stepType === 'followup_breakup') {
    return {
      subject: `Closing the loop on ${originalSubject.replace(/^Re:\s*/i, '').slice(0, 60)}`,
      body: `Hi ${firstName},\n\nClosing the loop on this — if not the right time, no worries at all. I'll stop reaching out.\n\nIf the timing changes, just reply to any of these and I'll pick it back up.`,
      angleUsed: 'fallback_template_breakup',
    };
  }
  if (stepType === 'followup_value') {
    return {
      subject: `Re: ${originalSubject.replace(/^Re:\s*/i, '')}`,
      body: `Hi ${firstName},\n\nWanted to share something we've seen with similar teams in case it's useful. Happy to send a one-pager if you're curious — otherwise no worries.`,
      angleUsed: 'fallback_template_value',
    };
  }
  // followup_short / custom default
  return {
    subject: `Re: ${originalSubject.replace(/^Re:\s*/i, '')}`,
    body: `Hi ${firstName},\n\nQuick check on the note from last week — worth a 15-minute chat, or should I close the loop?`,
    angleUsed: 'fallback_template_short',
  };
}

async function logFollowupActivity(
  tenantId: string,
  masterAgentId: string | null,
  action: string,
  status: 'started' | 'completed' | 'failed',
  details: Record<string, unknown>,
): Promise<void> {
  try {
    await withTenant(tenantId, async (tx) => {
      await tx.insert(agentActivityLog).values({
        tenantId,
        masterAgentId,
        agentType: 'outreach',
        action,
        status,
        details,
      });
    });
  } catch (err) {
    logger.debug({ err, action }, 'logFollowupActivity: failed (non-fatal)');
  }
}

export async function generateFollowupContent(params: GenerateParams): Promise<FollowupGeneration> {
  const { campaignContactId, step, tenantId } = params;

  // ─── 1. Load all the inputs the prompt needs in one batched read ──────
  const inputs = await withTenant(tenantId, async (tx) => {
    const [cc] = await tx.select().from(campaignContacts)
      .where(eq(campaignContacts.id, campaignContactId)).limit(1);
    if (!cc) return null;

    const [campaign] = await tx.select().from(campaigns)
      .where(eq(campaigns.id, cc.campaignId)).limit(1);

    const [contact] = await tx.select().from(contacts)
      .where(eq(contacts.id, cc.contactId)).limit(1);
    if (!contact) return null;

    const [company] = contact.companyId
      ? await tx.select().from(companies).where(eq(companies.id, contact.companyId)).limit(1)
      : [undefined];

    const sentRows = await tx.select().from(emailsSent)
      .where(eq(emailsSent.campaignContactId, campaignContactId))
      .orderBy(asc(emailsSent.sentAt));

    const [agent] = campaign?.masterAgentId
      ? await tx.select().from(masterAgents)
          .where(and(eq(masterAgents.id, campaign.masterAgentId), eq(masterAgents.tenantId, tenantId)))
          .limit(1)
      : [undefined];

    return { cc, campaign, contact, company, sentRows, agent };
  });

  if (!inputs) {
    logger.warn({ campaignContactId }, 'generateFollowupContent: campaign_contact / contact missing');
    throw new Error('campaign_contact or contact not found');
  }

  const { cc, campaign, contact, company, sentRows, agent } = inputs;

  // ─── 2. Shape the prompt inputs ───────────────────────────────────────
  const touch1Row = sentRows.find((r) => (r.touchNumber ?? 1) === 1) ?? sentRows[0];
  if (!touch1Row || !touch1Row.subject || !touch1Row.body || !touch1Row.sentAt) {
    logger.warn({ campaignContactId }, 'generateFollowupContent: no usable touch-1 email — using deterministic fallback');
    const fallback = deterministicFallback(
      step.stepType,
      touch1Row?.subject ?? 'our conversation',
      {
        firstName: contact.firstName ?? '',
        lastName: contact.lastName ?? '',
        title: contact.title,
        companyName: contact.companyName,
      },
    );
    await logFollowupActivity(tenantId, campaign?.masterAgentId ?? null, 'followup_content_fallback', 'completed', {
      campaignContactId, reason: 'no_touch1_email', stepNumber: step.stepNumber,
    });
    return fallback;
  }

  const previousFollowups: FollowupTouch[] = sentRows
    .filter((r) => (r.touchNumber ?? 1) > 1 && r.subject && r.body && r.sentAt)
    .map((r) => ({
      touchNumber: r.touchNumber!,
      subject: r.subject!,
      body: r.body!,
      sentAt: r.sentAt!,
    }));

  const seller: FollowupSeller = {
    offering: ((agent?.config as Record<string, unknown> | null)?.['pipelineContext'] as Record<string, unknown> | undefined)
      ? String(((agent!.config as Record<string, unknown>)['pipelineContext'] as Record<string, unknown>)['valueProposition'] ?? agent?.mission ?? 'B2B services')
      : (agent?.mission ?? 'B2B services'),
    senderName: ((agent?.config as Record<string, unknown> | null)?.['senderName'] as string) ?? undefined,
    senderSignatureBlock: ((agent?.config as Record<string, unknown> | null)?.['senderSignatureBlock'] as string) ?? undefined,
  };

  const promptContact: FollowupContact = {
    firstName: contact.firstName ?? '',
    lastName: contact.lastName ?? '',
    title: contact.title,
    companyName: contact.companyName ?? company?.name,
    companyIndustry: company?.industry ?? null,
    companySize: company?.size ?? null,
  };

  const stepType = (step.stepType === 'followup_short' || step.stepType === 'followup_value' || step.stepType === 'followup_breakup')
    ? step.stepType
    : 'custom';

  const promptParams: FollowupPromptParams = {
    seller,
    contact: promptContact,
    touch1: {
      touchNumber: 1,
      subject: touch1Row.subject,
      body: touch1Row.body,
      sentAt: touch1Row.sentAt,
    },
    previousFollowups,
    signals: flattenSignals(company?.rawData as Record<string, unknown> | undefined),
    anglesUsed: cc.sequenceState?.anglesUsed ?? [],
    thisTouch: step.stepNumber,
    stepType,
  };

  // ─── 3. Call the LLM with retry-on-shape ──────────────────────────────
  const messages = [
    { role: 'system' as const, content: buildFollowupSystemPrompt() },
    { role: 'user' as const, content: buildFollowupUserPrompt(promptParams) },
  ];

  let parsed: unknown;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      parsed = await extractJSON<unknown>(tenantId, messages, 2, {
        model: SMART_MODEL,
        temperature: 0.4,
      });
      if (isValidGeneration(parsed)) {
        await logFollowupActivity(tenantId, campaign?.masterAgentId ?? null, 'followup_content_generated', 'completed', {
          campaignContactId, stepNumber: step.stepNumber, attempt, angleUsed: parsed.angleUsed,
        });
        return parsed;
      }
      logger.warn({ campaignContactId, attempt, parsed }, 'generateFollowupContent: invalid shape, retrying');
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err), attempt, campaignContactId }, 'generateFollowupContent: extractJSON failed');
    }
  }

  const fallback = deterministicFallback(stepType, touch1Row.subject, promptContact);
  await logFollowupActivity(tenantId, campaign?.masterAgentId ?? null, 'followup_content_fallback', 'completed', {
    campaignContactId, reason: 'llm_failed_or_invalid', stepNumber: step.stepNumber,
  });
  return fallback;
}
