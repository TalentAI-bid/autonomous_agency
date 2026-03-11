'use client';

import { useQuery } from '@tanstack/react-query';
import axiosInstance from '@/lib/api';
import { apiGet } from '@/lib/api';
import type { ActivityLogEntry, ActivityStats } from '@/types';

interface ActivityFeedParams {
  masterAgentId?: string;
  agentType?: string;
  status?: string;
  limit?: number;
  cursor?: string;
}

interface ActivityFeedResponse {
  data: ActivityLogEntry[];
  pagination: { hasMore: boolean; nextCursor: string | null };
}

export function useActivityFeed(params: ActivityFeedParams) {
  return useQuery({
    queryKey: ['activity', 'feed', params],
    queryFn: async () => {
      const searchParams: Record<string, unknown> = {};
      if (params.masterAgentId) searchParams.masterAgentId = params.masterAgentId;
      if (params.agentType) searchParams.agentType = params.agentType;
      if (params.status) searchParams.status = params.status;
      if (params.limit) searchParams.limit = params.limit;
      if (params.cursor) searchParams.cursor = params.cursor;

      const res = await axiosInstance.get<ActivityFeedResponse>('/activity/feed', { params: searchParams });
      return res.data;
    },
    staleTime: 10000,
    refetchInterval: 15000,
  });
}

interface ActivityStatsParams {
  masterAgentId?: string;
  hours?: number;
}

export function useActivityStats(params: ActivityStatsParams) {
  return useQuery({
    queryKey: ['activity', 'stats', params],
    queryFn: async () => {
      const searchParams: Record<string, unknown> = {};
      if (params.masterAgentId) searchParams.masterAgentId = params.masterAgentId;
      if (params.hours) searchParams.hours = params.hours;
      return apiGet<ActivityStats>('/activity/stats', searchParams);
    },
    staleTime: 15000,
  });
}

interface LiveAction {
  action: string;
  description?: string;
  startedAt: string;
  masterAgentId: string;
}

export function useAgentLiveStatus(masterAgentId?: string) {
  return useQuery({
    queryKey: ['agents', 'live-status', masterAgentId],
    queryFn: () =>
      apiGet<Record<string, LiveAction>>('/agents/live-status', { masterAgentId }),
    enabled: !!masterAgentId,
    staleTime: 5000,
    refetchInterval: 5000,
  });
}
