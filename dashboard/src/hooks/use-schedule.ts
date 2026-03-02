'use client';

import { useQuery } from '@tanstack/react-query';
import { apiGet } from '@/lib/api';
import type { ScheduledAction } from '@/types';

export function useUpcomingActions(filters?: { limit?: number; filter?: 'all' | 'emails' | 'tasks' }) {
  return useQuery({
    queryKey: ['schedule', 'upcoming', filters],
    queryFn: () => apiGet<ScheduledAction[]>('/schedule/upcoming', filters as Record<string, unknown>),
    staleTime: 15000,
  });
}
