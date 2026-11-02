'use client';

import { Info } from 'lucide-react';
import { QueueView } from '@/components/queue/queue-view';

interface AgentQueueTabProps {
  agentId: string;
  agentName?: string | null;
}

export function AgentQueueTab({ agentId, agentName }: AgentQueueTabProps) {
  return (
    <div className="flex flex-col gap-4">
      <p className="m-0 flex items-center gap-2 text-body text-ink-3">
        <Info size={13} className="shrink-0" />
        <span>
          Messages drafted by <strong className="font-semibold text-ink">{agentName ?? 'this agent'}</strong> for you to approve. Nothing sends until you do.
        </span>
      </p>
      <QueueView masterAgentId={agentId} />
    </div>
  );
}
