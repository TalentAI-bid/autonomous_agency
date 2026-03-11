'use client';

import { useState } from 'react';
import { useParams } from 'next/navigation';
import { useOpportunities, useOpportunityStats, useUpdateOpportunityStatus } from '@/hooks/use-opportunities';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Zap, TrendingUp, Clock, Target, ExternalLink, Building2, User, ChevronDown, ChevronUp } from 'lucide-react';
import type { Opportunity, OpportunityType, OpportunityUrgency, OpportunityStatus } from '@/types';

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
  immediate: 'bg-red-500/10 text-red-500',
  soon: 'bg-orange-500/10 text-orange-500',
  exploring: 'bg-blue-500/10 text-blue-500',
  none: 'bg-gray-500/10 text-gray-400',
};

const STATUS_COLORS: Record<OpportunityStatus, string> = {
  new: 'bg-blue-500/10 text-blue-500',
  researching: 'bg-purple-500/10 text-purple-500',
  qualified: 'bg-emerald-500/10 text-emerald-500',
  contacted: 'bg-amber-500/10 text-amber-500',
  converted: 'bg-green-500/10 text-green-500',
  skipped: 'bg-gray-500/10 text-gray-400',
};

function scoreColor(score: number): string {
  if (score >= 80) return 'text-emerald-500';
  if (score >= 60) return 'text-blue-500';
  if (score >= 40) return 'text-amber-500';
  return 'text-gray-400';
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

  return (
    <div className="space-y-6">
      {/* Stats Cards */}
      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <Card>
            <CardContent className="p-4">
              <div className="flex items-center gap-2">
                <Zap className="w-4 h-4 text-amber-500" />
                <span className="text-sm text-muted-foreground">Total</span>
              </div>
              <p className="text-2xl font-bold mt-1">{stats.total}</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <div className="flex items-center gap-2">
                <TrendingUp className="w-4 h-4 text-emerald-500" />
                <span className="text-sm text-muted-foreground">Avg Intent</span>
              </div>
              <p className={`text-2xl font-bold mt-1 ${scoreColor(stats.avgBuyingIntentScore)}`}>
                {stats.avgBuyingIntentScore}
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <div className="flex items-center gap-2">
                <Clock className="w-4 h-4 text-red-500" />
                <span className="text-sm text-muted-foreground">Immediate</span>
              </div>
              <p className="text-2xl font-bold mt-1">
                {stats.byUrgency?.find((u: any) => u.urgency === 'immediate')?.total ?? 0}
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <div className="flex items-center gap-2">
                <Target className="w-4 h-4 text-blue-500" />
                <span className="text-sm text-muted-foreground">Qualified</span>
              </div>
              <p className="text-2xl font-bold mt-1">
                {stats.byStatus?.find((s: any) => s.status === 'qualified')?.total ?? 0}
              </p>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Filters */}
      <div className="flex gap-2 flex-wrap">
        <select
          value={typeFilter}
          onChange={(e) => setTypeFilter(e.target.value)}
          className="text-sm bg-background border border-border rounded-md px-3 py-1.5"
        >
          <option value="">All Types</option>
          {Object.entries(TYPE_LABELS).map(([k, v]) => (
            <option key={k} value={k}>{v}</option>
          ))}
        </select>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="text-sm bg-background border border-border rounded-md px-3 py-1.5"
        >
          <option value="">All Statuses</option>
          {['new', 'researching', 'qualified', 'contacted', 'converted', 'skipped'].map((s) => (
            <option key={s} value={s}>{s.charAt(0).toUpperCase() + s.slice(1)}</option>
          ))}
        </select>
      </div>

      {/* Opportunity List */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <Zap className="w-4 h-4" />
            Opportunities ({opportunities.length})
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {isLoading ? (
            <p className="text-sm text-muted-foreground text-center py-6">Loading...</p>
          ) : opportunities.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-6">
              No opportunities found. Run the agent in sales mode to discover buying signals.
            </p>
          ) : (
            opportunities.map((opp: Opportunity) => (
              <div key={opp.id} className="border border-border rounded-lg">
                <button
                  onClick={() => setExpandedId(expandedId === opp.id ? null : opp.id)}
                  className="w-full flex items-center justify-between p-3 hover:bg-muted/50 transition-colors"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <span className={`text-lg font-bold tabular-nums ${scoreColor(opp.buyingIntentScore)}`}>
                      {opp.buyingIntentScore}
                    </span>
                    <div className="min-w-0 text-left">
                      <p className="text-sm font-medium truncate">{opp.title}</p>
                      <div className="flex items-center gap-2 mt-0.5">
                        {opp.companyName && (
                          <span className="text-xs text-muted-foreground flex items-center gap-1">
                            <Building2 className="w-3 h-3" />{opp.companyName}
                          </span>
                        )}
                        {opp.personName && (
                          <span className="text-xs text-muted-foreground flex items-center gap-1">
                            <User className="w-3 h-3" />{opp.personName}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 ml-2 shrink-0">
                    <Badge className={`text-xs ${STATUS_COLORS[opp.status]}`}>{opp.status}</Badge>
                    <Badge className={`text-xs ${URGENCY_COLORS[opp.urgency]}`}>{opp.urgency}</Badge>
                    <Badge variant="outline" className="text-xs">{TYPE_LABELS[opp.opportunityType] ?? opp.opportunityType}</Badge>
                    {expandedId === opp.id ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                  </div>
                </button>
                {expandedId === opp.id && (
                  <div className="px-3 pb-3 space-y-3 border-t border-border pt-3">
                    {opp.description && <p className="text-sm text-foreground/80">{opp.description}</p>}
                    <div className="flex flex-wrap gap-4 text-xs text-muted-foreground">
                      {opp.sourcePlatform && <span>Platform: {opp.sourcePlatform}</span>}
                      {opp.budget && <span>Budget: {opp.budget}</span>}
                      {opp.timeline && <span>Timeline: {opp.timeline}</span>}
                      {opp.location && <span>Location: {opp.location}</span>}
                    </div>
                    {opp.technologies && opp.technologies.length > 0 && (
                      <div className="flex flex-wrap gap-1">
                        {opp.technologies.map((t) => (
                          <Badge key={t} variant="secondary" className="text-xs">{t}</Badge>
                        ))}
                      </div>
                    )}
                    <div className="flex items-center gap-2">
                      {opp.sourceUrl && (
                        <a href={opp.sourceUrl} target="_blank" rel="noopener noreferrer"
                          className="text-xs text-blue-400 hover:underline flex items-center gap-1">
                          <ExternalLink className="w-3 h-3" />Source
                        </a>
                      )}
                      <div className="ml-auto flex gap-1">
                        {opp.status === 'new' && (
                          <Button size="sm" variant="outline" className="text-xs h-7"
                            onClick={() => updateStatus.mutate({ masterAgentId, opportunityId: opp.id, status: 'researching' })}>
                            Research
                          </Button>
                        )}
                        {(opp.status === 'new' || opp.status === 'researching') && (
                          <Button size="sm" variant="outline" className="text-xs h-7"
                            onClick={() => updateStatus.mutate({ masterAgentId, opportunityId: opp.id, status: 'qualified' })}>
                            Qualify
                          </Button>
                        )}
                        {opp.status !== 'skipped' && opp.status !== 'converted' && (
                          <Button size="sm" variant="ghost" className="text-xs h-7 text-muted-foreground"
                            onClick={() => updateStatus.mutate({ masterAgentId, opportunityId: opp.id, status: 'skipped' })}>
                            Skip
                          </Button>
                        )}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  );
}
