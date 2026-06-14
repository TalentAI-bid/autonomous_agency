'use client';

import { QueueView } from '@/components/queue/queue-view';

interface AgentQueueTabProps {
  agentId: string;
  agentName?: string | null;
}

export function AgentQueueTab({ agentId, agentName }: AgentQueueTabProps) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ fontSize: 13, color: 'var(--ink-3)' }}>
        Daily queue for <strong style={{ color: 'var(--ink-1)' }}>{agentName ?? 'this agent'}</strong>.
        Only actions for companies this agent owns are shown.
      </div>
      <QueueView masterAgentId={agentId} />
    </div>
  );
}
