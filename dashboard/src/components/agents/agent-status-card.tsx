'use client';

import {
  Bot, Brain, FileText, FlaskConical, MessageCircle, Search, Send, Star, Target, Zap, type LucideIcon,
} from 'lucide-react';
import { cn, formatDate } from '@/lib/utils';
import type { AgentStatus } from '@/types';

const AGENT_ICONS: Record<string, LucideIcon> = {
  discovery: Search,
  document: FileText,
  enrichment: FlaskConical,
  scoring: Star,
  outreach: Send,
  reply: MessageCircle,
  action: Zap,
  strategy: Brain,
  strategist: Target,
};

interface AgentStatusCardProps {
  agentType: string;
  status?: AgentStatus;
  liveAction?: { action: string; description?: string };
}

export function AgentStatusCard({ agentType, status, liveAction }: AgentStatusCardProps) {
  const Icon = AGENT_ICONS[agentType] ?? Bot;
  const isRunning = status?.status === 'running';
  const failed = status?.jobsFailed ?? 0;

  return (
    <div
      className={cn(
        'flex flex-col rounded-card border p-3 transition-colors',
        isRunning ? 'border-accent-mid bg-accent-weak' : 'border-line bg-bg-panel',
      )}
    >
      <div className="flex items-center gap-2">
        <span className={cn('grid size-7 shrink-0 place-items-center rounded-row', isRunning ? 'bg-bg-panel text-accent' : 'bg-bg-soft text-ink-3')}>
          <Icon size={14} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-body font-medium capitalize text-ink">{agentType}</div>
        </div>
        <span
          className={cn('size-2 shrink-0 rounded-full', isRunning ? 'animate-pulse bg-up' : 'bg-line-strong')}
          title={status?.status ?? 'idle'}
        />
      </div>

      <div className="mt-2 min-h-[16px] truncate text-2xs text-ink-3">
        {liveAction ? liveAction.description || liveAction.action : status?.lastActivity ? formatDate(status.lastActivity) : 'Not started'}
      </div>

      <div className="mt-2 flex items-center gap-2 font-mono text-2xs">
        <span className="text-ink-2">{status?.jobsCompleted ?? 0} done</span>
        {failed > 0 && <span className="text-down">{failed} failed</span>}
      </div>
    </div>
  );
}
