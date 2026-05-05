import { Worker, type Job } from 'bullmq';
import { eq, and } from 'drizzle-orm';
import { createRedisConnection } from '../queues/setup.js';
import { FIT_SCORE_QUEUE_NAME, type FitScoreJobData } from '../queues/fit-score-queues.js';
import { withTenant } from '../config/database.js';
import { companies, contacts, masterAgents } from '../db/schema/index.js';
import { scoreCompany } from '../services/buyer-fit-score.service.js';
import { publishFitScoreUpdated } from '../utils/realtime.js';
import { env } from '../config/env.js';
import logger from '../utils/logger.js';

const DEBOUNCE_WINDOW_MS = 30_000;

/**
 * Process one fit-score job. Reloads the company state defensively because
 * rows may change between job enqueue and worker pickup (multiple data
 * arrivals → multiple jobs queued for the same company within seconds).
 *
 * Debounce: skips when a recent score exists (<30s old) UNLESS the reason is
 * manual_rescore. The most recent fired job picks up the latest data.
 *
 * Primary contact side-effect: when scoreCompany returns a key_person with a
 * linkedinUrl, the worker dedupes by linkedinUrl and either inserts a new
 * contact (is_primary_contact=true) or flips the flag on an existing match.
 * This complements the top-3 contacts already saved by the team-fetch
 * handler — the LLM-chosen primary surfaces prominently in the dashboard
 * while the others remain available.
 */
export async function processFitScoreJob(job: Job<FitScoreJobData>): Promise<{ ok: boolean; reason?: string }> {
  const { companyId, tenantId, reason } = job.data;

  const ctx = await withTenant(tenantId, async (tx) => {
    const [company] = await tx.select().from(companies)
      .where(and(eq(companies.tenantId, tenantId), eq(companies.id, companyId)))
      .limit(1);
    if (!company) return null;
    return { company };
  });
  if (!ctx) {
    logger.debug({ companyId, tenantId }, 'fit-score worker: company not found, skipping');
    return { ok: false, reason: 'company_missing' };
  }
  const { company } = ctx;

  // Debounce: skip if scored within the last DEBOUNCE_WINDOW_MS.
  if (reason !== 'manual_rescore') {
    const lastScored = (company.rawData as { fitScore?: { scored_at?: string } } | null)?.fitScore?.scored_at;
    if (lastScored) {
      const ageMs = Date.now() - new Date(lastScored).getTime();
      if (ageMs < DEBOUNCE_WINDOW_MS && Number.isFinite(ageMs)) {
        logger.info({ companyId, ageMs, reason }, 'fit-score worker: debounced (recent score exists)');
        return { ok: false, reason: 'debounced' };
      }
    }
  }

  if (!company.masterAgentId) {
    logger.debug({ companyId }, 'fit-score worker: company has no masterAgentId, skipping');
    return { ok: false, reason: 'no_master_agent' };
  }

  const verdict = await scoreCompany({
    tenantId,
    companyId,
    masterAgentId: company.masterAgentId,
    force: reason === 'manual_rescore',
  });
  if (!verdict) {
    return { ok: false, reason: 'score_failed' };
  }

  // Primary key_person side-effect: dedupe by linkedinUrl, set the flag.
  if (verdict.key_person?.linkedinUrl) {
    try {
      await withTenant(tenantId, async (tx) => {
        const [existing] = await tx.select({ id: contacts.id })
          .from(contacts)
          .where(and(
            eq(contacts.tenantId, tenantId),
            eq(contacts.linkedinUrl, verdict.key_person!.linkedinUrl),
          ))
          .limit(1);

        if (existing) {
          await tx.update(contacts).set({
            isPrimaryContact: true,
            updatedAt: new Date(),
          }).where(eq(contacts.id, existing.id));
        } else {
          // The LLM picked a person who isn't yet a saved contact (perhaps
          // because they weren't in the top-3 the team handler inserted).
          // Insert as primary so the dashboard can surface them.
          const fullName = verdict.key_person!.name.trim();
          const parts = fullName.split(/\s+/);
          const firstName = parts[0] || fullName;
          const lastName = parts.slice(1).join(' ') || '';
          await tx.insert(contacts).values({
            tenantId,
            firstName,
            lastName,
            title: verdict.key_person!.title,
            linkedinUrl: verdict.key_person!.linkedinUrl,
            companyId,
            companyName: company.name,
            source: 'linkedin_profile',
            isPrimaryContact: true,
            rawData: { discoverySource: 'fit_score_key_person', rationale: verdict.key_person!.rationale },
          });
        }
      });
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err), companyId },
        'fit-score worker: failed to set primary contact (non-fatal)',
      );
    }
  }

  // Realtime push so the dashboard updates without a refetch.
  try {
    await publishFitScoreUpdated({
      tenantId,
      companyId,
      score: verdict.buyer_fit_score,
      dataCompleteness: verdict.data_completeness,
      fit_summary: verdict.fit_summary,
    });
  } catch (err) {
    logger.debug({ err, companyId }, 'fit-score worker: realtime publish failed (non-fatal)');
  }

  logger.info(
    { companyId, score: verdict.buyer_fit_score, reason, dataCompleteness: verdict.data_completeness },
    'fit score computed',
  );
  return { ok: true };
}

let worker: Worker | undefined;

export function startFitScoreWorker(): Worker {
  if (worker) return worker;
  const concurrency = Number(process.env.FIT_SCORE_WORKER_CONCURRENCY ?? '5') || 5;
  void env; // keep env import live so config validation still runs
  worker = new Worker<FitScoreJobData>(
    FIT_SCORE_QUEUE_NAME,
    processFitScoreJob,
    {
      connection: createRedisConnection() as any,
      concurrency,
    },
  );

  worker.on('error', (err) => {
    logger.error({ err }, 'fit-score worker error');
  });

  logger.info({ concurrency }, 'fit-score worker started');
  return worker;
}

export async function stopFitScoreWorker(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = undefined;
  }
}
