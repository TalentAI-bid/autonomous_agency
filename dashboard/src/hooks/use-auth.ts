'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuthStore } from '@/stores/auth.store';
import { setAuthInterceptors } from '@/lib/api';

export function useAuth() {
  const { user, token, isAuthenticated, login, logout, setToken } = useAuthStore();
  return { user, token, isAuthenticated, login, logout, setToken };
}

export function useInitAuth() {
  const { token, logout } = useAuthStore();
  const router = useRouter();

  useEffect(() => {
    setAuthInterceptors(() => {
      logout();
      router.push('/login');
    });
  }, [logout, router]);

  return { token };
}

export function useRequireAuth() {
  const { isAuthenticated } = useAuthStore();
  const router = useRouter();

  useEffect(() => {
    if (!isAuthenticated) {
      router.replace('/login');
    }
  }, [isAuthenticated, router]);

  return { isAuthenticated };
}
