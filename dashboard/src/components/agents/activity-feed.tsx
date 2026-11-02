'use client';

import { useState } from 'react';
import { CheckCircle2, Clock, Loader2, Pause, XCircle } from 'lucide-react';
import { useActivityFeed } from '@/hooks/use-activity';
import { cn, formatDate } from '@/lib/utils';
import type { AgentType } from '@/types';

const AGENT_TYPE_COLORS: Record<string, string> = {
  discovery: 'bg-info/10 text-info',
  enrichment: 'bg-a-master/10 text-a-master',
  scoring: 'bg-warn/10 text-warn-fg',
  outreach: 'bg-up/10 text-up',
  reply: 'bg-a-enrichment/10 text-a-enrichment',
  document: 'bg-info/10 text-info',
  action: 'bg-down/10 text-down',
  strategy: 'bg-a-master/10 text-a-master',
  strategist: 'bg-info/10 text-info',
};

const STATUS = {
  started: { icon: Clock, tone: 'bg-bg-sub text-ink-3' },
  completed: { icon: CheckCircle2, tone: 'bg-up/10 text-up' },
  failed: { icon: XCircle, tone: 'bg-down/10 text-down' },
  skipped: { icon: Pause, tone: 'bg-bg-sub text-ink-3' },
} as const;

const AGENT_TYPES: AgentType[] = ['strategist', 'discovery', 'enrichment', 'scoring', 'outreach', 'reply', 'document', 'action', 'strategy'];

interface ActivityFeedProps {
  masterAgentId: string;
}

export function ActivityFeed({ masterAgentId }: ActivityFeedProps) {
  const [filter, setFilter] = useState<string | undefined>(undefined);
  const { data, isLoading } = useActivityFeed({
    masterAgentId,
    agentType: filter,
    limit: 50,
  });

  const activities = data?.data ?? [];

  return (
    <section className="overflow-hidden rounded-2xl border border-line bg-bg-panel shadow-sm">
      <header className="space-y-3 border-b border-line px-5 py-3.5">
        <div className="flex items-center gap-2">
          <h2 className="m-0 text-body font-semibold text-ink">Activity</h2>
          {activities.length > 0 && (
            <span className="rounded-tag bg-bg-soft px-1.5 font-mono text-2xs leading-[18px] text-ink-3">{activities.length}</span>
          )}
        </div>
        <div className="flex flex-wrap gap-1.5">
          {[undefined, ...AGENT_TYPES].map((type) => {
            const active = filter === type;
            return (
              <button
                key={type ?? 'all'}
                type="button"
                onClick={() => setFilter(type)}
                aria-pressed={active}
                className={cn(
                  'rounded-full border px-2.5 py-0.5 text-xs capitalize transition-colors',
                  active ? 'border-accent-mid bg-accent-weak font-medium text-accent-fg' : 'border-line bg-bg-panel text-ink-3 hover:bg-hover hover:text-ink',
                )}
              >
                {type ?? 'All'}
              </button>
            );
          })}
        </div>
      </header>

      {isLoading ? (
        <div className="flex items-center justify-center gap-2 px-5 py-10 text-body text-ink-3">
          <Loader2 size={15} className="animate-spin" /> Loading activity…
        </div>
      ) : activities.length === 0 ? (
        <p className="m-0 px-5 py-10 text-center text-body text-ink-3">
          {filter ? `No ${filter} activity yet.` : 'No activity logged yet. Run the agent to see activity here.'}
        </p>
      ) : (
        <ul className="scroll-thin m-0 max-h-[560px] list-none divide-y divide-line overflow-y-auto p-0">
          {activities.map((entry: any) => {
            const st = STATUS[entry.status as keyof typeof STATUS] ?? STATUS.started;
            const StatusIcon = st.icon;
            return (
              <li key={entry.id} className="flex items-start gap-3 px-5 py-3 transition-colors hover:bg-bg-soft">
                <span className={cn('mt-0.5 grid size-6 shrink-0 place-items-center rounded-full', st.tone)} title={entry.status}>
                  <StatusIcon size={13} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className={cn('rounded-md px-2 py-0.5 text-2xs font-medium capitalize', AGENT_TYPE_COLORS[entry.agentType] ?? 'bg-bg-sub text-ink-3')}>
                      {entry.agentType}
                    </span>
                    <span className="text-body font-medium text-ink">{entry.action}</span>
                    {entry.durationMs != null && <span className="font-mono text-2xs text-ink-4">{entry.durationMs}ms</span>}
                  </div>
                  {entry.inputSummary && <p className="mb-0 mt-1 truncate text-xs text-ink-3">{entry.inputSummary}</p>}
                  {entry.error && <p className="mb-0 mt-1 truncate text-xs text-down">{entry.error}</p>}
                </div>
                <span className="shrink-0 pt-0.5 text-xs text-ink-4">{formatDate(entry.createdAt)}</span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
