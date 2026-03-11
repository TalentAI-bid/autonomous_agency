'use client';

import { useLatestStrategy, useTriggerStrategy } from '@/hooks/use-strategy';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { formatDate } from '@/lib/utils';
import { Brain, Play, AlertCircle, CheckCircle2, Clock, Loader2 } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import Link from 'next/link';

const STATUS_CONFIG: Record<string, { icon: typeof CheckCircle2; color: string; label: string }> = {
  pending: { icon: Clock, color: 'text-muted-foreground', label: 'Pending' },
  analyzing: { icon: Loader2, color: 'text-blue-500', label: 'Analyzing' },
  executing: { icon: Loader2, color: 'text-amber-500', label: 'Executing' },
  completed: { icon: CheckCircle2, color: 'text-emerald-500', label: 'Completed' },
  failed: { icon: AlertCircle, color: 'text-destructive', label: 'Failed' },
};

interface StrategyPanelProps {
  masterAgentId: string;
}

export function StrategyPanel({ masterAgentId }: StrategyPanelProps) {
  const { data: latest, isLoading } = useLatestStrategy(masterAgentId);
  const triggerStrategy = useTriggerStrategy();
  const { toast } = useToast();

  const strategy = latest as any;

  async function handleTrigger() {
    try {
      await triggerStrategy.mutateAsync(masterAgentId);
      toast({ title: 'Strategy run triggered' });
    } catch {
      toast({ title: 'Failed to trigger strategy', variant: 'destructive' });
    }
  }

  const statusInfo = strategy ? STATUS_CONFIG[strategy.executionStatus] ?? STATUS_CONFIG.pending : null;
  const decisions = strategy?.strategyDecisions as Record<string, any> | undefined;
  const plan = (strategy?.actionPlan as any)?.plan as string[] | undefined;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Brain className="w-4 h-4 text-violet-500" />
              Daily Strategy
            </CardTitle>
            <div className="flex items-center gap-2">
              <Link
                href={`/agents/${masterAgentId}/strategy`}
                className="text-xs text-muted-foreground hover:text-foreground transition-colors"
              >
                View History
              </Link>
              <Button
                size="sm"
                variant="outline"
                onClick={handleTrigger}
                disabled={triggerStrategy.isPending}
                className="h-7 text-xs"
              >
                <Play className="w-3 h-3 mr-1" />
                Run Now
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <p className="text-sm text-muted-foreground text-center py-6">Loading...</p>
          ) : !strategy ? (
            <p className="text-sm text-muted-foreground text-center py-6">
              No strategy runs yet. The strategy agent runs daily at 6 AM UTC, or trigger manually.
            </p>
          ) : (
            <div className="space-y-4">
              <div className="flex items-center gap-3">
                {statusInfo && (
                  <Badge variant="outline" className="text-xs flex items-center gap-1">
                    <statusInfo.icon className={`w-3 h-3 ${statusInfo.color}`} />
                    {statusInfo.label}
                  </Badge>
                )}
                <span className="text-xs text-muted-foreground">
                  {strategy.strategyDate} {strategy.executedAt && `- Executed ${formatDate(strategy.executedAt)}`}
                </span>
              </div>

              {decisions?.overall_assessment && (
                <div>
                  <p className="text-xs font-medium text-muted-foreground mb-1">Assessment</p>
                  <p className="text-sm">{decisions.overall_assessment}</p>
                </div>
              )}

              {(decisions?.search_query_changes?.add?.length ?? 0) > 0 && (
                <div>
                  <p className="text-xs font-medium text-muted-foreground mb-1">New Search Queries</p>
                  <div className="flex flex-wrap gap-1">
                    {decisions!.search_query_changes.add.map((q: string, i: number) => (
                      <Badge key={i} variant="secondary" className="text-xs">{q}</Badge>
                    ))}
                  </div>
                </div>
              )}

              {decisions?.email_strategy?.angle_change && (
                <div>
                  <p className="text-xs font-medium text-muted-foreground mb-1">Email Strategy</p>
                  <p className="text-sm">{decisions.email_strategy.angle_change}</p>
                </div>
              )}

              {plan && plan.length > 0 && (
                <div>
                  <p className="text-xs font-medium text-muted-foreground mb-1">Today&apos;s Plan</p>
                  <ul className="space-y-1">
                    {plan.map((item, i) => (
                      <li key={i} className="text-sm flex items-start gap-2">
                        <span className="text-muted-foreground shrink-0">{i + 1}.</span>
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
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
