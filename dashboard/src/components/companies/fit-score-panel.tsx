'use client';

import { useState, type ReactNode } from 'react';
import { Card } from '@/components/ui/card';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { CompanyFitScoreVerdict } from '@/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useReScoreCompany } from '@/hooks/use-fit-score';
import { useToast } from '@/hooks/use-toast';
import { apiPost } from '@/lib/api';
import { RefreshCw, Loader2, Quote, Download, Users, Target } from 'lucide-react';
import { StatusPill } from '@/components/home/home-parts';
import { FitScoreBadge } from './fit-score-badge';

interface FitScorePanelProps {
  companyId: string;
  // The dashboard reads either rawData.fitScore (new) or rawData.triage
  // (migrated). The page passes whichever is present.
  triage?: CompanyFitScoreVerdict | undefined;
}

function componentBarColor(score: number | null): string {
  if (score == null) return 'bg-bg-soft';
  if (score >= 80) return 'bg-up';
  if (score >= 60) return 'bg-up';
  if (score >= 40) return 'bg-warn';
  if (score >= 20) return 'bg-warn';
  return 'bg-ink-4';
}

const COMPONENT_LABELS: Record<keyof CompanyFitScoreVerdict['component_scores'], string> = {
  is_real_business: 'Real business',
  icp_match: 'ICP match',
  buyer_signal_strength: 'Buyer signals',
  decision_maker_reachable: 'Reachable DM',
};

function useRefetchInfo(companyId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => apiPost<{ enqueued: boolean }>(`/companies/${companyId}/refetch-info`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['companies'] }),
  });
}

function useRefetchTeam(companyId: string) {
  const qc = useQueryClient();
  return useMutation({
    // Optional role/keyword — fetch only employees whose title matches.
    mutationFn: (keyword?: string) =>
      apiPost<{ enqueued: boolean }>(`/companies/${companyId}/refetch-team`, keyword ? { keyword } : {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['companies'] }),
  });
}

export function FitScorePanel({ companyId, triage }: FitScorePanelProps) {
  const reScore = useReScoreCompany();
  const refetchInfo = useRefetchInfo(companyId);
  const refetchTeam = useRefetchTeam(companyId);
  const { toast } = useToast();
  const [showRationale, setShowRationale] = useState(true);
  const [teamKeyword, setTeamKeyword] = useState('');

  const handleReScore = async () => {
    try {
      const r = await reScore.mutateAsync({ companyId, force: true });
      toast({
        title: r.verdict ? 'Re-scored' : 'Re-score failed',
        description: r.verdict
          ? `Buyer fit ${r.verdict.buyer_fit_score} — ${r.verdict.fit_summary}`
          : 'LLM returned no usable verdict.',
      });
    } catch (err) {
      toast({ title: 'Re-score failed', description: err instanceof Error ? err.message : String(err) });
    }
  };

  const handleRefetchInfo = async () => {
    try {
      await refetchInfo.mutateAsync();
      toast({ title: 'Info refetch enqueued', description: 'The about-page scrape will run shortly.' });
    } catch (err) {
      toast({ title: 'Refetch failed', description: err instanceof Error ? err.message : String(err) });
    }
  };
  const handleRefetchTeam = async () => {
    const kw = teamKeyword.trim() || undefined;
    try {
      await refetchTeam.mutateAsync(kw);
      toast({
        title: 'Team refetch enqueued',
        description: kw ? `Fetching “${kw}” roles — runs shortly.` : 'The people-page scrape will run shortly.',
      });
    } catch (err) {
      toast({ title: 'Refetch failed', description: err instanceof Error ? err.message : String(err) });
    }
  };

  const actions = (short: boolean) => (
    <div className="flex flex-wrap items-center gap-2">
      <Button size="sm" variant="panel" onClick={handleRefetchInfo} disabled={refetchInfo.isPending} title="Re-enqueue the about-page scrape">
        <Download className="mr-1.5 size-3.5" /> {short ? 'Info' : 'Refetch info'}
      </Button>
      <Input
        value={teamKeyword}
        onChange={(e) => setTeamKeyword(e.target.value)}
        placeholder="Role, e.g. sales manager"
        className="h-8 w-44 text-xs"
        title="Optional: fetch only employees whose title matches this role"
      />
      <Button size="sm" variant="panel" onClick={handleRefetchTeam} disabled={refetchTeam.isPending} title="Re-enqueue the people-page scrape (optionally filtered by role)">
        <Users className="mr-1.5 size-3.5" /> {short ? 'Team' : 'Refetch team'}
      </Button>
      <Button size="sm" variant="brand" onClick={handleReScore} disabled={reScore.isPending}>
        {reScore.isPending ? <Loader2 className="mr-1.5 size-3.5 animate-spin" /> : <RefreshCw className="mr-1.5 size-3.5" />}
        {triage ? 'Re-score' : 'Score now'}
      </Button>
    </div>
  );

  const shell = (children: ReactNode, title: ReactNode, short: boolean) => (
    <Card as="section" className="overflow-hidden">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-3.5">
        <div className="flex items-center gap-2.5">
          <span className="grid size-8 place-items-center rounded-lg bg-accent-weak text-accent">
            <Target size={15} />
          </span>
          {title}
        </div>
        {actions(short)}
      </header>
      {children}
    </Card>
  );

  if (!triage) {
    return shell(
      <p className="m-0 px-5 py-6 text-body text-ink-3">
        No score yet for this company. Click <span className="font-medium text-ink-2">Score now</span> or wait for the next scrape to land.
      </p>,
      <h2 className="m-0 text-body font-semibold text-ink">Buyer fit score</h2>,
      false,
    );
  }

  const components = triage.component_scores;
  const componentKeys: Array<keyof CompanyFitScoreVerdict['component_scores']> = [
    'is_real_business', 'icp_match', 'buyer_signal_strength', 'decision_maker_reachable',
  ];

  const signalGroups: Array<{ key: keyof CompanyFitScoreVerdict['signals']; label: string }> = [
    { key: 'hiring_signals', label: 'Hiring' },
    { key: 'funding_signals', label: 'Funding' },
    { key: 'growth_signals', label: 'Growth' },
    { key: 'tech_signals', label: 'Tech' },
  ];

  const LABEL = 'mb-2 text-3xs font-medium uppercase tracking-[0.09em] text-ink-4';
  const hasSignals =
    signalGroups.some(({ key }) => (triage.signals[key] as unknown[]).length > 0) || triage.signals.pain_hypotheses.length > 0;

  return shell(
    <div className="space-y-6 p-5">
      {/* Big score + summary */}
      <div className="flex flex-wrap items-start gap-x-6 gap-y-3">
        <div className="flex items-baseline gap-1.5">
          <span className="font-mono text-[40px] font-semibold leading-none text-ink">{triage.buyer_fit_score}</span>
          <span className="text-xs text-ink-3">/ 100</span>
        </div>
        <p className="m-0 min-w-[240px] flex-1 text-body leading-relaxed text-ink-2">{triage.fit_summary}</p>
      </div>

      {/* Component breakdown */}
      <div>
        <button
          type="button"
          onClick={() => setShowRationale((v) => !v)}
          className={`${LABEL} border-0 bg-transparent p-0 transition-colors hover:text-ink-2`}
        >
          Component breakdown · {showRationale ? 'hide reasoning' : 'show reasoning'}
        </button>
        <div className="grid gap-x-8 gap-y-4 md:grid-cols-2">
          {componentKeys.map((key) => {
            const c = components[key];
            const score = c.score;
            const display = score == null ? '—' : String(score);
            const widthPct = score == null ? 0 : Math.max(2, score);
            return (
              <div key={key}>
                <div className="mb-1.5 flex items-center justify-between text-xs">
                  <span className="font-medium text-ink">{COMPONENT_LABELS[key]}</span>
                  <span className="font-mono text-ink-2">{display}</span>
                </div>
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-bg-soft">
                  <div className={`h-full rounded-full ${componentBarColor(score)}`} style={{ width: `${widthPct}%` }} />
                </div>
                {showRationale && c.reasoning && <p className="m-0 mt-1.5 text-xs leading-snug text-ink-3">{c.reasoning}</p>}
              </div>
            );
          })}
        </div>
      </div>

      {/* Key person */}
      <div>
        <p className={LABEL}>Key person</p>
        {triage.key_person ? (
          <div className="rounded-xl border border-line bg-bg-sub p-3.5">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="m-0 text-body font-medium text-ink">{triage.key_person.name}</p>
                <p className="m-0 text-xs text-ink-3">{triage.key_person.title}</p>
              </div>
              {triage.key_person.linkedinUrl && (
                <a
                  href={triage.key_person.linkedinUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="shrink-0 text-xs font-medium text-info no-underline hover:underline"
                >
                  LinkedIn ↗
                </a>
              )}
            </div>
            <p className="m-0 mt-2 text-xs italic leading-snug text-ink-2">{triage.key_person.rationale}</p>
          </div>
        ) : (
          <p className="m-0 text-xs text-ink-3">
            {triage.key_person_problem === 'people_list_was_empty'
              ? 'Team data not scraped yet. Click Refetch team to populate.'
              : (triage.key_person_problem ?? 'No suitable decision maker surfaced.')}
          </p>
        )}
      </div>

      {/* Signals */}
      <div>
        <p className={LABEL}>Signals</p>
        {hasSignals ? (
          <div className="grid gap-x-8 gap-y-4 md:grid-cols-2">
            {signalGroups.map(({ key, label }) => {
              const items = triage.signals[key] as Array<{ claim: string; citation: string }>;
              if (!items.length) return null;
              return (
                <div key={key}>
                  <p className="m-0 mb-1.5 text-xs font-semibold text-ink">{label}</p>
                  <ul className="m-0 list-none space-y-2 p-0">
                    {items.map((sig, i) => (
                      <li key={i} className="text-xs text-ink-2">
                        <span>{sig.claim}</span>
                        <span className="mt-0.5 block italic text-ink-3">
                          <Quote className="mr-1 inline size-3" />
                          {sig.citation}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
            {triage.signals.pain_hypotheses.length > 0 && (
              <div className="md:col-span-2">
                <p className="m-0 mb-1.5 text-xs font-semibold text-ink">Pain hypotheses</p>
                <ul className="m-0 list-none space-y-2 p-0">
                  {triage.signals.pain_hypotheses.map((pp, i) => (
                    <li key={i} className="text-xs text-ink-2">
                      <span className="font-medium text-ink">{pp.inferred_pain}</span>
                      <span className="text-ink-3"> · confidence {pp.confidence.toFixed(2)}</span>
                      <span className="mt-0.5 block italic text-ink-3">
                        <Quote className="mr-1 inline size-3" />
                        {pp.stated_fact}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        ) : (
          <p className="m-0 text-xs text-ink-3">No grounded signals, and that is fine and honest.</p>
        )}
      </div>

      <p className="m-0 border-t border-line pt-3 text-2xs text-ink-4">
        Scored {new Date(triage.scored_at).toLocaleString()} · {triage.model_used} · Data: {triage.data_completeness}
      </p>
    </div>,
    <div className="flex flex-wrap items-center gap-2.5">
      <h2 className="m-0 text-body font-semibold text-ink">Buyer fit score</h2>
      <FitScoreBadge score={triage.buyer_fit_score} explanation={triage.fit_summary} />
      {triage.data_completeness === 'partial' && <StatusPill tone="warn">Partial data · score will refine</StatusPill>}
    </div>,
    true,
  );
}
