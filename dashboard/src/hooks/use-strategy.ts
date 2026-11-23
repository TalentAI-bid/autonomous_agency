'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost } from '@/lib/api';
import type { DailyStrategy } from '@/types';
import { STALE } from '@/lib/query';

export function useStrategyHistory(masterAgentId: string) {
  return useQuery({
    queryKey: ['strategy', masterAgentId, 'history'],
    queryFn: () => apiGet<DailyStrategy[]>(`/strategy/${masterAgentId}/history`),
    enabled: !!masterAgentId,
    staleTime: STALE.long,
  });
}

export function useLatestStrategy(masterAgentId: string) {
  return useQuery({
    queryKey: ['strategy', masterAgentId, 'latest'],
    queryFn: () => apiGet<DailyStrategy | null>(`/strategy/${masterAgentId}/latest`),
    enabled: !!masterAgentId,
    staleTime: STALE.long,
  });
}

export function useTriggerStrategy() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (masterAgentId: string) =>
      apiPost<{ jobId: string; message: string }>(`/strategy/${masterAgentId}/trigger`),
    onSuccess: (_, masterAgentId) => {
      qc.invalidateQueries({ queryKey: ['strategy', masterAgentId] });
    },
  });
}
