'use client';

import { QueueView } from '@/components/queue/queue-view';

interface AgentQueueTabProps {
  agentId: string;
  agentName?: string | null;
}

export function AgentQueueTab({ agentId, agentName }: AgentQueueTabProps) {
  return (
    <div className="flex flex-col gap-3">
      <div className="text-[13px] text-ink-3">
        Daily queue for <strong className="text-ink">{agentName ?? 'this agent'}</strong>.
        Only actions for companies this agent owns are shown.
      </div>
      <QueueView masterAgentId={agentId} />
    </div>
  );
}
