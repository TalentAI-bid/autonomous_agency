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
  Linkedin,
  Send,
  UserCheck,
  UserPlus,
  ArrowUp,
  ArrowDown,
} from 'lucide-react';
import { formatDistanceToNow, parseISO } from 'date-fns';
import { cn } from '@/lib/utils';
import type { CrmActivity, ActivityType } from '@/types';

interface ActivityIconConfig {
  Icon: React.ElementType;
  color: string;
  bg: string;
  /** 'email' | 'linkedin' | 'call' | 'meeting' | 'note' | 'system' */
  channel: 'email' | 'linkedin' | 'call' | 'meeting' | 'note' | 'system';
  direction?: 'in' | 'out';
}

const ACTIVITY_CONFIG: Record<ActivityType, ActivityIconConfig> = {
  // Auto-pipeline email
  email_sent:         { Icon: Mail,           color: 'text-info',    bg: 'bg-info/15',    channel: 'email',    direction: 'out' },
  email_opened:       { Icon: MailOpen,       color: 'text-up', bg: 'bg-up/15', channel: 'email' },
  email_replied:      { Icon: Reply,          color: 'text-up',   bg: 'bg-up/15',   channel: 'email',    direction: 'in'  },
  email_received:     { Icon: Inbox,          color: 'text-a-enrichment',    bg: 'bg-a-enrichment/15',    channel: 'email',    direction: 'in'  },
  email_bounced:      { Icon: AlertTriangle,  color: 'text-down',     bg: 'bg-down/15',     channel: 'email' },
  // Manually-logged email (out of app)
  manual_email_sent:     { Icon: Mail,        color: 'text-info',    bg: 'bg-info/10',    channel: 'email',    direction: 'out' },
  manual_email_received: { Icon: Inbox,       color: 'text-a-enrichment',    bg: 'bg-a-enrichment/10',    channel: 'email',    direction: 'in'  },
  // LinkedIn
  linkedin_connection_sent:     { Icon: UserPlus,  color: 'text-info', bg: 'bg-info/15',  channel: 'linkedin', direction: 'out' },
  linkedin_connection_accepted: { Icon: UserCheck, color: 'text-info', bg: 'bg-info/15',  channel: 'linkedin', direction: 'in'  },
  linkedin_message_sent:        { Icon: Send,      color: 'text-info', bg: 'bg-info/15',  channel: 'linkedin', direction: 'out' },
  linkedin_message_received:    { Icon: Linkedin,  color: 'text-info', bg: 'bg-info/15',  channel: 'linkedin', direction: 'in'  },
  linkedin_followup_sent:       { Icon: Send,      color: 'text-info', bg: 'bg-info/15',  channel: 'linkedin', direction: 'out' },
  // System / pipeline
  stage_change:       { Icon: ArrowRightLeft, color: 'text-a-master',  bg: 'bg-a-master/15', channel: 'system' },
  note_added:         { Icon: StickyNote,     color: 'text-warn-fg',  bg: 'bg-warn/15', channel: 'note' },
  call_logged:        { Icon: Phone,          color: 'text-a-enrichment',    bg: 'bg-a-enrichment/15',   channel: 'call' },
  meeting_scheduled:  { Icon: Calendar,       color: 'text-info',  bg: 'bg-info/15', channel: 'meeting' },
  status_change:      { Icon: RefreshCw,      color: 'text-warn-fg',  bg: 'bg-warn/15', channel: 'system' },
  score_updated:      { Icon: Star,           color: 'text-warn-fg',   bg: 'bg-warn/15',  channel: 'system' },
  agent_action:       { Icon: Bot,            color: 'text-ink-3',    bg: 'bg-bg-soft',      channel: 'system' },
};

const CHANNEL_LABEL: Record<ActivityIconConfig['channel'], string> = {
  email:    'Email',
  linkedin: 'LinkedIn',
  call:     'Call',
  meeting:  'Meeting',
  note:     'Note',
  system:   'System',
};

const CHANNEL_CHIP_CLASS: Record<ActivityIconConfig['channel'], string> = {
  email:    'bg-info/15 text-info',
  linkedin: 'bg-info/15 text-info',
  call:     'bg-a-enrichment/15 text-a-enrichment',
  meeting:  'bg-info/15 text-info',
  note:     'bg-warn/15 text-warn-fg',
  system:   'bg-bg-soft text-ink-3',
};

interface ActivityItemProps {
  activity: CrmActivity;
}

export function ActivityItem({ activity }: ActivityItemProps) {
  const config = ACTIVITY_CONFIG[activity.type] ?? ACTIVITY_CONFIG.agent_action;
  const { Icon, color, bg, channel, direction } = config;

  const relativeTime = formatDistanceToNow(parseISO(activity.occurredAt), { addSuffix: true });

  return (
    <div className="flex gap-3">
      <div className={cn('flex h-8 w-8 shrink-0 items-center justify-center rounded-full', bg)}>
        <Icon className={cn('h-4 w-4', color)} />
      </div>

      <div className="min-w-0 flex-1 pb-4">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="text-sm font-medium text-foreground leading-snug">
              {activity.title}
            </p>
            <div className="mt-1 flex items-center gap-1.5">
              <span className={cn('inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide', CHANNEL_CHIP_CLASS[channel])}>
                {CHANNEL_LABEL[channel]}
              </span>
              {direction && (
                <span className={cn(
                  'inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide',
                  direction === 'out' ? 'bg-bg-soft text-ink-3' : 'bg-up/15 text-up',
                )}>
                  {direction === 'out' ? <ArrowUp className="h-2.5 w-2.5" /> : <ArrowDown className="h-2.5 w-2.5" />}
                  {direction === 'out' ? 'Out' : 'In'}
                </span>
              )}
            </div>
          </div>
          <time className="shrink-0 text-xs text-muted-foreground" dateTime={activity.occurredAt}>
            {relativeTime}
          </time>
        </div>

        {activity.description && (
          <p className="mt-2 text-xs text-muted-foreground leading-relaxed">
            {activity.description}
          </p>
        )}
      </div>
    </div>
  );
}
