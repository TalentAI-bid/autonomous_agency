'use client';

import { ActivityItem } from './activity-item';
import type { CrmActivity } from '@/types';

interface ActivityTimelineProps {
  activities: CrmActivity[];
}

export function ActivityTimeline({ activities }: ActivityTimelineProps) {
  if (activities.length === 0) {
    return (
      <p className="py-6 text-center text-sm text-muted-foreground">
        No activity recorded yet.
      </p>
    );
  }

  return (
    <div className="relative">
      {/* Vertical guide line */}
      <div
        aria-hidden
        className="absolute left-[15px] top-4 bottom-4 w-px bg-border"
      />

      <div className="space-y-0">
        {activities.map((activity, index) => (
          <div key={activity.id} className="relative flex gap-3">
            {/* Dot on the timeline */}
            <div
              aria-hidden
              className="absolute left-[11px] top-4 h-[9px] w-[9px] rounded-full border-2 border-border bg-background z-10"
            />

            {/* Offset content so it sits to the right of the line + dot */}
            <div className="ml-8 w-full">
              <ActivityItem activity={activity} />
              {/* Separator between items (not after the last one) */}
              {index < activities.length - 1 && (
                <div className="border-t border-border/40 mb-4" />
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
