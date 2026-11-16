'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost } from '@/lib/api';
import { usePollInterval } from '@/hooks/use-poll-interval';

export interface AgentMessage {
  id: string;
  tenantId: string;
  masterAgentId: string;
  fromAgent: string;
  toAgent?: string;
  messageType: string;
  content: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

export function useAgentRoomMessages(masterAgentId: string, filters?: { fromAgent?: string; messageType?: string }) {
  // 'agent:message' over the WebSocket already invalidates this; polling is the fallback.
  const refetchInterval = usePollInterval(5000, 30000);
  return useQuery({
    queryKey: ['agent-room', masterAgentId, filters],
    queryFn: () => {
      const params = new URLSearchParams();
      if (filters?.fromAgent) params.set('fromAgent', filters.fromAgent);
      if (filters?.messageType) params.set('messageType', filters.messageType);
      params.set('limit', '100');
      return apiGet<{ data: AgentMessage[]; pagination: { hasMore: boolean; nextCursor: string | null } }>(
        `/agent-room/${masterAgentId}/messages?${params.toString()}`
      );
    },
    refetchInterval,
    enabled: !!masterAgentId,
  });
}

export function useSendHumanMessage(masterAgentId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { toAgent: string; content: string; actionType: 'instruction' | 'question' | 'override' }) =>
      apiPost(`/agent-room/${masterAgentId}/messages`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['agent-room', masterAgentId] });
    },
  });
}
