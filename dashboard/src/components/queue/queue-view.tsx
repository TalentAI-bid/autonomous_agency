'use client';

import * as React from 'react';
import { ChevronDown, Info, Loader2, RefreshCw } from 'lucide-react';
import { useQueue, useRefreshQueue } from '@/hooks/use-queue';
import { useAgents } from '@/hooks/use-agents';
import { ActionCard, PRIORITY_TONE } from '@/components/queue/action-card';
import { ClearedCard, NoAgentCard, ReplyDetectionBanner } from '@/components/queue/queue-parts';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { AgentFilter } from '@/components/queue/agent-filter';
import { Skeleton } from '@/components/ui/skeleton';
import { useRealtimeStore } from '@/stores/realtime.store';

const PRIORITY_DEFAULTS = { P0: true, P1: true, P2: false, P3: false } as const;
const PRIORITY_DESC: Record<string, string> = {
  P0: 'Do first — hot',
  P1: 'Today',
  P2: 'This week',
  P3: 'Background',
};

interface QueueViewProps {
  /** When set, scopes the queue to actions whose company.master_agent_id matches. */
  masterAgentId?: string;
  /** Full-page layout: reply-detection banner, agent filter and "Skip all" toolbar. */
  showGreeting?: boolean;
}

export function QueueView({ masterAgentId, showGreeting: page = false }: QueueViewProps) {
  const [agentFilter, setAgentFilter] = React.useState('');
  const scope = masterAgentId ?? (agentFilter || undefined);
  const { data, isLoading } = useQueue(scope);
  const { data: agents } = useAgents();
  const refreshMut = useRefreshQueue();
  const lastManualRefreshAt = useRealtimeStore((s) => s.lastManualRefreshAt);

  const [expanded, setExpanded] = React.useState<Record<string, boolean>>(PRIORITY_DEFAULTS);
  const toggle = (p: string) => setExpanded((e) => ({ ...e, [p]: !e[p] }));

  // The triage worker takes 30–120s to generate drafts for up to 15 actions.
  // Show a banner while the safety-net polling window is open OR the mutation
  // is in flight, so the user has visual feedback between click and result.
  const [, setTick] = React.useState(0);
  React.useEffect(() => {
    if (!lastManualRefreshAt) return;
    const t = setInterval(() => setTick((x) => x + 1), 5_000);
    return () => clearInterval(t);
  }, [lastManualRefreshAt]);
  const refreshInFlight = refreshMut.isPending || lastManualRefreshAt != null;
  const refreshElapsedMs = lastManualRefreshAt ? Date.now() - lastManualRefreshAt : 0;
  const refreshTimedOut = lastManualRefreshAt != null && refreshElapsedMs >= 115_000;

  const quota = data?.refreshQuota ?? { remaining: 3, limit: 3, resetAt: '' };
  const quotaExhausted = quota.remaining <= 0;
  const resetLocal = quota.resetAt
    ? new Date(quota.resetAt).toLocaleString(undefined, {
        hour: 'numeric',
        minute: '2-digit',
        month: 'short',
        day: 'numeric',
      })
    : '';
  const refreshLabel = refreshMut.isPending
    ? 'Refreshing…'
    : `Refresh queue (${quota.remaining}/${quota.limit} today)`;
  const refreshTitle = quotaExhausted
    ? `Next manual refresh available at ${resetLocal}. The 06:00 UTC run still happens automatically.`
    : `${quota.remaining} of ${quota.limit} manual refreshes left today.`;

  function refresh() {
    refreshMut.mutate();
  }

  const refreshBanner = refreshInFlight ? (
    <div
      role="status"
      className="flex items-center gap-3 rounded-row border border-accent-line bg-accent-tint px-3.5 py-2.5 text-body text-accent-fg"
    >
      {refreshTimedOut ? (
        <Info size={15} className="shrink-0" />
      ) : (
        <Loader2 size={15} className="shrink-0 animate-spin" />
      )}
      <p className="m-0 min-w-0 flex-1">
        {refreshTimedOut ? (
          "No matching actions found for today's rules. Try again after adding more prospects, or check back tomorrow."
        ) : (
          <>
            <strong className="font-semibold">Triage running</strong> — new actions should appear within about a minute.
          </>
        )}
      </p>
    </div>
  ) : null;

  const handled = data?.handledToday;
  const handledCount = handled ? handled.approved + handled.skipped : null;
  const waiting = data?.count ?? 0;

  const toolbar = page ? (
    <div className="flex flex-wrap items-center gap-3 rounded-row border border-line bg-bg-panel px-3 py-2">
      <AgentFilter agents={agents ?? []} value={agentFilter} onChange={setAgentFilter} />
      <span className="text-xs text-ink-3">
        {waiting} waiting{handledCount != null ? ` · ${handledCount} handled today` : ''}
      </span>
      <Button size="sm"
        type="button"
        variant="panel"
        disabled
        title={waiting === 0 ? undefined : 'Bulk skip is not available yet'}
        className="ml-auto"
      >
        {waiting === 0 ? 'Skip all — nothing to skip' : `Skip all (${waiting})`}
      </Button>
    </div>
  ) : null;

  if (page && !masterAgentId && agents && agents.length === 0) return <NoAgentCard />;

  if (isLoading || (page && !agents)) {
    return (
      <Skeleton className="h-72 rounded-2xl" />
    );
  }

  if (!data || data.count === 0) {
    const summary = [
      handled ? `You approved ${handled.approved} and skipped ${handled.skipped}.` : 'Nothing is waiting for your approval.',
      quotaExhausted
        ? `The next batch is drafted at 06:00 UTC tomorrow. Manual refresh limit reached — resets ${resetLocal}.`
        : 'The next batch is drafted at 06:00 UTC tomorrow, or you can pull one now.',
    ].join(' ');
    return (
      <div className="flex flex-col gap-4">
        {page && <ReplyDetectionBanner />}
        {toolbar}
        {refreshBanner}
        <ClearedCard
          summary={summary}
          quotaText={`${quota.remaining} of ${quota.limit} daily refreshes left`}
          exhausted={quotaExhausted}
          pending={refreshMut.isPending}
          remaining={quota.remaining}
          limit={quota.limit}
          onRefresh={refresh}
          title={refreshTitle}
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {page && <ReplyDetectionBanner />}
      {toolbar}
      {refreshBanner}

      <section className="rounded-2xl border border-line bg-bg-panel shadow-sm">
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-3.5">
          <div>
            <h2 className="m-0 text-body font-semibold text-ink">Waiting for your approval</h2>
            <p className="mb-0 mt-0.5 text-xs text-ink-3">
              <strong className="font-semibold text-ink-2">{data.count}</strong> {data.count === 1 ? 'action' : 'actions'} · about{' '}
              <strong className="font-semibold text-ink-2">{data.etaMinutes}</strong> min
            </p>
          </div>
          <Button size="sm" type="button" variant="panel" onClick={refresh} disabled={refreshMut.isPending || quotaExhausted} title={refreshTitle}>
            {refreshMut.isPending ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />} {refreshLabel}
          </Button>
        </header>

        <div className="divide-y divide-line">
          {data.buckets.map((b) => {
            if (b.count === 0) return null;
            const open = expanded[b.priority];
            return (
              <div key={b.priority}>
                <button
                  type="button"
                  onClick={() => toggle(b.priority)}
                  aria-expanded={open}
                  className="flex w-full cursor-pointer items-center gap-2.5 border-0 bg-bg-sub px-5 py-2.5 text-left text-ink transition-colors hover:bg-hover"
                >
                  <span className={cn('rounded-tag px-2 py-0.5 text-2xs font-semibold', PRIORITY_TONE[b.priority] ?? PRIORITY_TONE.P3)}>{b.priority}</span>
                  <span className="text-body font-medium">{PRIORITY_DESC[b.priority] ?? b.priority}</span>
                  <span className="text-xs text-ink-3">{b.count}</span>
                  <ChevronDown size={14} className={cn('ml-auto text-ink-4 transition-transform', open && 'rotate-180')} />
                </button>
                {open && (
                  <ul className="m-0 list-none divide-y divide-line p-0">
                    {b.actions.map(({ action, company, recommendedContact }) => (
                      <ActionCard key={action.id} action={action} company={company} contact={recommendedContact} />
                    ))}
                  </ul>
                )}
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}
