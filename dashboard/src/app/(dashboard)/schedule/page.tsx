'use client';

import { useState } from 'react';
import { useUpcomingActions } from '@/hooks/use-schedule';
import { Skeleton } from '@/components/ui/skeleton';
import { ActionTimeline } from '@/components/schedule/action-timeline';
import { HomeSection, StatCard } from '@/components/home/home-parts';
import { cn } from '@/lib/utils';

const FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'emails', label: 'Emails' },
  { key: 'tasks', label: 'Agent tasks' },
] as const;

export default function SchedulePage() {
  const [filter, setFilter] = useState<'all' | 'emails' | 'tasks'>('all');
  const { data: actions, isLoading } = useUpcomingActions({ filter });

  const items = actions ?? [];
  const emailCount = items.filter((a) => a.type === 'email').length;
  const taskCount = items.filter((a) => a.type === 'task').length;

  return (
    <div className="mx-auto flex max-w-[940px] flex-col gap-4 p-5">
      {/* Summary */}
      <div>
        <div className="mb-2 flex items-baseline gap-2 px-1 text-2xs font-medium uppercase tracking-[0.09em] text-ink-4">
          <span>Upcoming</span>
          <span className="normal-case tracking-normal text-ink-3">emails and agent tasks, in the order they run</span>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <StatCard
            label="Queued emails"
            value={isLoading ? '—' : emailCount.toLocaleString()}
            detail={emailCount === 0 ? 'Nothing queued' : 'Waiting to be sent'}
            muted={!isLoading && emailCount === 0}
          />
          <StatCard
            label="Active tasks"
            value={isLoading ? '—' : taskCount.toLocaleString()}
            detail={taskCount === 0 ? 'No agent tasks running' : 'Agents working on these'}
            muted={!isLoading && taskCount === 0}
          />
        </div>
      </div>

      {/* Timeline */}
      <HomeSection
        title="Timeline"
        meta={
          <div className="flex items-center gap-1 rounded-lg border border-line bg-bg-soft p-0.5" role="tablist" aria-label="Filter timeline">
            {FILTERS.map((f) => (
              <button
                key={f.key}
                type="button"
                role="tab"
                aria-selected={filter === f.key}
                onClick={() => setFilter(f.key)}
                className={cn(
                  'rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
                  filter === f.key ? 'bg-bg-panel text-ink shadow-sm' : 'text-ink-3 hover:text-ink',
                )}
              >
                {f.label}
              </button>
            ))}
          </div>
        }
      >
        {isLoading ? (
          <div className="space-y-2 border-t border-line p-4">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-12 w-full rounded-lg" />
            ))}
          </div>
        ) : (
          <ActionTimeline items={items} />
        )}
      </HomeSection>
    </div>
  );
}
