'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost } from '@/lib/api';
import { useAuthStore } from '@/stores/auth.store';
import type { Workspace, Tenant } from '@/types';

export function useWorkspaces() {
  return useQuery({
    queryKey: ['workspaces'],
    queryFn: () => apiGet<Workspace[]>('/workspaces'),
    staleTime: 60000,
  });
}

export function useCreateWorkspace() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { name: string; slug?: string; productType?: string }) =>
      apiPost<Workspace>('/workspaces', data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['workspaces'] }),
  });
}

export function useSwitchWorkspace() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (tenantId: string) =>
      apiPost<{ token: string; tenant: Tenant; workspaces: Workspace[] }>('/workspaces/switch', { tenantId }),
    onSuccess: (data) => {
      const { switchWorkspace } = useAuthStore.getState();
      switchWorkspace(data.token, data.tenant, data.workspaces);
      // Clear all cached queries so data reloads for the new workspace
      qc.clear();
    },
  });
}
