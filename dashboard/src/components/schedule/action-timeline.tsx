'use client';

import { cn, formatDate } from '@/lib/utils';
import { Mail, Bot, CalendarClock } from 'lucide-react';
import { RowIcon } from '@/components/home/home-parts';
import type { ScheduledAction } from '@/types';

interface ActionTimelineProps {
  items: ScheduledAction[];
}

function groupByDate(items: ScheduledAction[]): Map<string, ScheduledAction[]> {
  const groups = new Map<string, ScheduledAction[]>();
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);

  for (const item of items) {
    const itemDate = new Date(item.scheduledAt);
    itemDate.setHours(0, 0, 0, 0);

    let label: string;
    if (itemDate.getTime() === today.getTime()) {
      label = 'Today';
    } else if (itemDate.getTime() === tomorrow.getTime()) {
      label = 'Tomorrow';
    } else {
      label = formatDate(item.scheduledAt, 'EEEE, MMM d');
    }

    if (!groups.has(label)) groups.set(label, []);
    groups.get(label)!.push(item);
  }

  return groups;
}

const STATUS_TONE: Record<string, string> = {
  queued: 'bg-info/10 text-info',
  pending: 'bg-warn/15 text-warn-fg',
  processing: 'bg-accent-weak text-accent-fg',
  sending: 'bg-warn/15 text-warn-fg',
};

export function ActionTimeline({ items }: ActionTimelineProps) {
  if (items.length === 0) {
    return (
      <div className="border-t border-line px-4 py-12 text-center">
        <span className="mx-auto grid size-10 place-items-center rounded-full bg-accent-weak text-accent">
          <CalendarClock size={18} />
        </span>
        <p className="mb-0 mt-3 text-body font-semibold text-ink">Nothing scheduled</p>
        <p className="mx-auto mb-0 mt-1 max-w-sm text-xs leading-relaxed text-ink-3">
          Queued emails and agent tasks will show up here, grouped by day.
        </p>
      </div>
    );
  }

  const groups = groupByDate(items);

  return (
    <div>
      {Array.from(groups.entries()).map(([label, groupItems]) => (
        <div key={label}>
          <div className="flex items-center justify-between border-t border-line bg-bg-sub px-4 py-2">
            <span className="text-2xs font-medium uppercase tracking-[0.09em] text-ink-3">{label}</span>
            <span className="font-mono text-2xs text-ink-4">{groupItems.length}</span>
          </div>
          {groupItems.map((item) => (
            <div key={item.id} className="flex items-center gap-3 border-t border-line px-4 py-3 transition-colors hover:bg-hover">
              <span className="w-12 shrink-0 font-mono text-xs tabular-nums text-ink-3">{formatDate(item.scheduledAt, 'HH:mm')}</span>
              <RowIcon tone={item.type === 'email' ? 'accent' : 'muted'}>
                {item.type === 'email' ? <Mail size={14} /> : <Bot size={14} />}
              </RowIcon>
              <div className="min-w-0 flex-1">
                <p className="m-0 truncate text-body font-medium text-ink">{item.title}</p>
                <p className="m-0 text-xs text-ink-3">{item.type === 'email' ? 'Email' : 'Agent task'}</p>
              </div>
              <span className={cn('shrink-0 rounded-md px-2 py-0.5 text-xs font-medium capitalize', STATUS_TONE[item.status] ?? 'bg-bg-soft text-ink-3')}>
                {item.status.replace(/_/g, ' ')}
              </span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
