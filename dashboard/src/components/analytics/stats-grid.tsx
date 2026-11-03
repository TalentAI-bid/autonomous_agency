'use client';

import type { DashboardAnalytics } from '@/hooks/use-analytics';
import { StatCard } from '@/components/home/home-parts';

interface StatsGridProps {
  analytics?: DashboardAnalytics;
}

const rate = (n: number, d: number) => (d > 0 ? `${Math.round((n / d) * 100)}%` : '—');

export function StatsGrid({ analytics }: StatsGridProps) {
  const byStatus = analytics?.contacts.byStatus ?? {};
  const total = analytics?.contacts.total ?? 0;
  const contacted = byStatus.contacted ?? 0;
  const sent = analytics?.emails.sent ?? 0;
  const replied = analytics?.emails.replied ?? 0;
  const interviews = analytics?.interviews.scheduled ?? 0;

  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <StatCard
        label="Contacts"
        value={total.toLocaleString()}
        tail={contacted > 0 ? `· ${contacted.toLocaleString()} contacted` : undefined}
        detail={analytics?.avgScore != null ? `Average lead score ${analytics.avgScore}` : 'No scored leads yet'}
        muted={total === 0}
      />
      <StatCard
        label="Emails sent"
        value={sent.toLocaleString()}
        tail={sent > 0 ? `· ${rate(analytics?.emails.opened ?? 0, sent)} opened` : undefined}
        detail={sent === 0 ? 'Nothing sent yet' : `${(analytics?.emails.opened ?? 0).toLocaleString()} opened`}
        muted={sent === 0}
      />
      <StatCard
        label="Replies"
        value={replied.toLocaleString()}
        tail={sent > 0 ? `· ${rate(replied, sent)} of sent` : undefined}
        detail={replied === 0 ? 'No replies yet' : 'Email replies from your leads'}
        muted={replied === 0}
      />
      <StatCard
        label="Interviews booked"
        value={interviews.toLocaleString()}
        tail={interviews === 0 ? '· None yet' : undefined}
        detail={interviews === 0 ? 'Nothing booked yet' : 'Scheduled with your leads'}
        muted={interviews === 0}
      />
    </div>
  );
}
