'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiGetPaginated, apiPost, apiPatch, apiDelete } from '@/lib/api';
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

export function useAgentCompanies(
  id: string,
  options: { includeIncomplete?: boolean; cursor?: string | null } = {},
) {
  const { includeIncomplete = false, cursor } = options;
  return useQuery({
    queryKey: ['agents', id, 'companies', { includeIncomplete, cursor: cursor ?? null }],
    queryFn: () => apiGetPaginated<Company>(`/master-agents/${id}/companies`, {
      ...(includeIncomplete ? { includeIncomplete: 'true' } : {}),
      ...(cursor ? { cursor } : {}),
    }),
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

// ── Action plan ──────────────────────────────────────────────────────────────

export interface ActionPlanItem {
  key: string;
  question: string;
  required: boolean;
  answer?: string | null;
}
export interface ActionPlan {
  status: 'pending' | 'completed' | 'skipped';
  items: ActionPlanItem[];
  generatedAt?: string;
  completedAt?: string;
}
export interface ActionPlanResponse {
  actionPlan: ActionPlan | null;
  status: string;
  useCase: string;
}

export function useActionPlan(id: string) {
  return useQuery({
    queryKey: ['agents', id, 'action-plan'],
    queryFn: () => apiGet<ActionPlanResponse>(`/master-agents/${id}/action-plan`),
    enabled: !!id,
    staleTime: 15000,
  });
}

export function useUpdateActionPlan(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { answers: Record<string, string | undefined>; skip?: boolean }) =>
      apiPatch<{ actionPlan: ActionPlan; status: string }>(`/master-agents/${id}/action-plan`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['agents', id] });
      qc.invalidateQueries({ queryKey: ['agents', id, 'action-plan'] });
    },
  });
}

// ── Quota ────────────────────────────────────────────────────────────────────

export interface QuotaSnapshot {
  runtimeUsedMs: number;
  runtimeBudgetMs: number;
  remainingMs: number;
  exhausted: boolean;
  resetsAt: string;
  status: string;
}

export function useMasterAgentQuota(id: string) {
  return useQuery({
    queryKey: ['agents', id, 'quota'],
    queryFn: () => apiGet<QuotaSnapshot>(`/master-agents/${id}/quota`),
    enabled: !!id,
    staleTime: 15000,
    refetchInterval: 30000,
  });
}

// ── Pipeline errors ──────────────────────────────────────────────────────────

export interface PipelineErrorRow {
  id: string;
  masterAgentId: string | null;
  step: string;
  tool: string;
  severity: 'error' | 'warning' | 'info';
  errorType: string;
  message: string;
  context: Record<string, unknown> | null;
  retryable: boolean;
  resolvedAt: string | null;
  createdAt: string;
}

export function useAgentErrors(id: string, unresolved = true) {
  return useQuery({
    queryKey: ['agents', id, 'errors', unresolved],
    queryFn: () => apiGet<PipelineErrorRow[]>(`/master-agents/${id}/errors?unresolved=${unresolved}`),
    enabled: !!id,
    staleTime: 10000,
    refetchInterval: 15000,
  });
}

export function useResolveError(masterAgentId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (errorId: string) =>
      apiPatch<PipelineErrorRow>(`/master-agents/${masterAgentId}/errors/${errorId}/resolve`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['agents', masterAgentId, 'errors'] }),
  });
}

// ── Search negotiation (LinkedIn Jobs thin-result quick replies) ─────────────

export interface SearchChoiceOutcome {
  choiceId: 'continue' | 'broaden_manual' | 'broaden_auto';
  appliedTerm: string | null;
  totalFound: number;
  locationCount: number;
  message: string;
}

export function useSearchChoice(masterAgentId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { choiceId: 'continue' | 'broaden_manual' | 'broaden_auto'; userTerm?: string }) =>
      apiPost<SearchChoiceOutcome>(`/master-agents/${masterAgentId}/search-choice`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['agents', masterAgentId] }),
  });
}
