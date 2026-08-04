'use client';

import { useEffect } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { useAuthStore } from '@/stores/auth.store';
import { setAuthInterceptors } from '@/lib/api';
import { Sidebar } from '@/components/layout/sidebar';
import { Header } from '@/components/layout/header';
import { StatusBar } from '@/components/layout/status-bar';
import { OnboardingBanner } from '@/components/layout/onboarding-banner';
import { ActivityFab } from '@/components/copilot/activity-fab';
import { useWebSocket } from '@/hooks/use-websocket';
import { useSetupStatus } from '@/hooks/use-setup-status';

function DashboardContent({ children }: { children: React.ReactNode }) {
  useWebSocket();
  const pathname = usePathname();
  const { showOnboarding } = useSetupStatus();
  // On the first-run /dashboard onboarding page, drop the dense chrome so the
  // clean onboarding view renders full-bleed (it carries its own top strip).
  const onboardingFull = pathname === '/dashboard' && showOnboarding;

  return (
    <div className="app-shell">
      <Sidebar />
      <div className="main">
        {!onboardingFull && <Header />}
        {!onboardingFull && <OnboardingBanner />}
        <main style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>{children}</main>
        {!onboardingFull && <StatusBar />}
      </div>
      <ActivityFab />
    </div>
  );
}

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const token = useAuthStore((s) => s.token);
  const hasHydrated = useAuthStore((s) => s.hasHydrated);
  const logout = useAuthStore((s) => s.logout);
  const router = useRouter();

  useEffect(() => {
    setAuthInterceptors(() => {
      logout();
      router.replace('/login');
    });
  }, [logout, router]);

  useEffect(() => {
    if (!hasHydrated) return;
    if (!isAuthenticated || !token) router.replace('/login');
  }, [hasHydrated, isAuthenticated, token, router]);

  if (!hasHydrated) return null;
  if (!isAuthenticated || !token) return null;

  return <DashboardContent>{children}</DashboardContent>;
}
