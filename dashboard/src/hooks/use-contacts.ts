'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiGetPaginated, apiPatch } from '@/lib/api';
import type { Contact, ContactFilters, PaginatedResponse } from '@/types';

export function useContacts(filters?: ContactFilters) {
  return useQuery({
    queryKey: ['contacts', filters],
    queryFn: () => apiGetPaginated<Contact>('/contacts', filters as Record<string, unknown>),
    staleTime: 15000,
  });
}

export function useContact(id: string) {
  return useQuery({
    queryKey: ['contacts', id],
    queryFn: () => apiGet<Contact>(`/contacts/${id}`),
    enabled: !!id,
  });
}

export function useUpdateContact() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...data }: Partial<Contact> & { id: string }) =>
      apiPatch<Contact>(`/contacts/${id}`, data),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['contacts'] });
      qc.invalidateQueries({ queryKey: ['contacts', vars.id] });
    },
  });
}
