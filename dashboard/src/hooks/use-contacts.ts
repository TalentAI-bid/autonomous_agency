'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiGetPaginated, apiPatch, apiPost } from '@/lib/api';
import type { Contact, ContactFilters, PaginatedResponse } from '@/types';

export interface FindEmailResult {
  email: string | null;
  verified: boolean;
  method: string;
  attempts: number;
}

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

export function useCreateContact() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: {
      firstName?: string;
      lastName?: string;
      email?: string;
      linkedinUrl?: string;
      title?: string;
      companyId?: string;
      companyName?: string;
      location?: string;
      masterAgentId: string;  // required: contacts cannot be orphan (post-refactor)
    }) => apiPost<Contact>('/contacts', data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['contacts'] });
    },
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

export interface RescrapeContactResult {
  taskId: string;
  status: string;
}

/**
 * Tell the browser extension to re-scrape this contact's LinkedIn profile.
 * The result lands as a suggestion on the contact's rawData.linkedinRescrape
 * (the edit modal polls the contact and pre-fills from it). Throws if the
 * contact has no LinkedIn URL (400) or no extension is connected (409).
 */
export function useRescrapeContactLinkedin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiPost<RescrapeContactResult>(`/contacts/${id}/rescrape-linkedin`),
    onSuccess: (_, id) => {
      qc.invalidateQueries({ queryKey: ['contacts', id] });
    },
  });
}

export function useFindContactEmail() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiPost<FindEmailResult>(`/contacts/${id}/find-email`),
    onSuccess: (_, id) => {
      qc.invalidateQueries({ queryKey: ['contacts'] });
      qc.invalidateQueries({ queryKey: ['contacts', id] });
    },
  });
}

export type ManualEmailStatus = 'safe' | 'risky' | 'invalid' | 'catch_all' | 'unknown' | 'error' | 'daily_limit';

export interface SetContactEmailResult {
  contact: Contact;
  status: ManualEmailStatus;
}

export function useSetContactEmail() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, email }: { id: string; email: string }) =>
      apiPost<SetContactEmailResult>(`/contacts/${id}/email/manual`, { email }),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['contacts'] });
      qc.invalidateQueries({ queryKey: ['contacts', vars.id] });
    },
  });
}
