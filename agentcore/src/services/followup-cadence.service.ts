import { getTenantById } from './tenant.service.js';

/**
 * Follow-up cadence configuration for the CRM-pipeline follow-up engine.
 *
 * A cadence strategy is a list of wait intervals (days) between touches:
 * intervals[0] = anchor touch → follow-up #1, intervals[1] = #1 → #2, etc.
 * The list length is the number of engine follow-ups before a sequence
 * completes (touch 3 is the breakup by convention).
 *
 * Stored per tenant in tenants.settings.followupCadence:
 *   { strategy: 'fast'|'mid'|'slow', intervals?: { fast?: number[], ... } }
 * Per-lead override: followup_sequences.cadence_override names a strategy.
 */
export type CadenceStrategy = 'fast' | 'mid' | 'slow';

export const DEFAULT_INTERVALS: Record<CadenceStrategy, number[]> = {
  fast: [1, 3, 5],
  mid: [2, 4, 8],
  slow: [4, 8, 14],
};

export interface TenantCadence {
  strategy: CadenceStrategy;
  intervals: Record<CadenceStrategy, number[]>;
}

const STRATEGIES: CadenceStrategy[] = ['fast', 'mid', 'slow'];

export function isCadenceStrategy(v: unknown): v is CadenceStrategy {
  return typeof v === 'string' && (STRATEGIES as string[]).includes(v);
}

function sanitizeIntervals(raw: unknown): Partial<Record<CadenceStrategy, number[]>> {
  if (!raw || typeof raw !== 'object') return {};
  const out: Partial<Record<CadenceStrategy, number[]>> = {};
  for (const s of STRATEGIES) {
    const arr = (raw as Record<string, unknown>)[s];
    if (Array.isArray(arr) && arr.length > 0 && arr.every((n) => typeof n === 'number' && n > 0 && n <= 90)) {
      out[s] = arr.map((n) => Math.round(n));
    }
  }
  return out;
}

export async function getTenantCadence(tenantId: string): Promise<TenantCadence> {
  let settings: Record<string, unknown> = {};
  try {
    const tenant = await getTenantById(tenantId);
    settings = (tenant.settings as Record<string, unknown>) ?? {};
  } catch {
    // Tenant lookup failure → defaults; the engine must never crash triage.
  }
  const raw = (settings.followupCadence ?? {}) as Record<string, unknown>;
  return {
    strategy: isCadenceStrategy(raw.strategy) ? raw.strategy : 'mid',
    intervals: { ...DEFAULT_INTERVALS, ...sanitizeIntervals(raw.intervals) },
  };
}

/** Per-lead override (a strategy name) beats the tenant's chosen strategy. */
export function resolveIntervals(cadence: TenantCadence, override?: CadenceStrategy | null): number[] {
  const strategy = override && isCadenceStrategy(override) ? override : cadence.strategy;
  return cadence.intervals[strategy] ?? DEFAULT_INTERVALS.mid;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Next due date for the follow-up AFTER `touchNumber` touches already sent.
 * Returns null when the cadence is exhausted (sequence complete).
 */
export function computeNextDue(lastTouchAt: Date, touchNumber: number, intervals: number[]): Date | null {
  const interval = intervals[touchNumber];
  if (interval === undefined) return null;
  return new Date(lastTouchAt.getTime() + interval * DAY_MS);
}
