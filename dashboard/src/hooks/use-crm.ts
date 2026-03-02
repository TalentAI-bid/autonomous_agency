'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost, apiPatch, apiDelete } from '@/lib/api';
import type { CrmStage, Deal, DealWithContact, CrmActivity, BoardColumn } from '@/types';

// ── Stages ────────────────────────────────────────────────────────────────────

export function useCrmStages() {
  return useQuery({
    queryKey: ['crm', 'stages'],
    queryFn: () => apiGet<CrmStage[]>('/crm/stages'),
    staleTime: 60000,
  });
}

export function useSeedStages() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => apiPost<CrmStage[]>('/crm/stages/seed'),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['crm'] }),
  });
}

export function useCreateStage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: Partial<CrmStage>) => apiPost<CrmStage>('/crm/stages', data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['crm', 'stages'] }),
  });
}

export function useUpdateStage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...data }: Partial<CrmStage> & { id: string }) =>
      apiPatch<CrmStage>(`/crm/stages/${id}`, data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['crm'] }),
  });
}

export function useDeleteStage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiDelete<{ success: boolean }>(`/crm/stages/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['crm'] }),
  });
}

// ── Deals ─────────────────────────────────────────────────────────────────────

export function useDeals(filters?: { stageId?: string; contactId?: string; masterAgentId?: string }) {
  return useQuery({
    queryKey: ['crm', 'deals', filters],
    queryFn: () => apiGet<Deal[]>('/crm/deals', filters as Record<string, unknown>),
    staleTime: 15000,
  });
}

export function useDeal(id: string) {
  return useQuery({
    queryKey: ['crm', 'deals', id],
    queryFn: () => apiGet<DealWithContact>(`/crm/deals/${id}`),
    enabled: !!id,
    staleTime: 15000,
  });
}

export function useCreateDeal() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: {
      contactId: string;
      stageId: string;
      title: string;
      value?: string;
      currency?: string;
      notes?: string;
      masterAgentId?: string;
      campaignId?: string;
      expectedCloseAt?: string;
    }) => apiPost<Deal>('/crm/deals', data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['crm'] }),
  });
}

export function useUpdateDeal() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...data }: Partial<Deal> & { id: string }) =>
      apiPatch<Deal>(`/crm/deals/${id}`, data),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['crm', 'deals'] });
      qc.invalidateQueries({ queryKey: ['crm', 'deals', vars.id] });
    },
  });
}

export function useDeleteDeal() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiDelete<{ success: boolean }>(`/crm/deals/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['crm'] }),
  });
}

export function useMoveDealStage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ dealId, stageId }: { dealId: string; stageId: string }) =>
      apiPost<{ success: boolean }>(`/crm/deals/${dealId}/move`, { stageId }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['crm'] }),
  });
}

// ── Activities ────────────────────────────────────────────────────────────────

export function useDealActivities(dealId: string) {
  return useQuery({
    queryKey: ['crm', 'activities', { dealId }],
    queryFn: () => apiGet<CrmActivity[]>('/crm/activities', { dealId }),
    enabled: !!dealId,
    staleTime: 15000,
  });
}

export function useContactTimeline(contactId: string) {
  return useQuery({
    queryKey: ['crm', 'timeline', contactId],
    queryFn: () => apiGet<CrmActivity[]>(`/crm/contacts/${contactId}/timeline`),
    enabled: !!contactId,
    staleTime: 15000,
  });
}

export function useCreateActivity() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: {
      contactId?: string;
      dealId?: string;
      type: string;
      title: string;
      description?: string;
      metadata?: Record<string, unknown>;
    }) => apiPost<{ id: string }>('/crm/activities', data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['crm', 'activities'] }),
  });
}

// ── Board ─────────────────────────────────────────────────────────────────────

export function useCrmBoard() {
  return useQuery({
    queryKey: ['crm', 'board'],
    queryFn: () => apiGet<BoardColumn[]>('/crm/board'),
    staleTime: 15000,
  });
}
