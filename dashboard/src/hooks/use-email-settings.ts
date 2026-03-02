'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost, apiPatch, apiDelete } from '@/lib/api';
import type { EmailAccount, EmailListenerConfig, QuotaStatus } from '@/types';

// ── Email Accounts ────────────────────────────────────────────────────────────

export function useEmailAccounts() {
  return useQuery({
    queryKey: ['email-accounts'],
    queryFn: () => apiGet<EmailAccount[]>('/email-accounts'),
    staleTime: 30000,
  });
}

export function useEmailAccount(id: string) {
  return useQuery({
    queryKey: ['email-accounts', id],
    queryFn: () => apiGet<EmailAccount>(`/email-accounts/${id}`),
    enabled: !!id,
  });
}

export function useCreateEmailAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: {
      name: string;
      provider?: string;
      smtpHost?: string;
      smtpPort?: number;
      smtpUser?: string;
      smtpPass?: string;
      fromEmail: string;
      fromName?: string;
      replyTo?: string;
      dailyQuota?: number;
      hourlyQuota?: number;
      isWarmup?: boolean;
      priority?: number;
    }) => apiPost<EmailAccount>('/email-accounts', data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['email-accounts'] }),
  });
}

export function useUpdateEmailAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...data }: { id: string } & Record<string, unknown>) =>
      apiPatch<EmailAccount>(`/email-accounts/${id}`, data),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['email-accounts'] });
      qc.invalidateQueries({ queryKey: ['email-accounts', vars.id] });
    },
  });
}

export function useDeleteEmailAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiDelete<{ success: boolean }>(`/email-accounts/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['email-accounts'] }),
  });
}

export function useTestEmailAccount() {
  return useMutation({
    mutationFn: ({ id, to }: { id: string; to: string }) =>
      apiPost<{ messageId: string }>(`/email-accounts/${id}/test-send`, { to }),
  });
}

export function useEmailAccountQuota(id: string) {
  return useQuery({
    queryKey: ['email-accounts', id, 'quota'],
    queryFn: () => apiGet<QuotaStatus>(`/email-accounts/${id}/quota-status`),
    enabled: !!id,
    staleTime: 10000,
  });
}

// ── Email Listeners ───────────────────────────────────────────────────────────

export function useEmailListeners() {
  return useQuery({
    queryKey: ['email-listeners'],
    queryFn: () => apiGet<EmailListenerConfig[]>('/email-listeners'),
    staleTime: 30000,
  });
}

export function useCreateEmailListener() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: {
      emailAccountId?: string;
      protocol?: string;
      host: string;
      port?: number;
      username: string;
      password: string;
      useTls?: boolean;
      mailbox?: string;
      pollingIntervalMs?: number;
    }) => apiPost<EmailListenerConfig>('/email-listeners', data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['email-listeners'] }),
  });
}

export function useUpdateEmailListener() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...data }: { id: string } & Record<string, unknown>) =>
      apiPatch<EmailListenerConfig>(`/email-listeners/${id}`, data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['email-listeners'] }),
  });
}

export function useDeleteEmailListener() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiDelete<{ success: boolean }>(`/email-listeners/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['email-listeners'] }),
  });
}

export function useTestListenerConnection() {
  return useMutation({
    mutationFn: (id: string) =>
      apiPost<{ success: boolean; error?: string }>(`/email-listeners/${id}/test-connection`),
  });
}

export function usePollNow() {
  return useMutation({
    mutationFn: (id: string) =>
      apiPost<{ jobId: string }>(`/email-listeners/${id}/poll-now`),
  });
}
