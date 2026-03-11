'use client';

import { useParams } from 'next/navigation';
import { AgentRoom } from '@/components/agents/agent-room';

export default function AgentRoomPage() {
  const { id } = useParams<{ id: string }>();
  return <AgentRoom masterAgentId={id} />;
}
