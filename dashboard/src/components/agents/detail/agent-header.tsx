'use client';

import { Cpu, Pause, Play } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { ExportButton } from '@/components/shared/export-button';
import { QuotaBadge } from '@/components/agents/quota-badge';
import { agentStatus, ago } from '@/hooks/use-home';
import { cn, formatDate } from '@/lib/utils';
import type { useAgentStats } from '@/hooks/use-agents';
import type { MasterAgent } from '@/types';

type Stats = ReturnType<typeof useAgentStats>['data'];

const USE_CASE_LABEL: Record<string, string> = { sales: 'Outbound', recruitment: 'Recruitment', custom: 'Custom' };

const sum = (by: Record<string, number>, keys: string[]) => keys.reduce((s, k) => s + (by[k] ?? 0), 0);

interface AgentHeaderProps {
  agent: MasterAgent;
  stats: Stats;
  totalContacts: number;
  starting: boolean;
  stopping: boolean;
  onStart: () => void;
  onStop: () => void;
}

export function AgentHeader({ agent, stats, totalContacts, starting, stopping, onStart, onStop }: AgentHeaderProps) {
  const status = agent.status as string;
  const info = agentStatus(agent);
  const by = stats?.byStatus ?? {};
  const contacted = sum(by, ['contacted', 'replied', 'qualified', 'interview_scheduled']);
  const replies = sum(by, ['replied', 'qualified', 'interview_scheduled']);

  return (
    <Card as="section" className="p-6">
      <div className="flex flex-wrap items-start gap-4">
        <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-bg-soft text-ink-3">
          <Cpu size={18} />
        </span>
        <div className="min-w-0 flex-1">
          <h1 className="m-0 truncate font-display text-[28px] font-normal leading-tight tracking-[-0.01em] text-ink">{agent.name}</h1>
          <div className="mt-1 text-xs text-ink-3">
            {USE_CASE_LABEL[agent.useCase] ?? agent.useCase} · created {formatDate(agent.createdAt, 'd MMM yyyy')} · updated {ago(agent.updatedAt)} ago
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <ExportButton masterAgentId={agent.id} showFullBatch />
          {status === 'running' ? (
            <Button type="button" variant="panel" onClick={onStop} disabled={stopping}>
              <Pause size={13} /> Pause
            </Button>
          ) : status !== 'awaiting_action_plan' ? (
            <Button type="button" variant="brand" onClick={onStart} disabled={starting}>
              <Play size={13} /> {status === 'idle' ? 'Run' : 'Resume'}
            </Button>
          ) : null}
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <span
          className={cn(
            'inline-flex items-center gap-2 rounded-md px-2.5 py-1 text-xs font-medium',
            info.tone === 'warn' && 'bg-warn/10 text-warn-fg',
            info.tone === 'up' && 'bg-up/10 text-up',
            info.tone === 'down' && 'bg-down/10 text-down',
            info.tone === 'muted' && 'bg-bg-soft text-ink-3',
          )}
        >
          <span className="size-1.5 rounded-full bg-current" />
          {info.statusLabel}
        </span>
        <QuotaBadge masterAgentId={agent.id} compact />
      </div>

      {agent.mission && <p className="mb-0 mt-4 max-w-[760px] text-body leading-relaxed text-ink-2">{agent.mission}</p>}

      <dl className="m-0 mt-5 grid grid-cols-2 divide-x divide-line overflow-hidden rounded-card border border-line bg-bg-sub lg:grid-cols-4">
        {[
          { label: 'Leads', value: totalContacts, sub: 'found by this agent', tone: '' },
          { label: 'Contacted', value: contacted, sub: totalContacts > 0 ? `${Math.round((contacted / totalContacts) * 100)}% of leads` : 'Nobody yet', tone: '' },
          { label: 'Replies', value: replies, sub: contacted > 0 ? `${((replies / contacted) * 100).toFixed(1)}% of contacted` : 'No replies yet', tone: replies > 0 ? 'text-up' : '' },
          { label: 'Average score', value: stats?.avgScore != null ? stats.avgScore : '—', sub: 'across scored leads', tone: '' },
        ].map((m) => (
          <div key={m.label} className="px-4 py-3 [&:nth-child(n+3)]:border-t [&:nth-child(n+3)]:border-line lg:[&:nth-child(n+3)]:border-t-0">
            <dt className="text-3xs font-medium uppercase tracking-[0.09em] text-ink-4">{m.label}</dt>
            <dd className={cn('m-0 mt-1 font-display text-[26px] leading-none text-ink', m.tone)}>{m.value}</dd>
            <div className="mt-1 text-2xs text-ink-3">{m.sub}</div>
          </div>
        ))}
      </dl>
    </Card>
  );
}
