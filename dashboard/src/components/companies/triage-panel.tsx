'use client';

import type { CompanyTriageVerdict } from '@/types';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useReTriageCompany } from '@/hooks/use-triage';
import { useToast } from '@/hooks/use-toast';
import { CheckCircle2, XCircle, HelpCircle, RefreshCw, Loader2, Quote } from 'lucide-react';
import { FitScoreBadge } from './fit-score-badge';

interface TriagePanelProps {
  companyId: string;
  triage: CompanyTriageVerdict | undefined;
}

export function TriagePanel({ companyId, triage }: TriagePanelProps) {
  const reTriage = useReTriageCompany();
  const { toast } = useToast();

  const handleReTriage = async () => {
    try {
      const r = await reTriage.mutateAsync({ companyId, force: true });
      if (r.verdict) {
        toast({ title: 'Re-triaged', description: `Verdict: ${r.verdict.verdict} (fit ${r.verdict.fit_score})` });
      } else {
        toast({ title: 'Re-triage failed', description: 'LLM returned no usable verdict.' });
      }
    } catch (err) {
      toast({ title: 'Re-triage failed', description: err instanceof Error ? err.message : String(err) });
    }
  };

  if (!triage) {
    return (
      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <HelpCircle className="w-4 h-4" /> Triage
          </CardTitle>
          <Button variant="outline" size="sm" onClick={handleReTriage} disabled={reTriage.isPending}>
            {reTriage.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
            <span className="ml-1.5 text-xs">Triage now</span>
          </Button>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">No triage verdict yet for this company.</p>
        </CardContent>
      </Card>
    );
  }

  const verdictBadge =
    triage.verdict === 'accept' ? (
      <Badge className="bg-emerald-500/15 text-emerald-400 border-emerald-500/30">
        <CheckCircle2 className="w-3 h-3 mr-1" /> Accept
      </Badge>
    ) : triage.verdict === 'reject' ? (
      <Badge className="bg-red-500/15 text-red-400 border-red-500/30">
        <XCircle className="w-3 h-3 mr-1" /> Reject
      </Badge>
    ) : (
      <Badge className="bg-amber-500/15 text-amber-400 border-amber-500/30">
        <HelpCircle className="w-3 h-3 mr-1" /> Review
      </Badge>
    );

  const signalGroups: Array<{ key: keyof CompanyTriageVerdict['signals']; label: string }> = [
    { key: 'hiring_signals', label: 'Hiring' },
    { key: 'funding_signals', label: 'Funding' },
    { key: 'growth_signals', label: 'Growth' },
    { key: 'tech_signals', label: 'Tech' },
  ];

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
        <CardTitle className="text-sm font-medium flex items-center gap-2">
          {verdictBadge}
          <FitScoreBadge score={triage.fit_score} explanation={triage.fit_score_explanation} />
        </CardTitle>
        <Button variant="outline" size="sm" onClick={handleReTriage} disabled={reTriage.isPending}>
          {reTriage.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
          <span className="ml-1.5 text-xs">Re-triage</span>
        </Button>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        {triage.verdict === 'reject' && (
          <div>
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-1">Rejection reason</p>
            <p>{triage.rejection_reason ?? 'unspecified'}</p>
            {triage.rejection_explanation && (
              <p className="text-muted-foreground mt-1">{triage.rejection_explanation}</p>
            )}
          </div>
        )}

        {triage.fit_score_explanation && (
          <div>
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-1">Fit</p>
            <p className="text-muted-foreground">{triage.fit_score_explanation}</p>
          </div>
        )}

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
              {triage.key_person_problem ?? 'No suitable decision maker surfaced.'}
            </p>
          )}
        </div>

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
          Triaged at {new Date(triage.triaged_at).toLocaleString()} · {triage.model_used}
        </p>
      </CardContent>
    </Card>
  );
}
