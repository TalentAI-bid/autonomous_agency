'use client';

import * as React from 'react';
import { Card } from '@/components/ui/card';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { useProspect, useProspectTimeline } from '@/hooks/use-prospect';
import { ContactSummaryCard } from '@/components/prospects/contact-summary-card';
import { GmapsBusinessCard } from '@/components/prospects/gmaps-business-card';
import { TimelineFeed } from '@/components/prospects/timeline-feed';
import { NoteComposer } from '@/components/prospects/note-composer';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

const CATEGORIES = [
  { label: 'All', value: undefined },
  { label: 'Outreach', value: 'outreach' },
  { label: 'Responses', value: 'response' },
  { label: 'Notes', value: 'manual_note' },
  { label: 'System', value: 'system_action' },
  { label: 'Discovery', value: 'discovery' },
];

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
      <div className="grid gap-4 p-5 lg:grid-cols-[360px_minmax(0,1fr)]">
        <Skeleton className="h-[520px] rounded-2xl" />
        <div className="space-y-4">
          <Skeleton className="h-32 rounded-2xl" />
          <Skeleton className="h-72 rounded-2xl" />
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 p-5">
      <Link href="/prospects" className="inline-flex w-fit items-center gap-1.5 text-body font-medium text-ink-2 no-underline hover:text-accent">
        <ArrowLeft size={14} /> Back to prospects
      </Link>

      <div className="grid items-start gap-4 lg:grid-cols-[360px_minmax(0,1fr)]">
        <div className="flex flex-col gap-4">
          <ContactSummaryCard prospect={prospect} />
          <GmapsBusinessCard contactId={prospect.id} sourceType={prospect.sourceType} meta={prospect.sourceMetadata} />
        </div>

        <div className="flex min-w-0 flex-col gap-4">
          <NoteComposer prospectId={prospect.id} />

          <Card as="section">
            <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-3.5">
              <h2 className="m-0 text-body font-semibold text-ink">Activity</h2>
              <div className="flex flex-wrap gap-1.5">
                {CATEGORIES.map((c) => (
                  <button
                    key={c.label}
                    type="button"
                    onClick={() => setCategory(c.value)}
                    aria-pressed={category === c.value}
                    className={cn(
                      'rounded-full border px-3 py-1 text-xs font-medium transition-colors',
                      category === c.value
                        ? 'border-accent-mid bg-accent-weak text-accent-fg'
                        : 'border-line bg-bg-panel text-ink-2 hover:border-line-strong hover:bg-hover',
                    )}
                  >
                    {c.label}
                  </button>
                ))}
              </div>
            </header>
            {timelineLoading ? (
              <div className="space-y-2 p-5">
                <Skeleton className="h-12 rounded-lg" />
                <Skeleton className="h-12 rounded-lg" />
                <Skeleton className="h-12 rounded-lg" />
              </div>
            ) : (
              <TimelineFeed events={timeline?.events ?? []} hasMore={Boolean(timeline?.hasMore)} />
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
