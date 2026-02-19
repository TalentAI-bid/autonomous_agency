'use client';

import { useQuery } from '@tanstack/react-query';
import { apiGet } from '@/lib/api';
import type { AnalyticsOverview } from '@/types';
import { StatsGrid } from '@/components/analytics/stats-grid';
import { ConversionFunnel } from '@/components/analytics/conversion-funnel';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';

export default function AnalyticsPage() {
  const { data: res, isLoading } = useQuery({
    queryKey: ['analytics'],
    queryFn: () => apiGet<AnalyticsOverview>('/analytics/overview'),
    staleTime: 60000,
  });

  const analytics = res;

  // Mock weekly data for chart (replace with real API)
  const weeklyData = [
    { day: 'Mon', discovered: 12, contacted: 4 },
    { day: 'Tue', discovered: 19, contacted: 7 },
    { day: 'Wed', discovered: 8, contacted: 3 },
    { day: 'Thu', discovered: 25, contacted: 9 },
    { day: 'Fri', discovered: 14, contacted: 5 },
    { day: 'Sat', discovered: 3, contacted: 1 },
    { day: 'Sun', discovered: 0, contacted: 0 },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Analytics</h1>
        <p className="text-muted-foreground text-sm mt-1">Pipeline performance and recruiting metrics</p>
      </div>

      {isLoading ? (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-28" />)}
        </div>
      ) : (
        <StatsGrid analytics={analytics} />
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Funnel */}
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium">Conversion Funnel</CardTitle>
          </CardHeader>
          <CardContent>
            {isLoading ? <Skeleton className="h-[240px]" /> : <ConversionFunnel analytics={analytics} />}
          </CardContent>
        </Card>

        {/* Weekly Activity */}
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-sm font-medium">Weekly Activity</CardTitle>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={240}>
              <BarChart data={weeklyData} barGap={4}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                <XAxis dataKey="day" tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 12 }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 12 }} axisLine={false} tickLine={false} />
                <Tooltip
                  contentStyle={{
                    background: 'hsl(var(--card))',
                    border: '1px solid hsl(var(--border))',
                    borderRadius: '8px',
                    fontSize: '12px',
                  }}
                />
                <Bar dataKey="discovered" name="Discovered" fill="hsl(var(--primary))" radius={[4, 4, 0, 0]} />
                <Bar dataKey="contacted" name="Contacted" fill="#10b981" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
