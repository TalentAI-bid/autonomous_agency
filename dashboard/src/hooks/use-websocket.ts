'use client';

import { useEffect, useRef } from 'react';
import { wsManager } from '@/lib/websocket';
import { useAuthStore } from '@/stores/auth.store';
import { useRealtimeStore } from '@/stores/realtime.store';
import { useQueryClient } from '@tanstack/react-query';
import type { AgentEvent } from '@/types';

export function useWebSocket() {
  const token = useAuthStore((s) => s.token);
  const hasHydrated = useAuthStore((s) => s.hasHydrated);
  const { addEvent, updateAgentStatus, incrementContactCount, setConnected, updateAgentLiveAction, addAgentMessage } = useRealtimeStore();
  const queryClient = useQueryClient();
  const initialized = useRef(false);

  useEffect(() => {
    if (!hasHydrated || !token || initialized.current) return;
    initialized.current = true;

    wsManager.connect(token);

    // Connection state
    wsManager.subscribe('ws:connected', () => setConnected(true));
    wsManager.subscribe('ws:disconnected', () => setConnected(false));

    // All agent events
    wsManager.subscribe('*', (event: AgentEvent) => {
      if (event.event.startsWith('ws:')) return;
      addEvent(event);
    });

    // Agent status updates
    wsManager.subscribe('agent:status', (event: AgentEvent) => {
      const { agentType, status } = event.data as { agentType: string; status: string };
      if (agentType) {
        updateAgentStatus(agentType as never, { status: status as never, lastActivity: event.timestamp });
      }
    });

    // Contact discovered
    wsManager.subscribe('contact:discovered', (event: AgentEvent) => {
      const { masterAgentId } = event.data as { masterAgentId?: string };
      if (masterAgentId) incrementContactCount(masterAgentId);
      queryClient.invalidateQueries({ queryKey: ['contacts'] });
    });

    // General invalidations
    wsManager.subscribe('contact:scored', () => {
      queryClient.invalidateQueries({ queryKey: ['contacts'] });
    });
    wsManager.subscribe('email:sent', () => {
      queryClient.invalidateQueries({ queryKey: ['campaigns'] });
      queryClient.invalidateQueries({ queryKey: ['mailbox'] });
    });
    wsManager.subscribe('campaign:metrics', () => {
      queryClient.invalidateQueries({ queryKey: ['analytics'] });
    });

    // Mailbox real-time updates
    wsManager.subscribe('mailbox:thread_updated', () => {
      queryClient.invalidateQueries({ queryKey: ['mailbox'] });
    });
    wsManager.subscribe('email:replied', () => {
      queryClient.invalidateQueries({ queryKey: ['mailbox'] });
    });
    wsManager.subscribe('email:inbound_classified', () => {
      queryClient.invalidateQueries({ queryKey: ['mailbox'] });
    });

    // Activity feed updates
    wsManager.subscribe('agent:activity', () => {
      queryClient.invalidateQueries({ queryKey: ['activity'] });
    });

    // Live agent status changes
    wsManager.subscribe('agent:status_change', (event: AgentEvent) => {
      const { agentType, action, description, status } = event.data as {
        agentType?: string;
        action?: string;
        description?: string;
        status?: string;
      };
      if (agentType) {
        if (status === 'idle') {
          updateAgentLiveAction(agentType);
        } else {
          updateAgentLiveAction(agentType, action, description);
        }
      }
    });

    // Agent room messages
    wsManager.subscribe('agent:message', (event: AgentEvent) => {
      const data = event.data as Record<string, unknown>;
      addAgentMessage({
        id: (data.id as string) ?? crypto.randomUUID(),
        masterAgentId: (data.masterAgentId as string) ?? '',
        fromAgent: (data.fromAgent as string) ?? '',
        toAgent: data.toAgent as string | undefined,
        messageType: (data.messageType as string) ?? '',
        content: (data.content as Record<string, unknown>) ?? {},
        metadata: data.metadata as Record<string, unknown> | undefined,
        createdAt: event.timestamp,
      });
      queryClient.invalidateQueries({ queryKey: ['agent-room'] });
    });

    // Strategy completed
    wsManager.subscribe('strategy:completed', () => {
      queryClient.invalidateQueries({ queryKey: ['strategy'] });
    });

    // Opportunity events
    wsManager.subscribe('opportunity:discovered', () => {
      queryClient.invalidateQueries({ queryKey: ['opportunities'] });
    });
    wsManager.subscribe('opportunity:qualified', () => {
      queryClient.invalidateQueries({ queryKey: ['opportunities'] });
    });
    wsManager.subscribe('opportunity:contacted', () => {
      queryClient.invalidateQueries({ queryKey: ['opportunities'] });
    });

    return () => {
      wsManager.disconnect();
      initialized.current = false;
    };
  }, [hasHydrated, token, addEvent, updateAgentStatus, incrementContactCount, setConnected, updateAgentLiveAction, addAgentMessage, queryClient]);

  const connected = useRealtimeStore((s) => s.connected);
  return { connected };
}
