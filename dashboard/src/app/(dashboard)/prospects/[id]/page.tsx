'use client';

import * as React from 'react';
import { useParams } from 'next/navigation';
import { useProspect, useProspectTimeline } from '@/hooks/use-prospect';
import { ContactSummaryCard } from '@/components/prospects/contact-summary-card';
import { GmapsBusinessCard } from '@/components/prospects/gmaps-business-card';
import { TimelineFeed } from '@/components/prospects/timeline-feed';
import { NoteComposer } from '@/components/prospects/note-composer';
import { Skeleton } from '@/components/ui/skeleton';

export default function ProspectDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id;

  const [category, setCategory] = React.useState<string | undefined>(undefined);

  const { data: prospect, isLoading: prospectLoading } = useProspect(id);
  const { data: timeline, isLoading: timelineLoading } = useProspectTimeline(id, {
    limit: 50,
    category,
  });

  if (prospectLoading || !prospect) {
    return (
      <div style={{ padding: 24, display: 'grid', gridTemplateColumns: '320px 1fr', gap: 16 }}>
        <Skeleton className="h-96" />
        <Skeleton className="h-96" />
      </div>
    );
  }

  return (
    <div
      style={{
        padding: 24,
        display: 'grid',
        gridTemplateColumns: 'minmax(280px, 360px) 1fr',
        gap: 16,
        alignItems: 'start',
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <ContactSummaryCard prospect={prospect} />
        <GmapsBusinessCard contactId={prospect.id} sourceType={prospect.sourceType} meta={prospect.sourceMetadata} />
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <NoteComposer prospectId={prospect.id} />
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {[
            { label: 'All', value: undefined },
            { label: 'Outreach', value: 'outreach' },
            { label: 'Responses', value: 'response' },
            { label: 'Notes', value: 'manual_note' },
            { label: 'System', value: 'system_action' },
            { label: 'Discovery', value: 'discovery' },
          ].map((c) => (
            <button
              key={c.label}
              onClick={() => setCategory(c.value)}
              style={{
                fontSize: 11,
                padding: '4px 10px',
                borderRadius: 999,
                border: '1px solid var(--border)',
                background: category === c.value ? 'var(--accent-1)' : 'var(--bg-2)',
                color: category === c.value ? 'var(--accent-fg)' : 'var(--ink-2)',
                cursor: 'pointer',
              }}
            >
              {c.label}
            </button>
          ))}
        </div>
        {timelineLoading ? (
          <Skeleton className="h-64" />
        ) : (
          <TimelineFeed events={timeline?.events ?? []} hasMore={Boolean(timeline?.hasMore)} />
        )}
      </div>
    </div>
  );
}
