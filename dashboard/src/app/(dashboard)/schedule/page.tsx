'use client';

import { useState } from 'react';
import { useUpcomingActions } from '@/hooks/use-schedule';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ActionTimeline } from '@/components/schedule/action-timeline';
import { CalendarClock, Mail, Bot } from 'lucide-react';

export default function SchedulePage() {
  const [filter, setFilter] = useState<'all' | 'emails' | 'tasks'>('all');
  const { data: actions, isLoading } = useUpcomingActions({ filter });

  const items = actions ?? [];
  const emailCount = items.filter((a) => a.type === 'email').length;
  const taskCount = items.filter((a) => a.type === 'task').length;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <CalendarClock className="w-6 h-6 text-purple-400" />
        <div>
          <h1 className="text-2xl font-bold">Agent Schedule</h1>
          <p className="text-muted-foreground text-sm mt-0.5">Upcoming emails and agent tasks</p>
        </div>
      </div>

      {/* Summary */}
      <div className="flex items-center gap-4">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Mail className="w-4 h-4 text-blue-400" />
          <span>{emailCount} queued email{emailCount !== 1 ? 's' : ''}</span>
        </div>
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Bot className="w-4 h-4 text-purple-400" />
          <span>{taskCount} active task{taskCount !== 1 ? 's' : ''}</span>
        </div>
      </div>

      {/* Filter */}
      <div className="flex bg-muted rounded-lg p-0.5 w-fit">
        {(['all', 'emails', 'tasks'] as const).map((f) => (
          <Button
            key={f}
            variant={filter === f ? 'default' : 'ghost'}
            size="sm"
            onClick={() => setFilter(f)}
            className="text-xs capitalize"
          >
            {f}
          </Button>
        ))}
      </div>

      {/* Timeline */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium">Timeline</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-3">
              {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-12" />)}
            </div>
          ) : (
            <ActionTimeline items={items} />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
