'use client';

import {
  Mail,
  MailOpen,
  Reply,
  Inbox,
  AlertTriangle,
  ArrowRightLeft,
  StickyNote,
  Phone,
  Calendar,
  RefreshCw,
  Star,
  Bot,
} from 'lucide-react';
import { formatDistanceToNow, parseISO } from 'date-fns';
import { cn } from '@/lib/utils';
import type { CrmActivity, ActivityType } from '@/types';

interface ActivityIconConfig {
  Icon: React.ElementType;
  color: string;
  bg: string;
}

const ACTIVITY_CONFIG: Record<ActivityType, ActivityIconConfig> = {
  email_sent:         { Icon: Mail,           color: 'text-blue-400',    bg: 'bg-blue-900/30' },
  email_opened:       { Icon: MailOpen,       color: 'text-emerald-400', bg: 'bg-emerald-900/30' },
  email_replied:      { Icon: Reply,          color: 'text-green-400',   bg: 'bg-green-900/30' },
  email_received:     { Icon: Inbox,          color: 'text-teal-400',    bg: 'bg-teal-900/30' },
  email_bounced:      { Icon: AlertTriangle,  color: 'text-red-400',     bg: 'bg-red-900/30' },
  stage_change:       { Icon: ArrowRightLeft, color: 'text-purple-400',  bg: 'bg-purple-900/30' },
  note_added:         { Icon: StickyNote,     color: 'text-yellow-400',  bg: 'bg-yellow-900/30' },
  call_logged:        { Icon: Phone,          color: 'text-cyan-400',    bg: 'bg-cyan-900/30' },
  meeting_scheduled:  { Icon: Calendar,       color: 'text-indigo-400',  bg: 'bg-indigo-900/30' },
  status_change:      { Icon: RefreshCw,      color: 'text-orange-400',  bg: 'bg-orange-900/30' },
  score_updated:      { Icon: Star,           color: 'text-amber-400',   bg: 'bg-amber-900/30' },
  agent_action:       { Icon: Bot,            color: 'text-zinc-400',    bg: 'bg-zinc-800' },
};

interface ActivityItemProps {
  activity: CrmActivity;
}

export function ActivityItem({ activity }: ActivityItemProps) {
  const config = ACTIVITY_CONFIG[activity.type] ?? ACTIVITY_CONFIG.agent_action;
  const { Icon, color, bg } = config;

  const relativeTime = formatDistanceToNow(parseISO(activity.occurredAt), { addSuffix: true });

  return (
    <div className="flex gap-3">
      <div className={cn('flex h-8 w-8 shrink-0 items-center justify-center rounded-full', bg)}>
        <Icon className={cn('h-4 w-4', color)} />
      </div>

      <div className="min-w-0 flex-1 pb-4">
        <div className="flex items-start justify-between gap-2">
          <p className="text-sm font-medium text-foreground leading-snug">
            {activity.title}
          </p>
          <time className="shrink-0 text-xs text-muted-foreground" dateTime={activity.occurredAt}>
            {relativeTime}
          </time>
        </div>

        {activity.description && (
          <p className="mt-0.5 text-xs text-muted-foreground leading-relaxed">
            {activity.description}
          </p>
        )}
      </div>
    </div>
  );
}
