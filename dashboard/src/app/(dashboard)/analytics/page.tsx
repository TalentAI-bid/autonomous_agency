'use client';

import { useDashboardAnalytics } from '@/hooks/use-analytics';
import { StatsGrid } from '@/components/analytics/stats-grid';
import { OutreachActivityGrid } from '@/components/analytics/outreach-activity-grid';
import { ConversionFunnel } from '@/components/analytics/conversion-funnel';
import { Skeleton } from '@/components/ui/skeleton';

export default function AnalyticsPage() {
  const { data: analytics, isLoading } = useDashboardAnalytics();

  if (isLoading) {
    return (
      <div className="mx-auto flex max-w-[940px] flex-col gap-4 p-5">
        <Skeleton className="h-28 rounded-xl" />
        <Skeleton className="h-72 rounded-xl" />
        <Skeleton className="h-64 rounded-xl" />
      </div>
    );
  }

  return (
    <div className="mx-auto flex max-w-[940px] flex-col gap-4 p-5">
      <div>
        <div className="mb-2 flex items-baseline gap-2 px-1 text-2xs font-medium uppercase tracking-[0.09em] text-ink-4">
          <span>All time</span>
          <span className="normal-case tracking-normal text-ink-3">across every agent in this workspace</span>
        </div>
        <StatsGrid analytics={analytics} />
      </div>

      <ConversionFunnel analytics={analytics} />
      <OutreachActivityGrid />
    </div>
  );
}
