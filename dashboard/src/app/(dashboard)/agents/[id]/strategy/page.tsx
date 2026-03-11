'use client';

import { useState } from 'react';
import { useParams } from 'next/navigation';
import { useStrategyHistory } from '@/hooks/use-strategy';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { formatDate } from '@/lib/utils';
import { Brain, CheckCircle2, XCircle, Clock, ChevronDown, ChevronUp, ArrowLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import Link from 'next/link';
import type { DailyStrategy, StrategyExecutionStatus } from '@/types';

const STATUS_BADGE: Record<StrategyExecutionStatus, { variant: 'default' | 'secondary' | 'outline' | 'destructive'; label: string }> = {
  pending: { variant: 'secondary', label: 'Pending' },
  analyzing: { variant: 'outline', label: 'Analyzing' },
  executing: { variant: 'outline', label: 'Executing' },
  completed: { variant: 'default', label: 'Completed' },
  failed: { variant: 'destructive', label: 'Failed' },
};

export default function StrategyHistoryPage() {
  const { id } = useParams<{ id: string }>();
  const { data, isLoading } = useStrategyHistory(id);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const strategies = (data as any as DailyStrategy[]) ?? [];

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-10" />
        <Skeleton className="h-32" />
        <Skeleton className="h-32" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Link href={`/agents/${id}`}>
          <Button variant="ghost" size="sm">
            <ArrowLeft className="w-4 h-4 mr-1" />
            Back
          </Button>
        </Link>
        <h1 className="text-lg font-bold flex items-center gap-2">
          <Brain className="w-5 h-5 text-violet-500" />
          Strategy History
        </h1>
      </div>

      {strategies.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <Brain className="w-10 h-10 text-muted-foreground mx-auto mb-3" />
            <p className="text-muted-foreground">No strategy runs yet.</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {strategies.map((strategy) => {
            const isExpanded = expandedId === strategy.id;
            const badge = STATUS_BADGE[strategy.executionStatus] ?? STATUS_BADGE.pending;
            const decisions = strategy.strategyDecisions as Record<string, any> | undefined;
            const plan = (strategy.actionPlan as any)?.plan as string[] | undefined;

            return (
              <Card key={strategy.id}>
                <CardHeader
                  className="pb-2 cursor-pointer"
                  onClick={() => setExpandedId(isExpanded ? null : strategy.id)}
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <CardTitle className="text-sm font-medium">{strategy.strategyDate}</CardTitle>
                      <Badge variant={badge.variant as any} className="text-xs">{badge.label}</Badge>
                    </div>
                    <div className="flex items-center gap-2">
                      {strategy.executedAt && (
                        <span className="text-xs text-muted-foreground">{formatDate(strategy.executedAt)}</span>
                      )}
                      {isExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                    </div>
                  </div>
                  {decisions?.overall_assessment && !isExpanded && (
                    <p className="text-xs text-muted-foreground mt-1 line-clamp-1">{decisions.overall_assessment}</p>
                  )}
                </CardHeader>

                {isExpanded && (
                  <CardContent className="space-y-4 pt-0">
                    {decisions?.overall_assessment && (
                      <div>
                        <p className="text-xs font-medium text-muted-foreground mb-1">Assessment</p>
                        <p className="text-sm">{decisions.overall_assessment}</p>
                      </div>
                    )}

                    {decisions?.search_query_changes && (
                      <div>
                        <p className="text-xs font-medium text-muted-foreground mb-1">Search Query Changes</p>
                        <div className="flex flex-wrap gap-1">
                          {decisions.search_query_changes.add?.map((q: string, i: number) => (
                            <Badge key={`add-${i}`} variant="default" className="text-xs">+ {q}</Badge>
                          ))}
                          {decisions.search_query_changes.remove?.map((q: string, i: number) => (
                            <Badge key={`rm-${i}`} variant="destructive" className="text-xs">- {q}</Badge>
                          ))}
                        </div>
                        {decisions.search_query_changes.reasoning && (
                          <p className="text-xs text-muted-foreground mt-1">{decisions.search_query_changes.reasoning}</p>
                        )}
                      </div>
                    )}

                    {decisions?.email_strategy && (
                      <div>
                        <p className="text-xs font-medium text-muted-foreground mb-1">Email Strategy</p>
                        <p className="text-sm">{decisions.email_strategy.reasoning}</p>
                      </div>
                    )}

                    {plan && plan.length > 0 && (
                      <div>
                        <p className="text-xs font-medium text-muted-foreground mb-1">Plan</p>
                        <ul className="space-y-1">
                          {plan.map((item, i) => (
                            <li key={i} className="text-sm flex items-start gap-2">
                              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500 mt-0.5 shrink-0" />
                              {item}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {strategy.error && (
                      <div className="text-sm text-destructive bg-destructive/10 p-2 rounded">
                        {strategy.error}
                      </div>
                    )}
                  </CardContent>
                )}
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
