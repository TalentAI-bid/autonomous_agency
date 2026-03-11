'use client';

import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { cn, formatDate } from '@/lib/utils';
import type { AgentStatus } from '@/types';

const AGENT_COLORS: Record<string, string> = {
  discovery: 'blue',
  document: 'indigo',
  enrichment: 'purple',
  scoring: 'amber',
  outreach: 'emerald',
  reply: 'cyan',
  action: 'rose',
  strategy: 'violet',
  strategist: 'sky',
  'email-listen': 'teal',
  'email-send': 'green',
  mailbox: 'orange',
  'reddit-monitor': 'red',
};

const AGENT_ICONS: Record<string, string> = {
  discovery: '🔍',
  document: '📄',
  enrichment: '🔬',
  scoring: '⭐',
  outreach: '📧',
  reply: '💬',
  action: '⚡',
  strategy: '🧠',
  strategist: '🎯',
  'email-listen': '📥',
  'email-send': '📤',
  mailbox: '📬',
  'reddit-monitor': '📡',
};

interface AgentStatusCardProps {
  agentType: string;
  status?: AgentStatus;
  liveAction?: { action: string; description?: string };
}

export function AgentStatusCard({ agentType, status, liveAction }: AgentStatusCardProps) {
  const color = AGENT_COLORS[agentType] || 'slate';
  const icon = AGENT_ICONS[agentType] || '🤖';
  const isRunning = status?.status === 'running';
  const isIdle = !status || status.status === 'idle';

  return (
    <Card className={cn('transition-all', isRunning && 'border-blue-500/30 shadow-sm shadow-blue-500/10')}>
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className="text-xl">{icon}</span>
            <div>
              <p className="text-sm font-medium capitalize">{agentType}</p>
              <p className="text-xs text-muted-foreground">
                {status?.lastActivity ? formatDate(status.lastActivity) : 'Not started'}
              </p>
            </div>
          </div>
          <Badge
            variant={isRunning ? 'success' : isIdle ? 'secondary' : 'outline'}
            className="text-xs shrink-0"
          >
            {status?.status ?? 'idle'}
          </Badge>
        </div>

        {liveAction && (
          <div className="mt-2 flex items-center gap-1.5">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
            </span>
            <span className="text-xs text-muted-foreground truncate">
              {liveAction.description || liveAction.action}
            </span>
          </div>
        )}

        {isRunning && !liveAction && (
          <div className="mt-3">
            <div className="h-1 bg-muted rounded-full overflow-hidden">
              <div className="h-full bg-blue-500 rounded-full animate-pulse w-2/3" />
            </div>
          </div>
        )}

        {status && (
          <div className="mt-3 flex gap-3 text-xs text-muted-foreground">
            <span className="font-medium text-foreground">{status.jobsCompleted} done</span>
            {status.jobsFailed > 0 && (
              <span className="text-destructive">{status.jobsFailed} failed</span>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
