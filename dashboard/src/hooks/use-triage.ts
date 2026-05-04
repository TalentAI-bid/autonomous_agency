'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiPost } from '@/lib/api';
import type { CompanyTriageVerdict } from '@/types';

export function useReTriageCompany() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (params: { companyId: string; force?: boolean }) => {
      return apiPost<{ verdict: CompanyTriageVerdict | null }>(
        `/triage/companies/${params.companyId}`,
        { force: params.force ?? true },
      );
    },
    onSuccess: () => {
      // Refresh anything that includes triage data.
      queryClient.invalidateQueries({ queryKey: ['companies'] });
      queryClient.invalidateQueries({ queryKey: ['agents'] });
    },
  });
}
