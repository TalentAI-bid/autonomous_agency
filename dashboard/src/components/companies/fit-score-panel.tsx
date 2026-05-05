'use client';

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { CompanyFitScoreVerdict } from '@/types';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useReScoreCompany } from '@/hooks/use-fit-score';
import { useToast } from '@/hooks/use-toast';
import { apiPost } from '@/lib/api';
import { RefreshCw, Loader2, Quote, Download, Users } from 'lucide-react';
import { FitScoreBadge } from './fit-score-badge';

interface FitScorePanelProps {
  companyId: string;
  // The dashboard reads either rawData.fitScore (new) or rawData.triage
  // (migrated). The page passes whichever is present.
  triage?: CompanyFitScoreVerdict | undefined;
}

function componentBarColor(score: number | null): string {
  if (score == null) return 'bg-muted';
  if (score >= 80) return 'bg-emerald-500';
  if (score >= 60) return 'bg-emerald-400';
  if (score >= 40) return 'bg-amber-500';
  if (score >= 20) return 'bg-orange-500';
  return 'bg-zinc-500';
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
    mutationFn: () => apiPost<{ enqueued: boolean }>(`/companies/${companyId}/refetch-team`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['companies'] }),
  });
}

export function FitScorePanel({ companyId, triage }: FitScorePanelProps) {
  const reScore = useReScoreCompany();
  const refetchInfo = useRefetchInfo(companyId);
  const refetchTeam = useRefetchTeam(companyId);
  const { toast } = useToast();
  const [showRationale, setShowRationale] = useState(true);

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
    try {
      await refetchTeam.mutateAsync();
      toast({ title: 'Team refetch enqueued', description: 'The people-page scrape will run shortly.' });
    } catch (err) {
      toast({ title: 'Refetch failed', description: err instanceof Error ? err.message : String(err) });
    }
  };

  if (!triage) {
    return (
      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
          <CardTitle className="text-sm font-medium">Buyer fit score</CardTitle>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={handleRefetchInfo} disabled={refetchInfo.isPending}>
              <Download className="w-3 h-3 mr-1" /> Refetch info
            </Button>
            <Button variant="outline" size="sm" onClick={handleRefetchTeam} disabled={refetchTeam.isPending}>
              <Users className="w-3 h-3 mr-1" /> Refetch team
            </Button>
            <Button variant="outline" size="sm" onClick={handleReScore} disabled={reScore.isPending}>
              {reScore.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
              <span className="ml-1.5 text-xs">Score now</span>
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">No score yet for this company. Click Score now or wait for the next scrape to land.</p>
        </CardContent>
      </Card>
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

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
        <CardTitle className="text-sm font-medium flex items-center gap-3">
          <FitScoreBadge score={triage.buyer_fit_score} explanation={triage.fit_summary} />
          {triage.data_completeness === 'partial' && (
            <Badge variant="outline" className="text-xs text-amber-400 border-amber-500/40">
              partial data — score will refine
            </Badge>
          )}
        </CardTitle>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={handleRefetchInfo} disabled={refetchInfo.isPending} title="Re-enqueue the about-page scrape">
            <Download className="w-3 h-3 mr-1" /> Info
          </Button>
          <Button variant="outline" size="sm" onClick={handleRefetchTeam} disabled={refetchTeam.isPending} title="Re-enqueue the people-page scrape">
            <Users className="w-3 h-3 mr-1" /> Team
          </Button>
          <Button variant="outline" size="sm" onClick={handleReScore} disabled={reScore.isPending}>
            {reScore.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
            <span className="ml-1.5 text-xs">Re-score</span>
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        {/* Big score + summary */}
        <div className="flex items-baseline gap-3">
          <span className="text-3xl font-bold">{triage.buyer_fit_score}</span>
          <span className="text-xs text-muted-foreground">/ 100</span>
        </div>
        <p className="text-sm text-muted-foreground italic">{triage.fit_summary}</p>

        {/* Component breakdown — 4 horizontal bars */}
        <div>
          <button
            type="button"
            onClick={() => setShowRationale((v) => !v)}
            className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2 hover:text-foreground"
          >
            Component breakdown {showRationale ? '−' : '+'}
          </button>
          <div className="space-y-2">
            {componentKeys.map((key) => {
              const c = components[key];
              const score = c.score;
              const display = score == null ? '—' : String(score);
              const widthPct = score == null ? 0 : Math.max(2, score);
              return (
                <div key={key} className="space-y-1">
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-medium">{COMPONENT_LABELS[key]}</span>
                    <span className="font-mono">{display}</span>
                  </div>
                  <div className="h-2 w-full rounded-full bg-muted overflow-hidden">
                    <div className={`h-full ${componentBarColor(score)}`} style={{ width: `${widthPct}%` }} />
                  </div>
                  {showRationale && c.reasoning && (
                    <p className="text-xs text-muted-foreground">{c.reasoning}</p>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* Key person */}
        <div>
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-1">Key person</p>
          {triage.key_person ? (
            <div className="rounded-md border bg-muted/20 p-3 space-y-1">
              <p className="font-medium">{triage.key_person.name}</p>
              <p className="text-xs text-muted-foreground">{triage.key_person.title}</p>
              <p className="text-xs italic">{triage.key_person.rationale}</p>
              {triage.key_person.linkedinUrl && (
                <a
                  href={triage.key_person.linkedinUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-blue-400 hover:underline"
                >
                  LinkedIn ↗
                </a>
              )}
            </div>
          ) : (
            <p className="text-muted-foreground text-xs">
              {triage.key_person_problem === 'people_list_was_empty'
                ? 'Team data not scraped yet — click Refetch team to populate.'
                : (triage.key_person_problem ?? 'No suitable decision maker surfaced.')}
            </p>
          )}
        </div>

        {/* Signals */}
        <div>
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">Signals</p>
          <div className="space-y-3">
            {signalGroups.map(({ key, label }) => {
              const items = triage.signals[key] as Array<{ claim: string; citation: string }>;
              if (!items.length) return null;
              return (
                <div key={key}>
                  <p className="text-xs font-medium mb-1">{label}</p>
                  <ul className="space-y-1.5">
                    {items.map((s, i) => (
                      <li key={i} className="text-xs">
                        <span>{s.claim}</span>
                        <span className="block text-muted-foreground italic mt-0.5">
                          <Quote className="inline w-3 h-3 mr-1" />
                          {s.citation}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
            {triage.signals.pain_hypotheses.length > 0 && (
              <div>
                <p className="text-xs font-medium mb-1">Pain hypotheses</p>
                <ul className="space-y-1.5">
                  {triage.signals.pain_hypotheses.map((p, i) => (
                    <li key={i} className="text-xs">
                      <span className="font-medium">{p.inferred_pain}</span>
                      <span className="text-muted-foreground"> — confidence {p.confidence.toFixed(2)}</span>
                      <span className="block text-muted-foreground italic mt-0.5">
                        <Quote className="inline w-3 h-3 mr-1" />
                        {p.stated_fact}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {signalGroups.every(({ key }) => (triage.signals[key] as unknown[]).length === 0) &&
              triage.signals.pain_hypotheses.length === 0 && (
                <p className="text-xs text-muted-foreground">No grounded signals — that's fine and honest.</p>
              )}
          </div>
        </div>

        <p className="text-[10px] text-muted-foreground pt-2 border-t">
          Scored at {new Date(triage.scored_at).toLocaleString()} · {triage.model_used} · Data: {triage.data_completeness}
        </p>
      </CardContent>
    </Card>
  );
}
