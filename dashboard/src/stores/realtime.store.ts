'use client';

import { create } from 'zustand';
import type { AgentEvent, AgentStatus, AgentType } from '@/types';

const MAX_EVENTS = 200;

interface LiveAction {
  action: string;
  description?: string;
  startedAt: string;
}

interface AgentMessage {
  id: string;
  masterAgentId: string;
  fromAgent: string;
  toAgent?: string;
  messageType: string;
  content: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

interface RealtimeState {
  connected: boolean;
  events: AgentEvent[];
  agentStatuses: Partial<Record<AgentType, AgentStatus>>;
  contactCounts: Record<string, number>; // masterAgentId → count
  agentLiveActions: Record<string, LiveAction>; // agentType → live action
  agentMessages: AgentMessage[];

  setConnected: (connected: boolean) => void;
  addEvent: (event: AgentEvent) => void;
  updateAgentStatus: (agentType: AgentType, status: Partial<AgentStatus>) => void;
  incrementContactCount: (masterAgentId: string) => void;
  updateAgentLiveAction: (agentType: string, action?: string, description?: string) => void;
  addAgentMessage: (message: AgentMessage) => void;
  clear: () => void;
}

export const useRealtimeStore = create<RealtimeState>((set) => ({
  connected: false,
  events: [],
  agentStatuses: {},
  contactCounts: {},
  agentLiveActions: {},
  agentMessages: [],

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

  updateAgentLiveAction: (agentType, action, description) =>
    set((state) => {
      if (!action) {
        const { [agentType]: _, ...rest } = state.agentLiveActions;
        return { agentLiveActions: rest };
      }
      return {
        agentLiveActions: {
          ...state.agentLiveActions,
          [agentType]: { action, description, startedAt: new Date().toISOString() },
        },
      };
    }),

  addAgentMessage: (message) =>
    set((state) => ({
      agentMessages: [message, ...state.agentMessages].slice(0, MAX_EVENTS),
    })),

  clear: () => set({ events: [], agentStatuses: {}, contactCounts: {}, agentLiveActions: {}, agentMessages: [] }),
}));
