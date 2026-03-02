'use client';

import { Badge } from '@/components/ui/badge';
import { formatDate } from '@/lib/utils';
import { Mail, Bot } from 'lucide-react';
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

function statusColor(status: string): string {
  const map: Record<string, string> = {
    queued: 'bg-blue-900/30 text-blue-400',
    pending: 'bg-yellow-900/30 text-yellow-400',
    processing: 'bg-purple-900/30 text-purple-400',
    sending: 'bg-amber-900/30 text-amber-400',
  };
  return map[status] ?? 'bg-zinc-800 text-zinc-400';
}

export function ActionTimeline({ items }: ActionTimelineProps) {
  if (items.length === 0) {
    return (
      <div className="text-center py-12">
        <Bot className="w-10 h-10 text-muted-foreground mx-auto mb-3" />
        <p className="text-sm text-muted-foreground">No upcoming actions</p>
      </div>
    );
  }

  const groups = groupByDate(items);

  return (
    <div className="space-y-6">
      {Array.from(groups.entries()).map(([label, groupItems]) => (
        <div key={label}>
          <div className="flex items-center gap-2 mb-3">
            <div className="h-px flex-1 bg-border" />
            <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">{label}</span>
            <div className="h-px flex-1 bg-border" />
          </div>
          <div className="space-y-2">
            {groupItems.map((item) => (
              <div
                key={item.id}
                className="flex items-center gap-3 p-3 rounded-lg bg-muted/30 hover:bg-muted/50 transition-colors"
              >
                <span className="text-xs text-muted-foreground w-14 shrink-0">
                  {formatDate(item.scheduledAt, 'HH:mm')}
                </span>
                <div className="p-1.5 rounded bg-muted">
                  {item.type === 'email' ? (
                    <Mail className="w-3.5 h-3.5 text-blue-400" />
                  ) : (
                    <Bot className="w-3.5 h-3.5 text-purple-400" />
                  )}
                </div>
                <p className="text-sm flex-1 truncate">{item.title}</p>
                <Badge className={statusColor(item.status)}>
                  {item.status}
                </Badge>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
