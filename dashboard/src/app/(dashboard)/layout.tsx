'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuthStore } from '@/stores/auth.store';
import { setAuthInterceptors } from '@/lib/api';
import { Sidebar } from '@/components/layout/sidebar';
import { Header } from '@/components/layout/header';
import { StatusBar } from '@/components/layout/status-bar';
import { useWebSocket } from '@/hooks/use-websocket';

function DashboardContent({ children }: { children: React.ReactNode }) {
  useWebSocket();
  return (
    <div className="app-shell">
      <Sidebar />
      <div className="main">
        <Header />
        <main style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>{children}</main>
        <StatusBar />
      </div>
    </div>
  );
}

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, token, logout } = useAuthStore();
  const router = useRouter();

  useEffect(() => {
    setAuthInterceptors(
      () => useAuthStore.getState().token,
      () => {
        logout();
        router.push('/login');
      },
    );
  }, [logout, router]);

  useEffect(() => {
    if (!isAuthenticated) {
      router.replace('/login');
    }
  }, [isAuthenticated, router]);

  if (!isAuthenticated || !token) {
    return null;
  }

  return <DashboardContent>{children}</DashboardContent>;
}
