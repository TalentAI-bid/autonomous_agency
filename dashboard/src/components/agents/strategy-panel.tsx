'use client';

import Link from 'next/link';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { useLatestStrategy, useTriggerStrategy } from '@/hooks/use-strategy';
import { Button } from '@/components/ui/button';
import { cn, formatDate } from '@/lib/utils';
import { Brain, Play, AlertCircle, CheckCircle2, Clock, Loader2, History } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';

const STATUS_CONFIG: Record<string, { icon: typeof CheckCircle2; tone: string; spin?: boolean; label: string }> = {
  pending: { icon: Clock, tone: 'bg-bg-sub text-ink-3', label: 'Pending' },
  analyzing: { icon: Loader2, tone: 'bg-info/10 text-info', spin: true, label: 'Analyzing' },
  executing: { icon: Loader2, tone: 'bg-warn/15 text-warn-fg', spin: true, label: 'Executing' },
  completed: { icon: CheckCircle2, tone: 'bg-up/10 text-up', label: 'Completed' },
  failed: { icon: AlertCircle, tone: 'bg-down/10 text-down', label: 'Failed' },
};

const label = 'mb-1.5 text-3xs font-medium uppercase tracking-[0.09em] text-ink-4';

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
    <Card as="section" className="overflow-hidden">
      <header className="flex flex-wrap items-center gap-3 border-b border-line px-5 py-3.5">
        <span className="grid size-7 place-items-center rounded-row bg-accent-weak text-accent-fg">
          <Brain size={14} />
        </span>
        <div className="mr-auto min-w-0">
          <h2 className="m-0 text-body font-semibold text-ink">Daily strategy</h2>
          <p className="mb-0 mt-0.5 text-xs text-ink-3">Reviews results every day at 6 AM UTC and adjusts the plan.</p>
        </div>
        <Link href={`/agents/${masterAgentId}/strategy`} className="inline-flex items-center gap-1 text-xs font-medium text-accent-fg hover:underline">
          <History size={12} /> View history
        </Link>
        <Button size="sm" type="button" variant="panel" onClick={handleTrigger} disabled={triggerStrategy.isPending}>
          {triggerStrategy.isPending ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />}
          Run now
        </Button>
      </header>

      <div className="p-5">
        {isLoading ? (
          <p className="m-0 py-6 text-center text-body text-ink-3">Loading…</p>
        ) : !strategy ? (
          <div className="py-8 text-center">
            <p className="m-0 text-body font-medium text-ink">No strategy runs yet</p>
            <p className="mb-0 mt-1 text-xs text-ink-3">It runs daily at 6 AM UTC, or you can trigger it manually.</p>
          </div>
        ) : (
          <div className="space-y-5">
            <div className="flex flex-wrap items-center gap-3">
              {statusInfo && (
                <span className={cn('inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium', statusInfo.tone)}>
                  <statusInfo.icon size={12} className={statusInfo.spin ? 'animate-spin' : undefined} />
                  {statusInfo.label}
                </span>
              )}
              <span className="text-xs text-ink-3">
                {strategy.strategyDate} {strategy.executedAt && `· executed ${formatDate(strategy.executedAt)}`}
              </span>
            </div>

            {decisions?.overall_assessment && (
              <div>
                <div className={label}>Assessment</div>
                <p className="m-0 text-body leading-relaxed text-ink-2">{decisions.overall_assessment}</p>
              </div>
            )}

            {(decisions?.search_query_changes?.add?.length ?? 0) > 0 && (
              <div>
                <div className={label}>New search queries</div>
                <div className="flex flex-wrap gap-1.5">
                  {decisions!.search_query_changes.add.map((q: string, i: number) => (
                    <Badge key={i} variant="accent">
                      {q}
                    </Badge>
                  ))}
                </div>
              </div>
            )}

            {decisions?.email_strategy?.angle_change && (
              <div>
                <div className={label}>Email strategy</div>
                <p className="m-0 text-body leading-relaxed text-ink-2">{decisions.email_strategy.angle_change}</p>
              </div>
            )}

            {plan && plan.length > 0 && (
              <div>
                <div className={label}>Today&apos;s plan</div>
                <ol className="m-0 list-none space-y-2 p-0">
                  {plan.map((item, i) => (
                    <li key={i} className="flex items-start gap-2.5 text-body text-ink-2">
                      <span className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full bg-bg-sub font-mono text-2xs text-ink-3">{i + 1}</span>
                      {item}
                    </li>
                  ))}
                </ol>
              </div>
            )}

            {strategy.error && <div className="rounded-card border border-down/30 bg-down/5 px-3 py-2 text-body text-down">{strategy.error}</div>}
          </div>
        )}
      </div>
    </Card>
  );
}
