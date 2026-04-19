'use client';

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type { User, Tenant, Workspace } from '@/types';

interface AuthState {
  user: User | null;
  tenant: Tenant | null;
  token: string | null;
  tenantId: string | null;
  workspaces: Workspace[];
  isAuthenticated: boolean;

  login: (token: string, user: User, tenant: Tenant, workspaces?: Workspace[]) => void;
  logout: () => void;
  setToken: (token: string) => void;
  setWorkspaces: (workspaces: Workspace[]) => void;
  switchWorkspace: (token: string, tenant: Tenant, workspaces: Workspace[]) => void;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      user: null,
      tenant: null,
      token: null,
      tenantId: null,
      workspaces: [],
      isAuthenticated: false,

      login: (token, user, tenant, workspaces) =>
        set({
          token, user, tenant, tenantId: tenant.id, isAuthenticated: true,
          workspaces: workspaces ?? [{ id: tenant.id, name: tenant.name, slug: tenant.slug, role: user.role }],
        }),

      logout: () =>
        set({ token: null, user: null, tenant: null, tenantId: null, workspaces: [], isAuthenticated: false }),

      setToken: (token) => set({ token, isAuthenticated: true }),

      setWorkspaces: (workspaces) => set({ workspaces }),

      switchWorkspace: (token, tenant, workspaces) =>
        set({ token, tenant, tenantId: tenant.id, workspaces }),
    }),
    {
      name: 'agentcore-auth',
      storage: createJSONStorage(() =>
        typeof window !== 'undefined' ? sessionStorage : {
          getItem: () => null,
          setItem: () => {},
          removeItem: () => {},
        },
      ),
      partialize: (state) => ({
        token: state.token,
        user: state.user,
        tenant: state.tenant,
        tenantId: state.tenantId,
        workspaces: state.workspaces,
        isAuthenticated: state.isAuthenticated,
      }),
    },
  ),
);
