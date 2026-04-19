'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPut } from '@/lib/api';
import type { CompanyProfile } from '@/types';

export function useCompanyProfile() {
  return useQuery({
    queryKey: ['company-profile'],
    queryFn: () => apiGet<Partial<CompanyProfile>>('/tenants/company-profile'),
    staleTime: 30000,
  });
}

export function useUpdateCompanyProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: CompanyProfile) =>
      apiPut<CompanyProfile>('/tenants/company-profile', data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['company-profile'] }),
  });
}
