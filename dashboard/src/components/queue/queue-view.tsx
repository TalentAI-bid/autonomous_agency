'use client';

import * as React from 'react';
import { Info, Loader2 } from 'lucide-react';
import { useQueue, useRefreshQueue } from '@/hooks/use-queue';
import { useAgents } from '@/hooks/use-agents';
import { ActionCard } from '@/components/queue/action-card';
import { ClearedCard, NoAgentCard, ReplyDetectionBanner } from '@/components/queue/queue-parts';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
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
      <Button
        type="button"
        variant="panel"
        size="dense"
        disabled
        title={waiting === 0 ? undefined : 'Bulk skip is not available yet'}
        className="ml-auto h-8 rounded-lg px-3 text-xs font-medium"
      >
        {waiting === 0 ? 'Skip all — nothing to skip' : `Skip all (${waiting})`}
      </Button>
    </div>
  ) : null;

  if (page && !masterAgentId && agents && agents.length === 0) return <NoAgentCard />;

  if (isLoading || (page && !agents)) {
    return (
      <div className="flex flex-col gap-3">
        <Skeleton className="h-12" />
        {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-24" />)}
      </div>
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
      <div className="flex flex-wrap items-end justify-between gap-3">
        <p className="text-body text-ink-3">
          <strong className="text-ink">{data.count}</strong> actions
          {' · ~'}<strong className="text-ink">{data.etaMinutes}</strong> min estimated
        </p>
        <Button variant="outline" onClick={refresh} disabled={refreshMut.isPending || quotaExhausted} title={refreshTitle}>
          {refreshLabel}
        </Button>
      </div>

      {refreshBanner}

      {data.buckets.map((b) => {
        if (b.count === 0) return null;
        const open = expanded[b.priority];
        return (
          <div key={b.priority} className="flex flex-col gap-2">
            <button
              onClick={() => toggle(b.priority)}
              className="flex cursor-pointer items-center gap-2.5 border-0 bg-transparent px-0 py-2 text-left text-ink"
            >
              <Badge variant={
                b.priority === 'P0' ? 'error' :
                b.priority === 'P1' ? 'warning' :
                b.priority === 'P2' ? 'blue' : 'outline'
              }>
                {b.priority}
              </Badge>
              <span className="text-[14px] font-medium">
                {PRIORITY_DESC[b.priority] ?? b.priority}
              </span>
              <span className="text-label text-ink-3">({b.count})</span>
              <span className="ml-auto text-label text-ink-3">
                {open ? '▼' : '▶'}
              </span>
            </button>
            {open && (
              <div className="flex flex-col gap-2">
                {b.actions.map(({ action, company, recommendedContact }) => (
                  <ActionCard key={action.id} action={action} company={company} contact={recommendedContact} />
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
