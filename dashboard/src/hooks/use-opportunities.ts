'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPatch } from '@/lib/api';
import type { Opportunity, OpportunityStats } from '@/types';

interface OpportunityFilters {
  type?: string;
  status?: string;
  urgency?: string;
  minScore?: number;
  limit?: number;
  cursor?: string;
}

export function useOpportunities(masterAgentId: string, filters?: OpportunityFilters) {
  const params = new URLSearchParams();
  if (filters?.type) params.set('type', filters.type);
  if (filters?.status) params.set('status', filters.status);
  if (filters?.urgency) params.set('urgency', filters.urgency);
  if (filters?.minScore) params.set('minScore', String(filters.minScore));
  if (filters?.limit) params.set('limit', String(filters.limit));
  if (filters?.cursor) params.set('cursor', filters.cursor);

  const qs = params.toString();
  return useQuery({
    queryKey: ['opportunities', masterAgentId, filters],
    queryFn: () =>
      apiGet<{ data: Opportunity[]; pagination: { hasMore: boolean; nextCursor: string | null } }>(
        `/opportunities/${masterAgentId}/list${qs ? `?${qs}` : ''}`
      ),
    enabled: !!masterAgentId,
    staleTime: 30000,
  });
}

export function useOpportunityStats(masterAgentId: string) {
  return useQuery({
    queryKey: ['opportunities', masterAgentId, 'stats'],
    queryFn: () => apiGet<OpportunityStats>(`/opportunities/${masterAgentId}/stats`),
    enabled: !!masterAgentId,
    staleTime: 30000,
  });
}

export function useUpdateOpportunityStatus() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ masterAgentId, opportunityId, status }: { masterAgentId: string; opportunityId: string; status: string }) =>
      apiPatch<Opportunity>(`/opportunities/${masterAgentId}/detail/${opportunityId}`, { status }),
    onSuccess: (_, { masterAgentId }) => {
      qc.invalidateQueries({ queryKey: ['opportunities', masterAgentId] });
    },
  });
}
