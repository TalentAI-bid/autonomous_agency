'use client';

import * as React from 'react';
import {
  Mail, Linkedin, StickyNote, ArrowRightLeft, CalendarCheck, UserPlus, Ban, Tag, Circle, ChevronDown, type LucideIcon,
} from 'lucide-react';
import { formatDate, formatRelative, cn } from '@/lib/utils';
import type { TimelineEvent } from '@/lib/api/prospects';

function eventIcon(type: string): { icon: LucideIcon; tone: string } {
  if (type.startsWith('email_')) return { icon: Mail, tone: 'bg-accent-weak text-accent' };
  if (type.startsWith('linkedin_')) return { icon: Linkedin, tone: 'bg-info/10 text-info' };
  if (type === 'note_added') return { icon: StickyNote, tone: 'bg-warn/15 text-warn-fg' };
  if (type === 'stage_change' || type === 'status_change') return { icon: ArrowRightLeft, tone: 'bg-bg-soft text-ink-3' };
  if (type === 'meeting_scheduled') return { icon: CalendarCheck, tone: 'bg-up/10 text-up' };
  if (type === 'contact_added') return { icon: UserPlus, tone: 'bg-accent-weak text-accent' };
  if (type === 'contact_marked_dnc') return { icon: Ban, tone: 'bg-down/10 text-down' };
  if (type === 'contact_tagged' || type === 'contact_untagged') return { icon: Tag, tone: 'bg-bg-soft text-ink-3' };
  return { icon: Circle, tone: 'bg-bg-soft text-ink-4' };
}

function dayKey(d: string) {
  return formatDate(d, 'EEE MMM d, yyyy');
}

export function TimelineFeed({
  events,
  hasMore,
}: {
  events: TimelineEvent[];
  hasMore: boolean;
}) {
  if (events.length === 0) {
    return <div className="px-5 py-12 text-center text-body text-ink-3">No activity yet.</div>;
  }

  const grouped: Record<string, TimelineEvent[]> = {};
  for (const ev of events) {
    const k = dayKey(ev.occurredAt);
    if (!grouped[k]) grouped[k] = [];
    grouped[k].push(ev);
  }

  return (
    <div>
      {Object.entries(grouped).map(([day, items]) => (
        <div key={day}>
          <div className="border-b border-line bg-bg-sub px-5 py-2 text-2xs font-medium uppercase tracking-[0.09em] text-ink-3">{day}</div>
          <div className="divide-y divide-line">
            {items.map((ev) => (
              <EventRow key={ev.id} event={ev} />
            ))}
          </div>
        </div>
      ))}
      {hasMore && <div className="border-t border-line px-5 py-3 text-center text-xs text-ink-3">Older activity is not shown here yet.</div>}
    </div>
  );
}

function EventRow({ event }: { event: TimelineEvent }) {
  const [expanded, setExpanded] = React.useState(false);
  const hasDetail = Boolean(event.description) || Object.keys(event.metadata ?? {}).length > 0;
  const { icon: Icon, tone } = eventIcon(event.type);
  return (
    <div className="px-5 py-3">
      <button
        type="button"
        disabled={!hasDetail}
        onClick={() => setExpanded((v) => !v)}
        className={cn('flex w-full items-center gap-3 border-0 bg-transparent p-0 text-left', hasDetail ? 'cursor-pointer' : 'cursor-default')}
      >
        <span className={cn('grid size-8 shrink-0 place-items-center rounded-full', tone)}>
          <Icon size={14} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-body font-medium text-ink">{event.title ?? event.type.replace(/_/g, ' ')}</div>
          <div className="text-xs capitalize text-ink-3">{event.actorType}</div>
        </div>
        <span className="shrink-0 text-xs text-ink-3">{formatRelative(event.occurredAt)}</span>
        {hasDetail && <ChevronDown size={14} className={cn('shrink-0 text-ink-4 transition-transform', expanded && 'rotate-180')} />}
      </button>
      {expanded && (
        <div className="ml-11 mt-2.5 space-y-2 text-xs text-ink-2">
          {event.description && <div className="whitespace-pre-wrap leading-relaxed">{event.description}</div>}
          {event.metadata && Object.keys(event.metadata).length > 0 && (
            <pre className="m-0 max-h-60 overflow-auto whitespace-pre-wrap rounded-lg border border-line bg-bg-sub p-2.5 font-mono text-2xs text-ink-3">
              {JSON.stringify(event.metadata, null, 2)}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
