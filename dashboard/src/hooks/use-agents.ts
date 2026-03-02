'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost, apiPatch, apiDelete } from '@/lib/api';
import type { MasterAgent, AgentConfig, Company, Document } from '@/types';

export function useAgents() {
  return useQuery({
    queryKey: ['agents'],
    queryFn: () => apiGet<MasterAgent[]>('/master-agents'),
    staleTime: 30000,
  });
}

export function useMasterAgent(id: string) {
  return useQuery({
    queryKey: ['agents', id],
    queryFn: () => apiGet<MasterAgent>(`/master-agents/${id}`),
    enabled: !!id,
    staleTime: 15000,
  });
}

export function useAgentConfigs(masterAgentId: string) {
  return useQuery({
    queryKey: ['agents', masterAgentId, 'configs'],
    queryFn: () => apiGet<AgentConfig[]>(`/master-agents/${masterAgentId}/agents`),
    enabled: !!masterAgentId,
  });
}

export function useCreateAgent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: {
      name: string;
      mission?: string;
      useCase: string;
      description?: string;
      config?: Record<string, unknown>;
    }) => apiPost<MasterAgent>('/master-agents', data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['agents'] }),
  });
}

export function useUpdateAgent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...data }: Partial<MasterAgent> & { id: string }) =>
      apiPatch<MasterAgent>(`/master-agents/${id}`, data),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['agents'] });
      qc.invalidateQueries({ queryKey: ['agents', vars.id] });
    },
  });
}

export function useStartAgent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiPost<{ status: string; queryCount: number; dispatchedJobIds: string[] }>(`/master-agents/${id}/start`),
    onSuccess: (_, id) => {
      qc.invalidateQueries({ queryKey: ['agents'] });
      qc.invalidateQueries({ queryKey: ['agents', id] });
    },
  });
}

export function useStopAgent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiPost<{ status: string }>(`/master-agents/${id}/stop`),
    onSuccess: (_, id) => {
      qc.invalidateQueries({ queryKey: ['agents'] });
      qc.invalidateQueries({ queryKey: ['agents', id] });
    },
  });
}

export function useDeleteAgent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiDelete<{ success: boolean }>(`/master-agents/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['agents'] }),
  });
}

interface AgentStats {
  totalContacts: number;
  byStatus: Record<string, number>;
  avgScore: number | null;
}

export function useAgentStats(id: string) {
  return useQuery({
    queryKey: ['agents', id, 'stats'],
    queryFn: () => apiGet<AgentStats>(`/master-agents/${id}/stats`),
    enabled: !!id,
    staleTime: 15000,
  });
}

interface AgentEmail {
  id: string;
  fromEmail: string | null;
  toEmail: string | null;
  subject: string | null;
  sentAt: string | null;
  openedAt: string | null;
  repliedAt: string | null;
  messageId: string | null;
}

export function useAgentEmails(id: string) {
  return useQuery({
    queryKey: ['agents', id, 'emails'],
    queryFn: () => apiGet<AgentEmail[]>(`/master-agents/${id}/emails`),
    enabled: !!id,
    staleTime: 15000,
  });
}

export function useAgentCompanies(id: string) {
  return useQuery({
    queryKey: ['agents', id, 'companies'],
    queryFn: () => apiGet<Company[]>(`/master-agents/${id}/companies`),
    enabled: !!id,
    staleTime: 15000,
  });
}

export function useAgentDocuments(id: string) {
  return useQuery({
    queryKey: ['agents', id, 'documents'],
    queryFn: () => apiGet<Document[]>(`/master-agents/${id}/documents`),
    enabled: !!id,
    staleTime: 15000,
  });
}
