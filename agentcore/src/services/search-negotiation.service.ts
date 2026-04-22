import { eq, and } from 'drizzle-orm';
import { withTenant } from '../config/database.js';
import { masterAgents, agentMessages } from '../db/schema/index.js';
import { pubRedis } from '../queues/setup.js';
import { extractJSON, SMART_MODEL } from '../tools/together-ai.tool.js';
import { searchLinkedInJobs } from '../tools/linkedin-jobs.tool.js';
import { NotFoundError, ValidationError } from '../utils/errors.js';
import logger from '../utils/logger.js';

export type SearchChoiceId = 'continue' | 'broaden_manual' | 'broaden_auto';

export interface SearchChoicePayload {
  choiceId: SearchChoiceId;
  userTerm?: string;
}

export interface SearchChoiceOutcome {
  choiceId: SearchChoiceId;
  appliedTerm: string | null;
  totalFound: number;
  locationCount: number;
  message: string;
}

interface PendingSearchChoiceConfig {
  jobTitle: string;
  locations: string[];
  perLocation?: Array<{ location: string; count: number }>;
  firedAt?: string;
  totalFound?: number;
}

async function emitAgentMessage(
  tenantId: string,
  masterAgentId: string,
  messageType: string,
  content: Record<string, unknown>,
): Promise<void> {
  try {
    const [msg] = await withTenant(tenantId, async (tx) => {
      return tx.insert(agentMessages).values({
        tenantId,
        masterAgentId,
        fromAgent: 'master',
        toAgent: undefined,
        messageType,
        content,
      }).returning();
    });

    await pubRedis.publish(
      `agent-events:${tenantId}`,
      JSON.stringify({
        event: 'agent:message',
        data: {
          id: msg?.id,
          masterAgentId,
          fromAgent: 'master',
          messageType,
          content,
        },
        agentType: 'master',
        timestamp: new Date().toISOString(),
      }),
    );
  } catch (err) {
    logger.warn({ err, tenantId, masterAgentId, messageType }, 'Failed to emit negotiation agent message');
  }
}

async function runSearch(
  tenantId: string,
  masterAgentId: string,
  jobTitle: string,
  locations: string[],
): Promise<{ totalFound: number; perLocation: Array<{ location: string; count: number }> }> {
  const LINKEDIN_SCRAPE_DELAY_MS = 8000;
  let totalFound = 0;
  const perLocation: Array<{ location: string; count: number }> = [];
  let first = true;

  for (const loc of locations) {
    if (!first) {
      await new Promise(r => setTimeout(r, LINKEDIN_SCRAPE_DELAY_MS));
    }
    first = false;
    try {
      const result = await searchLinkedInJobs(tenantId, jobTitle, loc, masterAgentId);
      totalFound += result.companies.length;
      perLocation.push({ location: loc, count: result.companies.length });
    } catch (err) {
      logger.warn({ err, tenantId, masterAgentId, location: loc, jobTitle }, 'search-negotiation: scrape failed');
      perLocation.push({ location: loc, count: 0 });
    }
  }

  return { totalFound, perLocation };
}

async function suggestBroaderTerm(
  tenantId: string,
  jobTitle: string,
  totalFound: number,
  locations: string[],
): Promise<string | null> {
  try {
    const systemPrompt = `You are a B2B recruitment + sales search strategist. Suggest broader keyword variants for a LinkedIn Jobs search that returned few results, preserving the user's original intent.

Output STRICT JSON only: { "suggestions": string[] }  (no markdown, no explanation)

Rules:
- Return exactly 3 variants.
- Each variant must be a concrete job title / keyword phrase, not a sentence.
- Order from "slightly broader" to "much broader". Take the most likely-to-work variant first.
- Preserve the domain of the original (backend, frontend, blockchain, sales, etc.).
- If the original is already generic, return 3 near-synonyms.`;

    const result = await extractJSON<{ suggestions: string[] }>(
      tenantId,
      [
        { role: 'system', content: systemPrompt },
        {
          role: 'user',
          content: `Original jobTitle: "${jobTitle}"\nReturned: ${totalFound} results across locations: ${locations.join(', ')}\nSuggest 3 broader variants.`,
        },
      ],
      2,
      { model: SMART_MODEL, temperature: 0.4, max_tokens: 400 },
    );

    const first = result?.suggestions?.find(s => typeof s === 'string' && s.trim().length > 0);
    return first?.trim() ?? null;
  } catch (err) {
    logger.warn({ err, tenantId, jobTitle }, 'suggestBroaderTerm failed');
    return null;
  }
}

/**
 * Apply a user-picked (or free-text-inferred) negotiation choice for a thin
 * LinkedIn Jobs search. Shared between:
 *   1) POST /master-agents/:id/search-choice (button clicks)
 *   2) chat.service.ts free-text fallback (typed broader terms)
 */
export async function applySearchChoice(
  tenantId: string,
  masterAgentId: string,
  payload: SearchChoicePayload,
): Promise<SearchChoiceOutcome> {
  const [row] = await withTenant(tenantId, async (tx) => {
    return tx.select({ config: masterAgents.config }).from(masterAgents)
      .where(and(eq(masterAgents.id, masterAgentId), eq(masterAgents.tenantId, tenantId)))
      .limit(1);
  });
  if (!row) throw new NotFoundError('MasterAgent', masterAgentId);

  const config = (row.config as Record<string, unknown>) ?? {};
  const pending = config.pendingSearchChoice as PendingSearchChoiceConfig | undefined;
  if (!pending) {
    throw new ValidationError('No pending search choice on this master agent.');
  }
  const locations = pending.locations?.length ? pending.locations : [];
  if (!locations.length) {
    throw new ValidationError('Pending search choice has no locations to re-search.');
  }

  const clearPending = async (extra?: Record<string, unknown>) => {
    const { pendingSearchChoice: _omit, ...rest } = config as Record<string, unknown>;
    await withTenant(tenantId, async (tx) => {
      await tx.update(masterAgents)
        .set({ config: { ...rest, ...(extra ?? {}) }, updatedAt: new Date() })
        .where(and(eq(masterAgents.id, masterAgentId), eq(masterAgents.tenantId, tenantId)));
    });
  };

  if (payload.choiceId === 'continue') {
    await clearPending();
    const msg = `Continuing with ${pending.totalFound ?? 0} companies from "${pending.jobTitle}".`;
    await emitAgentMessage(tenantId, masterAgentId, 'system_alert', {
      action: 'search_choice_continue',
      severity: 'info',
      message: msg,
    });
    return {
      choiceId: 'continue',
      appliedTerm: null,
      totalFound: pending.totalFound ?? 0,
      locationCount: locations.length,
      message: msg,
    };
  }

  if (payload.choiceId === 'broaden_manual') {
    const userTerm = payload.userTerm?.trim();
    if (!userTerm) {
      throw new ValidationError('broaden_manual requires a userTerm.');
    }
    if (userTerm.length > 120) {
      throw new ValidationError('userTerm is too long.');
    }

    const { totalFound, perLocation } = await runSearch(tenantId, masterAgentId, userTerm, locations);

    if (totalFound < 10) {
      // Still thin — re-open the negotiation with the new term as the context.
      const nextPending: PendingSearchChoiceConfig = {
        jobTitle: userTerm,
        locations,
        perLocation,
        firedAt: new Date().toISOString(),
        totalFound,
      };
      await withTenant(tenantId, async (tx) => {
        await tx.update(masterAgents)
          .set({ config: { ...config, pendingSearchChoice: nextPending }, updatedAt: new Date() })
          .where(and(eq(masterAgents.id, masterAgentId), eq(masterAgents.tenantId, tenantId)));
      });
      const outcome: 'empty' | 'thin' = totalFound === 0 ? 'empty' : 'thin';
      await emitAgentMessage(tenantId, masterAgentId, 'system_alert', {
        action: 'search_quality_low',
        severity: 'warning',
        outcome,
        totalFound,
        jobTitle: userTerm,
        perLocation,
        message:
          outcome === 'empty'
            ? `Still 0 companies for "${userTerm}" across ${locations.length} location(s). Want to try a broader term, or let me pick one?`
            : `Only ${totalFound} companies for "${userTerm}". Still thin — broaden again, or continue with what we have?`,
        choices: [
          { id: 'continue', label: 'Continue with what I have' },
          { id: 'broaden_manual', label: 'Let me type a broader term' },
          { id: 'broaden_auto', label: 'Broaden it for me' },
        ],
      });
    } else {
      await clearPending();
      await emitAgentMessage(tenantId, masterAgentId, 'system_alert', {
        action: 'broaden_manual_applied',
        severity: 'info',
        appliedTerm: userTerm,
        totalFound,
        perLocation,
        message: `Searched "${userTerm}" → found ${totalFound} companies across ${locations.length} location(s).`,
      });
    }

    return {
      choiceId: 'broaden_manual',
      appliedTerm: userTerm,
      totalFound,
      locationCount: locations.length,
      message: `Searched "${userTerm}" → ${totalFound} companies.`,
    };
  }

  // broaden_auto
  const suggestion = await suggestBroaderTerm(tenantId, pending.jobTitle, pending.totalFound ?? 0, locations);
  if (!suggestion) {
    await emitAgentMessage(tenantId, masterAgentId, 'system_alert', {
      action: 'broaden_auto_failed',
      severity: 'warning',
      originalTerm: pending.jobTitle,
      message: `Couldn't generate a broader variant for "${pending.jobTitle}". Try typing one yourself.`,
    });
    return {
      choiceId: 'broaden_auto',
      appliedTerm: null,
      totalFound: pending.totalFound ?? 0,
      locationCount: locations.length,
      message: 'No suggestion generated.',
    };
  }

  const { totalFound, perLocation } = await runSearch(tenantId, masterAgentId, suggestion, locations);
  await clearPending();
  await emitAgentMessage(tenantId, masterAgentId, 'system_alert', {
    action: 'broaden_auto_applied',
    severity: 'info',
    originalTerm: pending.jobTitle,
    appliedTerm: suggestion,
    totalFound,
    perLocation,
    message: `Tried "${suggestion}" → found ${totalFound} companies across ${locations.length} location(s).`,
  });

  return {
    choiceId: 'broaden_auto',
    appliedTerm: suggestion,
    totalFound,
    locationCount: locations.length,
    message: `Auto-broadened "${pending.jobTitle}" → "${suggestion}" (${totalFound} companies).`,
  };
}
