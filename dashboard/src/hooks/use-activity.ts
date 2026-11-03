'use client';

import { useQuery } from '@tanstack/react-query';
import axiosInstance from '@/lib/api';
import type { ActivityLogEntry } from '@/types';

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

