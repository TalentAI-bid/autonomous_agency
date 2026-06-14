'use client';

import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { formatDate, cn } from '@/lib/utils';
import type { Company, MasterAgent } from '@/types';
import Link from 'next/link';
import { ExternalLink, Building2 } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface CompanyTableProps {
  companies: Company[];
  agentsById: Map<string, MasterAgent>;
  isLoading: boolean;
}

type AgentTypeLabel = { label: string; variant: 'success' | 'blue' | 'purple' | 'secondary' };

function agentTypeFromConfig(agent: MasterAgent | undefined): AgentTypeLabel {
  const strategy = (agent?.config as Record<string, unknown> | undefined)?.bdStrategy;
  switch (strategy) {
    case 'hiring_signal':
      return { label: 'Hiring', variant: 'success' };
    case 'industry_target':
      return { label: 'Industry', variant: 'blue' };
    case 'hybrid':
      return { label: 'Hybrid', variant: 'purple' };
    default:
      return { label: '—', variant: 'secondary' };
  }
}

function readFitScore(company: Company): number | null {
  const fitScore = company.rawData?.fitScore?.buyer_fit_score;
  if (typeof fitScore === 'number') return Math.round(fitScore);
  const legacy = company.rawData?.triage?.fit_score;
  if (typeof legacy === 'number') return Math.round(legacy);
  return null;
}

function fitColorClass(score: number | null): string {
  if (score == null) return 'text-muted-foreground';
  if (score >= 80) return 'text-emerald-400 font-semibold';
  if (score >= 60) return 'text-amber-400 font-medium';
  return 'text-muted-foreground';
}

export function CompanyTable({ companies, agentsById, isLoading }: CompanyTableProps) {
  if (isLoading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-12" />)}
      </div>
    );
  }

  if (companies.length === 0) {
    return (
      <div className="text-center py-16 text-muted-foreground">
        <Building2 className="w-8 h-8 mx-auto mb-3" />
        <p className="font-medium">No companies found</p>
        <p className="text-sm mt-1">Companies will appear here once agents discover them</p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border overflow-hidden">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Company</TableHead>
            <TableHead>Agent</TableHead>
            <TableHead>Type</TableHead>
            <TableHead>Fit</TableHead>
            <TableHead>Tags</TableHead>
            <TableHead>Industry</TableHead>
            <TableHead>Created</TableHead>
            <TableHead className="w-10"></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {companies.map((company) => {
            const agent = company.masterAgentId ? agentsById.get(company.masterAgentId) : undefined;
            const agentType = agentTypeFromConfig(agent);
            const fit = readFitScore(company);
            const tech = company.techStack ?? [];
            const fitSignals = company.rawData?.fitScore?.signals;
            const hiringChip = (fitSignals?.hiring_signals?.length ?? 0) > 0;
            const fundedChip = (fitSignals?.funding_signals?.length ?? 0) > 0;
            const techShown = tech.slice(0, 3);
            const techExtra = tech.length - techShown.length;

            return (
              <TableRow key={company.id} className="hover:bg-muted/30">
                <TableCell className="font-medium">
                  <div className="min-w-0">
                    <p className="truncate">{company.name}</p>
                    {company.domain && (
                      <p className="text-xs text-muted-foreground truncate">{company.domain}</p>
                    )}
                  </div>
                </TableCell>
                <TableCell className="text-sm">
                  {company.masterAgentId ? (
                    <Link
                      href={`/agents/${company.masterAgentId}`}
                      className="text-blue-400 hover:underline truncate"
                    >
                      {agent?.name ?? '—'}
                    </Link>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </TableCell>
                <TableCell>
                  <Badge variant={agentType.variant}>{agentType.label}</Badge>
                </TableCell>
                <TableCell>
                  <span className={cn('text-sm tabular-nums', fitColorClass(fit))}>
                    {fit != null ? `${fit}%` : '—'}
                  </span>
                </TableCell>
                <TableCell>
                  <div className="flex flex-wrap gap-1 max-w-[260px]">
                    {hiringChip && (
                      <Badge variant="success" className="text-[10px]">Hiring</Badge>
                    )}
                    {fundedChip && (
                      <Badge variant="blue" className="text-[10px]">Funded</Badge>
                    )}
                    {techShown.map((t) => (
                      <Badge key={t} variant="secondary" className="text-[10px]">{t}</Badge>
                    ))}
                    {techExtra > 0 && (
                      <Badge variant="outline" className="text-[10px]">+{techExtra}</Badge>
                    )}
                    {!hiringChip && !fundedChip && techShown.length === 0 && (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </div>
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {company.industry || '—'}
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {formatDate(company.createdAt)}
                </TableCell>
                <TableCell>
                  {company.masterAgentId && (
                    <Link href={`/agents/${company.masterAgentId}/companies/${company.id}`}>
                      <Button variant="ghost" size="icon" className="h-7 w-7">
                        <ExternalLink className="w-3.5 h-3.5" />
                      </Button>
                    </Link>
                  )}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
