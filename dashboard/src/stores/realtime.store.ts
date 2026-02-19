'use client';

import { create } from 'zustand';
import type { AgentEvent, AgentStatus, AgentType } from '@/types';

const MAX_EVENTS = 200;

interface RealtimeState {
  connected: boolean;
  events: AgentEvent[];
  agentStatuses: Partial<Record<AgentType, AgentStatus>>;
  contactCounts: Record<string, number>; // masterAgentId → count

  setConnected: (connected: boolean) => void;
  addEvent: (event: AgentEvent) => void;
  updateAgentStatus: (agentType: AgentType, status: Partial<AgentStatus>) => void;
  incrementContactCount: (masterAgentId: string) => void;
  clear: () => void;
}

export const useRealtimeStore = create<RealtimeState>((set) => ({
  connected: false,
  events: [],
  agentStatuses: {},
  contactCounts: {},

  setConnected: (connected) => set({ connected }),

  addEvent: (event) =>
    set((state) => {
      const events = [event, ...state.events].slice(0, MAX_EVENTS);
      return { events };
    }),

  updateAgentStatus: (agentType, status) =>
    set((state) => ({
      agentStatuses: {
        ...state.agentStatuses,
        [agentType]: {
          agentType,
          status: 'idle',
          jobsCompleted: 0,
          jobsFailed: 0,
          ...(state.agentStatuses[agentType] ?? {}),
          ...status,
        } as AgentStatus,
      },
    })),

  incrementContactCount: (masterAgentId) =>
    set((state) => ({
      contactCounts: {
        ...state.contactCounts,
        [masterAgentId]: (state.contactCounts[masterAgentId] ?? 0) + 1,
      },
    })),

  clear: () => set({ events: [], agentStatuses: {}, contactCounts: {} }),
}));
