'use client';

import { Card, CardContent } from '@/components/ui/card';
import type { AnalyticsOverview } from '@/types';
import { Users, Mail, Star, TrendingUp } from 'lucide-react';

interface StatsGridProps {
  analytics?: AnalyticsOverview;
}

interface StatCardProps {
  title: string;
  value: string | number;
  sub?: string;
  icon: React.ElementType;
  iconColor: string;
  bgColor: string;
  trend?: number;
}

function StatCard({ title, value, sub, icon: Icon, iconColor, bgColor, trend }: StatCardProps) {
  return (
    <Card>
      <CardContent className="p-5">
        <div className="flex items-start justify-between">
          <div className="space-y-1">
            <p className="text-sm text-muted-foreground">{title}</p>
            <p className="text-2xl font-bold tabular-nums">{value}</p>
            {sub && <p className="text-xs text-muted-foreground">{sub}</p>}
            {trend !== undefined && (
              <p className={`text-xs font-medium ${trend >= 0 ? 'text-emerald-500' : 'text-rose-500'}`}>
                {trend >= 0 ? '+' : ''}{trend}% vs last week
              </p>
            )}
          </div>
          <div className={`p-2.5 rounded-lg ${bgColor}`}>
            <Icon className={`w-5 h-5 ${iconColor}`} />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export function StatsGrid({ analytics }: StatsGridProps) {
  const stats = [
    {
      title: 'Total Contacts',
      value: analytics?.contacts.total ?? 0,
      sub: `${analytics?.contacts.contacted ?? 0} contacted`,
      icon: Users,
      iconColor: 'text-blue-400',
      bgColor: 'bg-blue-500/10',
      trend: 12,
    },
    {
      title: 'Emails Sent',
      value: analytics?.emails.sent ?? 0,
      sub: `${analytics?.emails.openRate ? Math.round(analytics.emails.openRate * 100) : 0}% open rate`,
      icon: Mail,
      iconColor: 'text-purple-400',
      bgColor: 'bg-purple-500/10',
      trend: 8,
    },
    {
      title: 'Interviews',
      value: analytics?.interviews.scheduled ?? 0,
      sub: `${analytics?.interviews.completed ?? 0} completed`,
      icon: Star,
      iconColor: 'text-amber-400',
      bgColor: 'bg-amber-500/10',
    },
    {
      title: 'Reply Rate',
      value: analytics?.emails.replyRate ? `${Math.round(analytics.emails.replyRate * 100)}%` : '—',
      sub: `${analytics?.contacts.replied ?? 0} replies`,
      icon: TrendingUp,
      iconColor: 'text-emerald-400',
      bgColor: 'bg-emerald-500/10',
      trend: 3,
    },
  ];

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
      {stats.map((stat) => (
        <StatCard key={stat.title} {...stat} />
      ))}
    </div>
  );
}
