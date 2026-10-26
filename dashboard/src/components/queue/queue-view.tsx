'use client';

import * as React from 'react';
import { useQueue, useRefreshQueue } from '@/hooks/use-queue';
import { ActionCard } from '@/components/queue/action-card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { useAuthStore } from '@/stores/auth.store';
import { useRealtimeStore } from '@/stores/realtime.store';
import { CheckCircle2 } from 'lucide-react';
import { EmptyState } from '@/components/shared/empty-state';

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
  /** Show the time-of-day greeting + action count header. */
  showGreeting?: boolean;
}

export function QueueView({ masterAgentId, showGreeting = false }: QueueViewProps) {
  const user = useAuthStore((s) => s.user);
  const { data, isLoading } = useQueue(masterAgentId);
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

  const greeting = greetByHour();
  const name = user?.name?.split(' ')[0] ?? '';

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
      className="flex items-center gap-2 py-2.5 px-3 border border-border rounded-row bg-bg-panel text-body text-ink-2"
    >
      <span className="text-[14px]">{refreshTimedOut ? 'ℹ️' : '🔄'}</span>
      <span>
        {refreshTimedOut
          ? "No matching actions found for today's rules. Try again after adding more prospects, or check back tomorrow."
          : 'Triage running — new actions should appear within ~1 minute.'}
      </span>
    </div>
  ) : null;

  if (isLoading) {
    return (
      <div className="flex flex-col gap-3">
        <Skeleton className="h-16"/>
        {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-24"/>)}
      </div>
    );
  }

  if (!data || data.count === 0) {
    return (
      <div className="flex flex-col gap-4">
        {refreshBanner}
        <EmptyState
          icon={CheckCircle2}
          title="✅ Queue cleared for today"
          description={
            quotaExhausted
              ? `Tomorrow's queue runs at 6 AM UTC. Manual refresh limit reached — resets ${resetLocal}.`
              : "Tomorrow's queue runs at 6 AM UTC. You can also refresh now."
          }
          action={
            <Button
              onClick={refresh}
              disabled={refreshMut.isPending || quotaExhausted}
              title={refreshTitle}
            >
              {refreshMut.isPending
                ? 'Refreshing…'
                : quotaExhausted
                  ? `Limit reached (0/${quota.limit})`
                  : `Refresh now (${quota.remaining}/${quota.limit})`}
            </Button>
          }
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex justify-between items-end flex-wrap gap-3">
        {showGreeting ? (
          <div>
            <h1 className="text-stat font-semibold">
              {greeting}{name ? `, ${name}` : ''}.
            </h1>
            <p className="text-body text-ink-3">
              <strong className="text-ink">{data.count}</strong> actions today
              {' · ~'}<strong className="text-ink">{data.etaMinutes}</strong> min estimated
            </p>
          </div>
        ) : (
          <p className="text-body text-ink-3">
            <strong className="text-ink">{data.count}</strong> actions
            {' · ~'}<strong className="text-ink">{data.etaMinutes}</strong> min estimated
          </p>
        )}
        <Button
          variant="outline"
          onClick={refresh}
          disabled={refreshMut.isPending || quotaExhausted}
          title={refreshTitle}
        >
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
              className="flex items-center gap-2.5 py-2 px-0 bg-transparent border-0 text-ink cursor-pointer text-left"
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

function greetByHour(): string {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
}
