'use client';

import { useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { AxiosError } from 'axios';
import {
  getQueue,
  refreshQueue,
  executeAction,
  completeAction,
  skipAction,
  editDraft,
  retargetAction,
} from '@/lib/api/queue';
import { useRealtimeStore } from '@/stores/realtime.store';
import { useToast } from '@/hooks/use-toast';
import { wsManager } from '@/lib/websocket';

const POLL_WINDOW_MS = 120_000;
const POLL_INTERVAL_MS = 4_000;

function formatLocalTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString(undefined, {
      hour: 'numeric',
      minute: '2-digit',
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return iso;
  }
}

export function useQueue(masterAgentId?: string) {
  const qc = useQueryClient();
  const lastManualRefreshAt = useRealtimeStore((s) => s.lastManualRefreshAt);
  const clearManualRefresh = useRealtimeStore((s) => s.clearManualRefresh);

  // When the worker emits queue:ready over WS, invalidate all queue caches
  // (both the tenant-wide view and any per-agent slices) at once.
  useEffect(() => {
    const handler = () => {
      qc.invalidateQueries({ queryKey: ['queue'] });
      clearManualRefresh();
    };
    wsManager.subscribe('queue:ready', handler);
    return () => wsManager.unsubscribe('queue:ready', handler);
  }, [qc, clearManualRefresh]);

  // Safety-net polling. After a manual /queue/refresh click we poll every
  // 4s for up to 2 minutes so the queue updates even if the WS publish is
  // missed (e.g. socket reconnect between click and queue:ready).
  const pollOpen = lastManualRefreshAt != null && Date.now() - lastManualRefreshAt < POLL_WINDOW_MS;

  const query = useQuery({
    queryKey: ['queue', masterAgentId ?? null],
    queryFn: () => getQueue({ masterAgentId }),
    refetchOnWindowFocus: true,
    staleTime: 5_000,
    refetchInterval: pollOpen ? POLL_INTERVAL_MS : false,
  });

  // Stop polling promptly the moment actions appear after a manual refresh.
  useEffect(() => {
    if (pollOpen && (query.data?.count ?? 0) > 0) {
      clearManualRefresh();
    }
  }, [pollOpen, query.data?.count, clearManualRefresh]);

  // Hard-stop polling once the window elapses.
  useEffect(() => {
    if (!lastManualRefreshAt) return;
    const remaining = POLL_WINDOW_MS - (Date.now() - lastManualRefreshAt);
    if (remaining <= 0) {
      clearManualRefresh();
      return;
    }
    const t = setTimeout(() => clearManualRefresh(), remaining);
    return () => clearTimeout(t);
  }, [lastManualRefreshAt, clearManualRefresh]);

  return query;
}

export function useRefreshQueue() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const markManualRefresh = useRealtimeStore((s) => s.markManualRefresh);
  return useMutation({
    mutationFn: refreshQueue,
    onSuccess: (data) => {
      toast({
        title: 'Refreshing queue…',
        description: `${data.remaining}/${data.limit} manual refreshes remaining today.`,
      });
      // Open the safety-net polling window. useQueue will poll every 4s
      // until queue:ready arrives or 2 minutes elapse.
      markManualRefresh();
      // Also invalidate once after a short delay in case the worker is
      // sync-fast (rare; mostly the polling above covers this).
      setTimeout(() => qc.invalidateQueries({ queryKey: ['queue'] }), 1000);
    },
    onError: (err: unknown) => {
      if (err instanceof AxiosError && err.response?.status === 429) {
        const body = err.response.data as { resetAt?: string; limit?: number };
        toast({
          title: 'Daily refresh limit reached',
          description: `You've used all ${body.limit ?? 3} manual refreshes for today. Next reset at ${body.resetAt ? formatLocalTime(body.resetAt) : 'tomorrow'}. The 06:00 UTC run still happens automatically.`,
          variant: 'destructive',
        });
        // Sync the cached quota so the button disables without waiting for refetch.
        qc.setQueryData(['queue'], (prev: unknown) => {
          if (!prev || typeof prev !== 'object') return prev;
          const p = prev as { refreshQuota?: unknown };
          return { ...p, refreshQuota: { remaining: 0, limit: body.limit ?? 3, resetAt: body.resetAt ?? '' } };
        });
        return;
      }
      toast({
        title: 'Could not refresh queue',
        description: err instanceof Error ? err.message : 'Try again in a moment.',
        variant: 'destructive',
      });
    },
  });
}

export function useExecuteAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: executeAction,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['queue'] });
    },
  });
}

export function useCompleteAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body?: { sentAt?: string; notes?: string; channelData?: Record<string, unknown> } }) =>
      completeAction(id, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['queue'] });
    },
  });
}

export function useSkipAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, reason, notes }: { id: string; reason: string; notes?: string }) =>
      skipAction(id, reason, notes),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['queue'] });
    },
  });
}

export function useEditDraft() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body, subject }: { id: string; body: string; subject?: string }) =>
      editDraft(id, body, subject),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['queue'] });
    },
  });
}

export function useRetargetAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, contactId }: { id: string; contactId: string }) =>
      retargetAction(id, contactId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['queue'] });
    },
  });
}
