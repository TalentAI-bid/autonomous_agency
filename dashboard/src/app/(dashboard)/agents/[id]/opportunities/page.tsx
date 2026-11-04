'use client';

import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { useParams } from 'next/navigation';
import { useOpportunities, useOpportunityStats, useUpdateOpportunityStatus } from '@/hooks/use-opportunities';
import { Button } from '@/components/ui/button';
import { Zap, TrendingUp, Clock, Target, ExternalLink, Building2, User, ChevronDown } from 'lucide-react';
import type { Opportunity, OpportunityType, OpportunityUrgency, OpportunityStatus } from '@/types';

import { Select } from '@/components/ui/select';
const TYPE_LABELS: Record<OpportunityType, string> = {
  hiring_signal: 'Hiring Signal',
  direct_request: 'Direct Request',
  recommendation_ask: 'Recommendation',
  project_announcement: 'Project Announcement',
  funding_signal: 'Funding Signal',
  technology_adoption: 'Tech Adoption',
  tender_rfp: 'Tender/RFP',
  conference_signal: 'Conference',
  pain_point_expressed: 'Pain Point',
  partnership_signal: 'Partnership',
};

const URGENCY_COLORS: Record<OpportunityUrgency, string> = {
  immediate: 'bg-down/10 text-down',
  soon: 'bg-warn/10 text-warn-fg',
  exploring: 'bg-info/10 text-info',
  none: 'bg-ink-3/10 text-ink-3',
};

const STATUS_COLORS: Record<OpportunityStatus, string> = {
  new: 'bg-info/10 text-info',
  researching: 'bg-a-master/10 text-a-master',
  qualified: 'bg-up/10 text-up',
  contacted: 'bg-warn/10 text-warn-fg',
  converted: 'bg-up/10 text-up',
  skipped: 'bg-ink-3/10 text-ink-3',
};

function scoreColor(score: number): string {
  if (score >= 80) return 'text-up';
  if (score >= 60) return 'text-info';
  if (score >= 40) return 'text-warn-fg';
  return 'text-ink-3';
}

export default function OpportunitiesPage() {
  const { id: masterAgentId } = useParams<{ id: string }>();
  const [typeFilter, setTypeFilter] = useState<string>('');
  const [statusFilter, setStatusFilter] = useState<string>('');
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const { data: listRes, isLoading } = useOpportunities(masterAgentId, {
    type: typeFilter || undefined,
    status: statusFilter || undefined,
    limit: 50,
  });
  const { data: statsRes } = useOpportunityStats(masterAgentId);
  const updateStatus = useUpdateOpportunityStatus();

  const opportunities = (listRes as any)?.data ?? [];
  const stats = statsRes as any;

  const selectCls = 'h-8 rounded-lg border-line bg-bg-panel px-2.5 text-xs';
  const tiles = stats
    ? [
        { label: 'Total', value: stats.total, icon: Zap, tone: 'text-warn-fg' },
        { label: 'Avg intent', value: stats.avgBuyingIntentScore, icon: TrendingUp, tone: scoreColor(stats.avgBuyingIntentScore) },
        { label: 'Immediate', value: stats.byUrgency?.find((u: any) => u.urgency === 'immediate')?.total ?? 0, icon: Clock, tone: 'text-down' },
        { label: 'Qualified', value: stats.byStatus?.find((s: any) => s.status === 'qualified')?.total ?? 0, icon: Target, tone: 'text-up' },
      ]
    : [];

  return (
    <div className="space-y-5">
      {stats && (
        <dl className="m-0 grid grid-cols-2 divide-x divide-line overflow-hidden rounded-2xl border border-line bg-bg-panel shadow-sm lg:grid-cols-4">
          {tiles.map((t) => (
            <div key={t.label} className="px-5 py-3.5 [&:nth-child(n+3)]:border-t [&:nth-child(n+3)]:border-line lg:[&:nth-child(n+3)]:border-t-0">
              <dt className="flex items-center gap-1.5 text-3xs font-medium uppercase tracking-[0.09em] text-ink-4">
                <t.icon size={12} /> {t.label}
              </dt>
              <dd className={`m-0 mt-1.5 font-display text-[26px] leading-none ${t.tone}`}>{t.value}</dd>
            </div>
          ))}
        </dl>
      )}

      <section className="overflow-hidden rounded-2xl border border-line bg-bg-panel shadow-sm">
        <header className="flex flex-wrap items-center gap-3 border-b border-line px-5 py-3.5">
          <div className="mr-auto flex items-center gap-2">
            <h2 className="m-0 text-body font-semibold text-ink">Opportunities</h2>
            <Badge variant="muted" size="sm" className="font-mono">{opportunities.length}</Badge>
          </div>
          <Select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)} aria-label="Filter by type" className={selectCls}>
            <option value="">All types</option>
            {Object.entries(TYPE_LABELS).map(([k, v]) => (
              <option key={k} value={k}>{v}</option>
            ))}
          </Select>
          <Select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} aria-label="Filter by status" className={selectCls}>
            <option value="">All statuses</option>
            {['new', 'researching', 'qualified', 'contacted', 'converted', 'skipped'].map((s) => (
              <option key={s} value={s}>{s.charAt(0).toUpperCase() + s.slice(1)}</option>
            ))}
          </Select>
        </header>

        {isLoading ? (
          <p className="m-0 px-5 py-10 text-center text-body text-ink-3">Loading…</p>
        ) : opportunities.length === 0 ? (
          <div className="px-5 py-12 text-center">
            <p className="m-0 text-body font-medium text-ink">No opportunities yet</p>
            <p className="mb-0 mt-1 text-xs text-ink-3">Run the agent in sales mode to discover buying signals.</p>
          </div>
        ) : (
          <ul className="m-0 list-none divide-y divide-line p-0">
            {opportunities.map((opp: Opportunity) => {
              const open = expandedId === opp.id;
              return (
                <li key={opp.id}>
                  <button
                    type="button"
                    onClick={() => setExpandedId(open ? null : opp.id)}
                    aria-expanded={open}
                    className="flex w-full items-center gap-3.5 px-5 py-3 text-left transition-colors hover:bg-bg-soft"
                  >
                    <span className={`grid size-10 shrink-0 place-items-center rounded-xl bg-bg-sub font-mono text-body font-semibold tabular-nums ${scoreColor(opp.buyingIntentScore)}`} title="Buying intent score">
                      {opp.buyingIntentScore}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-body font-medium text-ink">{opp.title}</div>
                      <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-ink-3">
                        {opp.companyName && (
                          <span className="inline-flex items-center gap-1"><Building2 size={11} />{opp.companyName}</span>
                        )}
                        {opp.personName && (
                          <span className="inline-flex items-center gap-1"><User size={11} />{opp.personName}</span>
                        )}
                        <span>{TYPE_LABELS[opp.opportunityType] ?? opp.opportunityType}</span>
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <span className={`rounded-md px-2 py-0.5 text-2xs font-medium capitalize ${URGENCY_COLORS[opp.urgency]}`}>{opp.urgency}</span>
                      <span className={`rounded-md px-2 py-0.5 text-2xs font-medium capitalize ${STATUS_COLORS[opp.status]}`}>{opp.status}</span>
                      <ChevronDown size={14} className={`text-ink-4 transition-transform ${open ? 'rotate-180' : ''}`} />
                    </div>
                  </button>
                  {open && (
                    <div className="space-y-3 border-t border-line bg-bg-sub px-5 py-4">
                      {opp.description && <p className="m-0 text-body leading-relaxed text-ink-2">{opp.description}</p>}
                      <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-ink-3">
                        {opp.sourcePlatform && <span>Platform: <span className="text-ink-2">{opp.sourcePlatform}</span></span>}
                        {opp.budget && <span>Budget: <span className="text-ink-2">{opp.budget}</span></span>}
                        {opp.timeline && <span>Timeline: <span className="text-ink-2">{opp.timeline}</span></span>}
                        {opp.location && <span>Location: <span className="text-ink-2">{opp.location}</span></span>}
                      </div>
                      {opp.technologies && opp.technologies.length > 0 && (
                        <div className="flex flex-wrap gap-1">
                          {opp.technologies.map((t) => (
                            <Badge key={t} variant="info" size="sm">{t}</Badge>
                          ))}
                        </div>
                      )}
                      <div className="flex items-center gap-2">
                        {opp.sourceUrl && (
                          <a href={opp.sourceUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs font-medium text-accent-fg hover:underline">
                            <ExternalLink size={12} />Source
                          </a>
                        )}
                        <div className="ml-auto flex gap-1.5">
                          {opp.status === 'new' && (
                            <Button type="button" size="dense" variant="panel" className="h-8 rounded-lg"
                              onClick={() => updateStatus.mutate({ masterAgentId, opportunityId: opp.id, status: 'researching' })}>
                              Research
                            </Button>
                          )}
                          {(opp.status === 'new' || opp.status === 'researching') && (
                            <Button type="button" size="dense" variant="brand" className="h-8 rounded-lg"
                              onClick={() => updateStatus.mutate({ masterAgentId, opportunityId: opp.id, status: 'qualified' })}>
                              Qualify
                            </Button>
                          )}
                          {opp.status !== 'skipped' && opp.status !== 'converted' && (
                            <Button type="button" size="dense" variant="ghost" className="h-8 rounded-lg text-ink-3"
                              onClick={() => updateStatus.mutate({ masterAgentId, opportunityId: opp.id, status: 'skipped' })}>
                              Skip
                            </Button>
                          )}
                        </div>
                      </div>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
