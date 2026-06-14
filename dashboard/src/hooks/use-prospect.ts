'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  listProspects,
  getProspect,
  getProspectTimeline,
  addProspectNote,
  markProspectDnc,
  updateProspectTags,
  reassignProspect,
  type ProspectListFilters,
} from '@/lib/api/prospects';

export function useProspects(filters: ProspectListFilters = {}) {
  return useQuery({
    queryKey: ['prospects', filters],
    queryFn: () => listProspects(filters),
    staleTime: 10_000,
  });
}

export function useProspect(id: string | undefined) {
  return useQuery({
    queryKey: ['prospect', id],
    queryFn: () => getProspect(id!),
    enabled: !!id,
  });
}

export function useProspectTimeline(
  id: string | undefined,
  opts: { cursor?: string; limit?: number; category?: string } = {},
) {
  return useQuery({
    queryKey: ['prospect-timeline', id, opts],
    queryFn: () => getProspectTimeline(id!, opts),
    enabled: !!id,
    staleTime: 5_000,
  });
}

export function useAddProspectNote(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: string) => addProspectNote(id, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['prospect', id] });
      qc.invalidateQueries({ queryKey: ['prospect-timeline', id] });
    },
  });
}

export function useMarkProspectDnc(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (reason?: string) => markProspectDnc(id, reason),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['prospect', id] });
      qc.invalidateQueries({ queryKey: ['prospect-timeline', id] });
      qc.invalidateQueries({ queryKey: ['prospects'] });
    },
  });
}

export function useUpdateProspectTags(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ add, remove }: { add?: string[]; remove?: string[] }) =>
      updateProspectTags(id, add, remove),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['prospect', id] });
      qc.invalidateQueries({ queryKey: ['prospect-timeline', id] });
    },
  });
}

export function useReassignProspect(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (userId: string) => reassignProspect(id, userId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['prospect', id] });
      qc.invalidateQueries({ queryKey: ['prospect-timeline', id] });
    },
  });
}
