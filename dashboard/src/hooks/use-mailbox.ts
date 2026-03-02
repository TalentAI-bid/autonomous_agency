'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost, apiPatch } from '@/lib/api';
import type { MailboxEmail, MailboxStats, MailboxThread, MailboxThreadDetail, MailboxDigest } from '@/types';

interface MailboxListResponse {
  data: MailboxEmail[];
  nextCursor?: string;
  hasMore: boolean;
}

interface ThreadListResponse {
  data: MailboxThread[];
  nextCursor?: string;
  hasMore: boolean;
}

export function useMailboxSent(filters?: { limit?: number; cursor?: string; search?: string }) {
  return useQuery({
    queryKey: ['mailbox', 'sent', filters],
    queryFn: () => apiGet<MailboxListResponse>('/mailbox/sent', filters as Record<string, unknown>),
    staleTime: 15000,
  });
}

export function useMailboxInbox(filters?: { limit?: number; cursor?: string; search?: string; classification?: string }) {
  return useQuery({
    queryKey: ['mailbox', 'inbox', filters],
    queryFn: () => apiGet<MailboxListResponse>('/mailbox/inbox', filters as Record<string, unknown>),
    staleTime: 15000,
  });
}

export function useMailboxStats() {
  return useQuery({
    queryKey: ['mailbox', 'stats'],
    queryFn: () => apiGet<MailboxStats>('/mailbox/stats'),
    staleTime: 30000,
  });
}

export function useMailboxThreads(filters?: {
  limit?: number;
  cursor?: string;
  status?: string;
  priority?: string;
  contactId?: string;
  search?: string;
}) {
  return useQuery({
    queryKey: ['mailbox', 'threads', filters],
    queryFn: () => apiGet<ThreadListResponse>('/mailbox/threads', filters as Record<string, unknown>),
    staleTime: 15000,
  });
}

export function useMailboxThread(id: string | null) {
  return useQuery({
    queryKey: ['mailbox', 'thread', id],
    queryFn: () => apiGet<MailboxThreadDetail>(`/mailbox/threads/${id}`),
    enabled: !!id,
    staleTime: 10000,
  });
}

export function useMailboxDigest() {
  return useQuery({
    queryKey: ['mailbox', 'digest'],
    queryFn: () => apiGet<MailboxDigest>('/mailbox/digest'),
    staleTime: 30000,
  });
}

export function useSummarizeThread() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (threadId: string) =>
      apiPost<{ queued: boolean; threadId: string }>(`/mailbox/threads/${threadId}/summarize`),
    onSuccess: (_, threadId) => {
      queryClient.invalidateQueries({ queryKey: ['mailbox', 'thread', threadId] });
      queryClient.invalidateQueries({ queryKey: ['mailbox', 'threads'] });
    },
  });
}

export function useBulkAction() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (params: { action: string; threadIds: string[] }) =>
      apiPost<{ queued: boolean }>('/mailbox/bulk-action', params),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['mailbox', 'threads'] });
      queryClient.invalidateQueries({ queryKey: ['mailbox', 'digest'] });
    },
  });
}

export function useUpdateThread() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (params: { id: string; status?: string; priority?: string; nextAction?: string }) => {
      const { id, ...body } = params;
      return apiPatch<{ id: string }>(`/mailbox/threads/${id}`, body);
    },
    onSuccess: (_, params) => {
      queryClient.invalidateQueries({ queryKey: ['mailbox', 'thread', params.id] });
      queryClient.invalidateQueries({ queryKey: ['mailbox', 'threads'] });
    },
  });
}
