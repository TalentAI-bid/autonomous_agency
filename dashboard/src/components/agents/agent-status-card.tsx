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
};

const AGENT_ICONS: Record<string, string> = {
  discovery: '🔍',
  document: '📄',
  enrichment: '🔬',
  scoring: '⭐',
  outreach: '📧',
  reply: '💬',
  action: '⚡',
};

interface AgentStatusCardProps {
  agentType: string;
  status?: AgentStatus;
}

export function AgentStatusCard({ agentType, status }: AgentStatusCardProps) {
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

        {isRunning && (
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
