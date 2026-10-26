'use client';

import * as React from 'react';
import { useParams } from 'next/navigation';
import { useProspect, useProspectTimeline } from '@/hooks/use-prospect';
import { ContactSummaryCard } from '@/components/prospects/contact-summary-card';
import { GmapsBusinessCard } from '@/components/prospects/gmaps-business-card';
import { TimelineFeed } from '@/components/prospects/timeline-feed';
import { NoteComposer } from '@/components/prospects/note-composer';
import { Skeleton } from '@/components/ui/skeleton';

import { cn } from '@/lib/utils';
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
      <div className="p-6 grid grid-cols-[320px_1fr] gap-4">
        <Skeleton className="h-96"/>
        <Skeleton className="h-96"/>
      </div>
    );
  }

  return (
    <div
      className="p-6 grid grid-cols-[minmax(280px,_360px)_1fr] gap-4 items-start"
    >
      <div className="flex flex-col gap-4">
        <ContactSummaryCard prospect={prospect} />
        <GmapsBusinessCard contactId={prospect.id} sourceType={prospect.sourceType} meta={prospect.sourceMetadata} />
      </div>

      <div className="flex flex-col gap-4">
        <NoteComposer prospectId={prospect.id} />
        <div className="flex gap-1.5 flex-wrap">
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
              className={cn(
                'cursor-pointer rounded-full border border-border px-2.5 py-1 text-xs',
                category === c.value ? 'bg-accent-weak text-accent-fg' : 'bg-bg-sub text-ink-2',
              )}
            >
              {c.label}
            </button>
          ))}
        </div>
        {timelineLoading ? (
          <Skeleton className="h-64"/>
        ) : (
          <TimelineFeed events={timeline?.events ?? []} hasMore={Boolean(timeline?.hasMore)} />
        )}
      </div>
    </div>
  );
}
