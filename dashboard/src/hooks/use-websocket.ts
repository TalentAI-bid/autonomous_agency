'use client';

import { useEffect, useRef } from 'react';
import { wsManager } from '@/lib/websocket';
import { useAuthStore } from '@/stores/auth.store';
import { useRealtimeStore } from '@/stores/realtime.store';
import { useQueryClient } from '@tanstack/react-query';
import type { AgentEvent } from '@/types';

export function useWebSocket() {
  const token = useAuthStore((s) => s.token);
  const { addEvent, updateAgentStatus, incrementContactCount, setConnected } = useRealtimeStore();
  const queryClient = useQueryClient();
  const initialized = useRef(false);

  useEffect(() => {
    if (!token || initialized.current) return;
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

    return () => {
      wsManager.disconnect();
      initialized.current = false;
    };
  }, [token, addEvent, updateAgentStatus, incrementContactCount, setConnected, queryClient]);

  const connected = useRealtimeStore((s) => s.connected);
  return { connected };
}
