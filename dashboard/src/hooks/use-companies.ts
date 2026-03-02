'use client';

import { useQuery } from '@tanstack/react-query';
import { apiGet, apiGetPaginated } from '@/lib/api';
import type { Company, CompanyFilters, PaginatedResponse } from '@/types';

export function useCompanies(filters?: CompanyFilters) {
  return useQuery({
    queryKey: ['companies', filters],
    queryFn: () => apiGetPaginated<Company>('/companies', filters as Record<string, unknown>),
    staleTime: 15000,
  });
}

export function useCompany(id: string) {
  return useQuery({
    queryKey: ['companies', id],
    queryFn: () => apiGet<Company>(`/companies/${id}`),
    enabled: !!id,
  });
}
