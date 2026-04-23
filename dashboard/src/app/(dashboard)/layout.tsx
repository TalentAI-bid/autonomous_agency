'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuthStore } from '@/stores/auth.store';
import { setAuthInterceptors, apiPost } from '@/lib/api';
import { Sidebar } from '@/components/layout/sidebar';
import { Header } from '@/components/layout/header';
import { StatusBar } from '@/components/layout/status-bar';
import { OnboardingBanner } from '@/components/layout/onboarding-banner';
import { useWebSocket } from '@/hooks/use-websocket';
import type { User, Tenant, Workspace } from '@/types';

function DashboardContent({ children }: { children: React.ReactNode }) {
  useWebSocket();
  return (
    <div className="app-shell">
      <Sidebar />
      <div className="main">
        <Header />
        <OnboardingBanner />
        <main style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>{children}</main>
        <StatusBar />
      </div>
    </div>
  );
}

type RefreshResponse = {
  token: string;
  user?: User;
  tenant?: Tenant;
  workspaces?: Workspace[];
};

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const token = useAuthStore((s) => s.token);
  const hasHydrated = useAuthStore((s) => s.hasHydrated);
  const logout = useAuthStore((s) => s.logout);
  const router = useRouter();
  const [bootstrapping, setBootstrapping] = useState(true);

  useEffect(() => {
    setAuthInterceptors(() => {
      logout();
      router.push('/login');
    });
  }, [logout, router]);

  useEffect(() => {
    if (!hasHydrated) return;

    // Already authenticated — nothing to bootstrap.
    if (isAuthenticated && token) {
      setBootstrapping(false);
      return;
    }

    // No access token in store. Try silent refresh via the httpOnly cookie
    // before bouncing to /login. This recovers sessions where localStorage
    // was cleared but the 7-day refresh cookie is still valid.
    let cancelled = false;
    (async () => {
      try {
        const res = await apiPost<RefreshResponse>('/auth/refresh');
        if (cancelled) return;
        if (res.user && res.tenant) {
          useAuthStore
            .getState()
            .login(res.token, res.user, res.tenant, res.workspaces);
        } else {
          useAuthStore.getState().setToken(res.token);
        }
      } catch {
        if (cancelled) return;
        router.replace('/login');
      } finally {
        if (!cancelled) setBootstrapping(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [hasHydrated, isAuthenticated, token, router]);

  if (!hasHydrated) return null;
  if (bootstrapping && !(isAuthenticated && token)) return null;
  if (!isAuthenticated || !token) return null;

  return <DashboardContent>{children}</DashboardContent>;
}
