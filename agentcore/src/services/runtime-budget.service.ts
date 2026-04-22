import { queueRedis } from '../queues/setup.js';

/**
 * Per-master-agent daily runtime budget tracker.
 *
 * Each master agent has a budget (default 1 hour) of cumulative wall-clock
 * job-execution time per UTC calendar day. This module records usage in Redis
 * and exposes helpers for the worker layer to gate dispatch when exhausted.
 *
 * Key shape: `master_agent:{id}:runtime:{YYYY-MM-DD}` (TTL 36h)
 */

const DEFAULT_BUDGET_MS = 60 * 60 * 1000; // 1 hour
const KEY_TTL_SECONDS = 36 * 60 * 60; // 36h — survives until the next day rolls over

function todayKey(masterAgentId: string, when: Date = new Date()): string {
  const yyyy = when.getUTCFullYear();
  const mm = String(when.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(when.getUTCDate()).padStart(2, '0');
  return `master_agent:${masterAgentId}:runtime:${yyyy}-${mm}-${dd}`;
}

export async function getRuntimeUsedMs(masterAgentId: string, when?: Date): Promise<number> {
  const v = await queueRedis.get(todayKey(masterAgentId, when));
  return v ? Number(v) : 0;
}

export async function addRuntimeMs(masterAgentId: string, ms: number): Promise<number> {
  if (!ms || ms <= 0) return getRuntimeUsedMs(masterAgentId);
  const key = todayKey(masterAgentId);
  const total = await queueRedis.incrby(key, Math.floor(ms));
  await queueRedis.expire(key, KEY_TTL_SECONDS);
  return total;
}

export function msUntilUtcMidnight(now: Date = new Date()): number {
  const next = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1,
    0, 0, 0, 0,
  ));
  return next.getTime() - now.getTime();
}

export function nextResetAt(now: Date = new Date()): Date {
  return new Date(now.getTime() + msUntilUtcMidnight(now));
}

export interface QuotaSnapshot {
  runtimeUsedMs: number;
  runtimeBudgetMs: number;
  remainingMs: number;
  exhausted: boolean;
  resetsAt: string;
}

export async function getQuotaSnapshot(
  masterAgentId: string,
  budgetMs: number = DEFAULT_BUDGET_MS,
): Promise<QuotaSnapshot> {
  const used = await getRuntimeUsedMs(masterAgentId);
  return {
    runtimeUsedMs: used,
    runtimeBudgetMs: budgetMs,
    remainingMs: Math.max(0, budgetMs - used),
    exhausted: used >= budgetMs,
    resetsAt: nextResetAt().toISOString(),
  };
}

export async function isQuotaExhausted(
  masterAgentId: string,
  budgetMs: number = DEFAULT_BUDGET_MS,
): Promise<boolean> {
  const used = await getRuntimeUsedMs(masterAgentId);
  return used >= budgetMs;
}

/** For tests / manual reset only. */
export async function resetTodayRuntime(masterAgentId: string): Promise<void> {
  await queueRedis.del(todayKey(masterAgentId));
}
