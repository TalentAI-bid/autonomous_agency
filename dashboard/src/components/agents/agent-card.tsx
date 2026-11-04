'use client';

import Link from 'next/link';
import { Cpu, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useAgentStats, useMasterAgentQuota } from '@/hooks/use-agents';
import { agentStatus, ago } from '@/hooks/use-home';
import { cn } from '@/lib/utils';
import type { MasterAgent } from '@/types';

const USE_CASE_LABEL: Record<string, string> = { sales: 'Outbound', recruitment: 'Recruitment', custom: 'Custom' };

const STAGES = ['Discovery', 'Enrichment', 'Scoring', 'Outreach', 'Replies', 'Follow-up'] as const;

const sum = (by: Record<string, number>, keys: string[]) => keys.reduce((s, k) => s + (by[k] ?? 0), 0);

/** A stage is lit once at least one lead has reached it. Follow-up has no data yet. */
function stageStates(total: number, by: Record<string, number>): boolean[] {
  const scoredPlus = ['scored', 'contacted', 'replied', 'qualified', 'interview_scheduled'];
  return [
    total > 0,
    sum(by, ['enriched', ...scoredPlus]) > 0,
    sum(by, scoredPlus) > 0,
    sum(by, ['contacted', 'replied', 'qualified', 'interview_scheduled']) > 0,
    sum(by, ['replied', 'qualified', 'interview_scheduled']) > 0,
    false,
  ];
}

function utcClock(iso: string) {
  const d = new Date(iso);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')} UTC`;
}

interface AgentCardProps {
  agent: MasterAgent;
  busy: boolean;
  onStart: () => void;
  onStop: () => void;
  onDelete: () => void;
}

export function AgentCard({ agent, busy, onStart, onStop, onDelete }: AgentCardProps) {
  const stats = useAgentStats(agent.id);
  const status = agent.status as string;
  const quotaPaused = status === 'paused_quota';
  const quota = useMasterAgentQuota(quotaPaused ? agent.id : '');
  const info = agentStatus(agent);

  const statusLabel =
    quotaPaused && quota.data?.resetsAt
      ? `Paused — daily quota reached, resets ${utcClock(quota.data.resetsAt)}`
      : info.statusLabel;

  const s = stats.data;
  const by = s?.byStatus ?? {};
  const leads = s?.totalContacts ?? null;
  const contacted = s ? sum(by, ['contacted', 'replied', 'qualified', 'interview_scheduled']) : null;
  const replies = s ? sum(by, ['replied', 'qualified', 'interview_scheduled']) : null;
  const lit = stageStates(leads ?? 0, by);

  const waitingOnYou = !quotaPaused && (status === 'paused' || status === 'idle');
  const when = ago(agent.updatedAt);
  const kind = USE_CASE_LABEL[agent.useCase] ?? agent.useCase;
  const verb = status === 'running' ? 'running' : status === 'paused' || quotaPaused ? 'paused' : 'ran';
  const blurb = agent.mission || agent.description;

  return (
    <article className="group rounded-2xl border border-line bg-bg-panel p-5 shadow-sm">
      <div className="flex items-start gap-3">
        <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-bg-soft text-ink-3">
          <Cpu size={15} />
        </span>
        <div className="min-w-0 flex-1">
          <Link href={`/agents/${agent.id}`} className="block truncate text-body font-semibold text-ink hover:underline">
            {agent.name}
          </Link>
          <div className="truncate text-xs text-ink-3">
            {kind} · {verb} {when} ago
          </div>
        </div>
        <button
          type="button"
          onClick={onDelete}
          aria-label={`Delete ${agent.name}`}
          className="rounded-md p-1 text-ink-4 opacity-0 transition-opacity hover:text-down focus-visible:opacity-100 group-hover:opacity-100"
        >
          <Trash2 size={14} />
        </button>
      </div>

      <div
        className={cn(
          'mt-4 flex items-center gap-2 rounded-md px-2.5 py-1.5 text-xs font-medium',
          info.tone === 'warn' && 'bg-warn/10 text-warn-fg',
          info.tone === 'up' && 'bg-up/10 text-up',
          info.tone === 'down' && 'bg-down/10 text-down',
          info.tone === 'muted' && 'bg-bg-soft text-ink-3',
        )}
      >
        <span className="size-1.5 shrink-0 rounded-full bg-current" />
        <span className="truncate">{statusLabel}</span>
      </div>

      {blurb && <p className="mb-0 mt-3 line-clamp-3 text-body leading-relaxed text-ink-3">{blurb}</p>}

      <div className="mt-4 grid grid-cols-6 gap-1" aria-label="Pipeline progress">
        {STAGES.map((name, i) => (
          <div key={name}>
            <div className={cn('h-[3px] rounded-full', lit[i] ? 'bg-up' : 'bg-line')} />
            <div className="mt-1 truncate text-3xs text-ink-4">{name}</div>
          </div>
        ))}
      </div>

      <p className="mb-0 mt-3 font-mono text-xs leading-relaxed text-ink-3">
        {leads == null
          ? '—'
          : [
              `${leads} lead${leads === 1 ? '' : 's'}`,
              `${contacted} contacted`,
              replies ? `${replies} repl${replies === 1 ? 'y' : 'ies'}` : null,
              waitingOnYou ? 'waiting on you' : null,
            ]
              .filter(Boolean)
              .join(' · ')}
      </p>

      <div className="mt-4 flex items-center gap-2">
        {quotaPaused ? (
          <Button size="sm" asChild variant="panel">
            <Link href={`/agents/${agent.id}?tab=settings`}>View limits</Link>
          </Button>
        ) : status === 'running' ? (
          <Button size="sm" type="button" variant="panel" onClick={onStop} disabled={busy}>
            Pause
          </Button>
        ) : status !== 'awaiting_action_plan' ? (
          <Button size="sm" type="button" variant="panel" onClick={onStart} disabled={busy}>
            Resume
          </Button>
        ) : null}
        <Button size="sm" asChild variant="ghost">
          <Link href={`/agents/${agent.id}`}>View</Link>
        </Button>
      </div>
    </article>
  );
}
