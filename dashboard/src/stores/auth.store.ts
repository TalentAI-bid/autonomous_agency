'use client';

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type { User, Tenant } from '@/types';

interface AuthState {
  user: User | null;
  tenant: Tenant | null;
  token: string | null;
  tenantId: string | null;
  isAuthenticated: boolean;

  login: (token: string, user: User, tenant: Tenant) => void;
  logout: () => void;
  setToken: (token: string) => void;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      user: null,
      tenant: null,
      token: null,
      tenantId: null,
      isAuthenticated: false,

      login: (token, user, tenant) =>
        set({ token, user, tenant, tenantId: tenant.id, isAuthenticated: true }),

      logout: () =>
        set({ token: null, user: null, tenant: null, tenantId: null, isAuthenticated: false }),

      setToken: (token) => set({ token, isAuthenticated: true }),
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
        isAuthenticated: state.isAuthenticated,
      }),
    },
  ),
);
