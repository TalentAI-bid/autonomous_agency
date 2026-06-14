'use client';

import * as React from 'react';
import { formatDate, formatRelative } from '@/lib/utils';
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
        style={{
          textAlign: 'center',
          padding: 32,
          color: 'var(--ink-3)',
          border: '1px solid var(--border)',
          borderRadius: 8,
        }}
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
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {Object.entries(grouped).map(([day, items]) => (
        <div key={day}>
          <div
            style={{
              fontSize: 11,
              textTransform: 'uppercase',
              letterSpacing: 0.5,
              color: 'var(--ink-3)',
              marginBottom: 6,
            }}
          >
            {day}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {items.map((ev) => (
              <EventCard key={ev.id} event={ev} />
            ))}
          </div>
        </div>
      ))}
      {hasMore && (
        <div style={{ textAlign: 'center', fontSize: 11, color: 'var(--ink-3)' }}>
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
      style={{
        border: '1px solid var(--border)',
        borderRadius: 8,
        padding: 10,
        background: 'var(--bg-2)',
        cursor: hasDetail ? 'pointer' : 'default',
      }}
      onClick={() => hasDetail && setExpanded((v) => !v)}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 16 }}>{eventIcon(event.type)}</span>
          <span style={{ fontSize: 13, fontWeight: 500 }}>{event.title ?? event.type.replace(/_/g, ' ')}</span>
          <span style={{ fontSize: 10, color: 'var(--ink-3)' }}>{event.actorType}</span>
        </div>
        <span style={{ fontSize: 11, color: 'var(--ink-3)' }}>{formatRelative(event.occurredAt)}</span>
      </div>
      {expanded && (
        <div style={{ marginTop: 8, fontSize: 12, color: 'var(--ink-2)' }}>
          {event.description && <div style={{ marginBottom: 6, whiteSpace: 'pre-wrap' }}>{event.description}</div>}
          {event.metadata && Object.keys(event.metadata).length > 0 && (
            <pre style={{ fontSize: 10, color: 'var(--ink-3)', whiteSpace: 'pre-wrap', margin: 0 }}>
              {JSON.stringify(event.metadata, null, 2)}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
