import type { ReactNode } from 'react';
import { Badge } from '@/components/ui/badge';
import { AgentMonitor } from '@/components/agents/agent-monitor';
import { cn, formatDate, getStatusColor } from '@/lib/utils';
import type { useAgentStats } from '@/hooks/use-agents';
import type { useRealtimeStore } from '@/stores/realtime.store';
import type { MasterAgent } from '@/types';

type Stats = ReturnType<typeof useAgentStats>['data'];
type AgentEvent = ReturnType<typeof useRealtimeStore.getState>['events'][number];

function Panel({ title, aside, children, className }: { title: string; aside?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn('overflow-hidden rounded-2xl border border-line bg-bg-panel shadow-sm', className)}>
      <header className="flex items-center justify-between gap-3 border-b border-line px-5 py-3.5">
        <h2 className="m-0 text-body font-semibold text-ink">{title}</h2>
        {aside}
      </header>
      <div className="p-5">{children}</div>
    </section>
  );
}

const Empty = ({ children }: { children: ReactNode }) => <p className="m-0 py-4 text-center text-body text-ink-3">{children}</p>;

const Chip = ({ children, soft }: { children: ReactNode; soft?: boolean }) => (
  <span className={cn('rounded-tag px-2 py-1 text-xs', soft ? 'bg-accent-weak text-accent-fg' : 'bg-bg-soft text-ink-2')}>{children}</span>
);

function ChipGroup({ label, items, soft }: { label: string; items: string[]; soft?: boolean }) {
  if (items.length === 0) return null;
  return (
    <div>
      <div className="mb-1.5 text-3xs font-medium uppercase tracking-[0.09em] text-ink-4">{label}</div>
      <div className="flex flex-wrap gap-1.5">
        {items.map((i) => (
          <Chip key={i} soft={soft}>
            {i}
          </Chip>
        ))}
      </div>
    </div>
  );
}

export function OverviewTab({
  agentId,
  agent,
  stats,
  totalContacts,
  events,
}: {
  agentId: string;
  agent: MasterAgent;
  stats: Stats;
  totalContacts: number;
  events: AgentEvent[];
}) {
  const config = (agent.config ?? {}) as Record<string, unknown>;
  const targetRoles = (config.targetRoles as string[]) ?? [];
  const requiredSkills = (config.requiredSkills as string[]) ?? [];
  const locations = (config.locations as string[]) ?? [];
  const byStatus = stats?.byStatus ?? {};
  const sales = agent.useCase === 'sales';

  const funnelStages = [
    { label: 'Discovered', value: byStatus.discovered ?? 0, color: 'bg-info' },
    { label: 'Enriched', value: byStatus.enriched ?? 0, color: 'bg-info' },
    { label: 'Scored', value: byStatus.scored ?? 0, color: 'bg-a-master' },
    { label: 'Contacted', value: byStatus.contacted ?? 0, color: 'bg-up' },
  ];

  const strategy =
    typeof config.bdStrategy === 'string'
      ? config.bdStrategy === 'hiring_signal'
        ? 'Hiring signal (job boards)'
        : config.bdStrategy === 'industry_target'
          ? 'Industry targeting (registries)'
          : 'Hybrid (both)'
      : null;
  const noRequirements = targetRoles.length === 0 && requiredSkills.length === 0 && locations.length === 0;

  return (
    <div className="space-y-5">
      <AgentMonitor masterAgentId={agentId} />

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <Panel
          title="Pipeline"
          aside={
            stats?.avgScore != null ? (
              <Badge variant="muted" className="font-mono">avg score {stats.avgScore}</Badge>
            ) : undefined
          }
        >
          {totalContacts === 0 ? (
            <Empty>No leads yet. Run the agent to start the pipeline.</Empty>
          ) : (
            <div className="space-y-3.5">
              {funnelStages.map((stage, i) => {
                const pct = Math.min(100, Math.round((stage.value / totalContacts) * 100));
                return (
                  <div key={stage.label} className="flex items-center gap-3">
                    <span className="grid size-5 shrink-0 place-items-center rounded-full bg-bg-sub font-mono text-2xs text-ink-3">{i + 1}</span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline justify-between text-body">
                        <span className="text-ink-2">{stage.label}</span>
                        <span>
                          <span className="font-mono font-medium text-ink">{stage.value}</span>
                          <span className="ml-1.5 font-mono text-2xs text-ink-4">{pct}%</span>
                        </span>
                      </div>
                      <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-bg-soft">
                        <div className={cn('h-full rounded-full transition-all', stage.color)} style={{ width: `${pct}%` }} />
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </Panel>

        <Panel title="What it looks for">
          {noRequirements && !strategy ? (
            <Empty>Requirements appear after the agent runs.</Empty>
          ) : (
            <div className="space-y-4">
              <ChipGroup label={sales ? 'Decision-makers' : 'Target roles'} items={targetRoles} soft />
              <ChipGroup label={sales ? 'Company attributes' : 'Required skills'} items={requiredSkills} />
              <ChipGroup label="Locations" items={locations} />
              {strategy && (
                <div>
                  <div className="mb-1.5 text-3xs font-medium uppercase tracking-[0.09em] text-ink-4">Discovery strategy</div>
                  <Chip>{strategy}</Chip>
                </div>
              )}
            </div>
          )}
        </Panel>
      </div>

      <Panel
        title="Live events"
        aside={
          agent.status === 'running' ? (
            <span className="inline-flex items-center gap-1.5 text-xs font-medium text-up">
              <span className="size-1.5 animate-pulse rounded-full bg-current" /> Live
            </span>
          ) : undefined
        }
      >
        {events.length === 0 ? (
          <Empty>{agent.status === 'running' ? 'Waiting for events…' : 'No events yet. Run the agent to see activity here.'}</Empty>
        ) : (
          <ul className="scroll-thin m-0 max-h-[300px] list-none overflow-y-auto p-0">
            {events.map((event, i) => (
              <li key={i} className="relative flex gap-3 pb-3 last:pb-0">
                {i < events.length - 1 && <span className="absolute left-[4.5px] top-3 h-full w-px bg-line" />}
                <span className="relative mt-1.5 size-[10px] shrink-0 rounded-full border-2 border-bg-panel bg-line-strong ring-1 ring-line" />
                <div className="min-w-0 flex-1 text-xs">
                  <span className={cn('font-medium', getStatusColor(event.event))}>{event.event}</span>
                  {event.data && typeof event.data === 'object' && 'message' in event.data && (
                    <p className="m-0 mt-0.5 truncate text-ink-3">{String(event.data.message)}</p>
                  )}
                </div>
                <span className="shrink-0 font-mono text-2xs text-ink-4">{formatDate(event.timestamp, 'HH:mm:ss')}</span>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}
