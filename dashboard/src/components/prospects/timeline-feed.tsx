'use client';

import * as React from 'react';
import { formatDate, formatRelative, cn } from '@/lib/utils';
import type { TimelineEvent } from '@/lib/api/prospects';

function eventIcon(type: string): string {
  if (type.startsWith('email_')) return '📧';
  if (type.startsWith('linkedin_')) return '💼';
  if (type === 'note_added') return '📝';
  if (type === 'stage_change' || type === 'status_change') return '🔁';
  if (type === 'meeting_scheduled') return '📅';
  if (type === 'contact_added') return '✨';
  if (type === 'contact_marked_dnc') return '⛔';
  if (type === 'contact_tagged' || type === 'contact_untagged') return '🏷️';
  return '·';
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
    return (
      <div
        className="text-center p-8 text-ink-3 border border-border rounded-[8px]"
      >
        No events yet.
      </div>
    );
  }

  const grouped: Record<string, TimelineEvent[]> = {};
  for (const ev of events) {
    const k = dayKey(ev.occurredAt);
    if (!grouped[k]) grouped[k] = [];
    grouped[k].push(ev);
  }

  return (
    <div className="flex flex-col gap-4">
      {Object.entries(grouped).map(([day, items]) => (
        <div key={day}>
          <div
            className="text-xs uppercase tracking-[0.5px] text-ink-3 mb-1.5"
          >
            {day}
          </div>
          <div className="flex flex-col gap-1.5">
            {items.map((ev) => (
              <EventCard key={ev.id} event={ev} />
            ))}
          </div>
        </div>
      ))}
      {hasMore && (
        <div className="text-center text-xs text-ink-3">
          Load more — cursor pagination coming with the next interaction
        </div>
      )}
    </div>
  );
}

function EventCard({ event }: { event: TimelineEvent }) {
  const [expanded, setExpanded] = React.useState(false);
  const hasDetail = Boolean(event.description) || Object.keys(event.metadata ?? {}).length > 0;
  return (
    <div
      className={cn('rounded-[8px] border border-border bg-bg-sub p-2.5', hasDetail ? 'cursor-pointer' : 'cursor-default')}
      onClick={() => hasDetail && setExpanded((v) => !v)}
    >
      <div className="flex justify-between items-baseline">
        <div className="flex items-center gap-2">
          <span className="text-[16px]">{eventIcon(event.type)}</span>
          <span className="text-body font-medium">{event.title ?? event.type.replace(/_/g, ' ')}</span>
          <span className="text-2xs text-ink-3">{event.actorType}</span>
        </div>
        <span className="text-xs text-ink-3">{formatRelative(event.occurredAt)}</span>
      </div>
      {expanded && (
        <div className="mt-2 text-label text-ink-2">
          {event.description && <div className="mb-1.5 whitespace-pre-wrap">{event.description}</div>}
          {event.metadata && Object.keys(event.metadata).length > 0 && (
            <pre className="text-2xs text-ink-3 whitespace-pre-wrap m-0">
              {JSON.stringify(event.metadata, null, 2)}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
