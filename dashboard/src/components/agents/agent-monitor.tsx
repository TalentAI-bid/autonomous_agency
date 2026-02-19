'use client';

import { useRealtimeStore } from '@/stores/realtime.store';
import { AgentStatusCard } from './agent-status-card';
import type { AgentType } from '@/types';

const AGENT_TYPES: AgentType[] = ['discovery', 'document', 'enrichment', 'scoring', 'outreach', 'reply', 'action'];

interface AgentMonitorProps {
  masterAgentId?: string;
}

export function AgentMonitor({ masterAgentId: _ }: AgentMonitorProps) {
  const agentStatuses = useRealtimeStore((s) => s.agentStatuses);

  return (
    <div>
      <h2 className="text-sm font-medium text-muted-foreground mb-3">Agent Pipeline</h2>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-7 gap-3">
        {AGENT_TYPES.map((type) => (
          <AgentStatusCard key={type} agentType={type} status={agentStatuses[type]} />
        ))}
      </div>
    </div>
  );
}
