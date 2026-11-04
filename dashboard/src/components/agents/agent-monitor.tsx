'use client';

import { useRealtimeStore } from '@/stores/realtime.store';
import { Card } from '@/components/ui/card';
import { AgentStatusCard } from './agent-status-card';
import type { AgentType } from '@/types';

const AGENT_TYPES: AgentType[] = ['strategist', 'discovery', 'document', 'enrichment', 'scoring', 'outreach', 'reply', 'action', 'strategy'];

interface AgentMonitorProps {
  masterAgentId?: string;
}

export function AgentMonitor({ masterAgentId: _ }: AgentMonitorProps) {
  const agentStatuses = useRealtimeStore((s) => s.agentStatuses);
  const agentLiveActions = useRealtimeStore((s) => s.agentLiveActions);
  const running = AGENT_TYPES.filter((t) => agentStatuses[t]?.status === 'running').length;

  return (
    <Card as="section" className="overflow-hidden">
      <header className="flex items-center justify-between gap-3 border-b border-line px-5 py-3.5">
        <div>
          <h2 className="m-0 text-body font-semibold text-ink">Agent pipeline</h2>
          <p className="mb-0 mt-0.5 text-xs text-ink-3">The workers behind this agent and what each is doing right now.</p>
        </div>
        {running > 0 ? (
          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-up">
            <span className="size-1.5 animate-pulse rounded-full bg-current" /> {running} running
          </span>
        ) : (
          <span className="text-xs text-ink-4">All idle</span>
        )}
      </header>
      <div className="grid grid-cols-2 gap-2.5 p-4 sm:grid-cols-3 xl:grid-cols-5">
        {AGENT_TYPES.map((type) => (
          <AgentStatusCard key={type} agentType={type} status={agentStatuses[type]} liveAction={agentLiveActions[type]} />
        ))}
      </div>
    </Card>
  );
}
