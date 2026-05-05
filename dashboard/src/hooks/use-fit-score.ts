'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiPost } from '@/lib/api';
import type { CompanyFitScoreVerdict } from '@/types';

export function useReScoreCompany() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (params: { companyId: string; force?: boolean }) => {
      return apiPost<{ verdict: CompanyFitScoreVerdict | null }>(
        `/fit-score/companies/${params.companyId}`,
        { force: params.force ?? true },
      );
    },
    onSuccess: () => {
      // Refresh anything that includes fit-score data.
      queryClient.invalidateQueries({ queryKey: ['companies'] });
      queryClient.invalidateQueries({ queryKey: ['agents'] });
    },
  });
}
