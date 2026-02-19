'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Bell, Plus, LogOut, User } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useAuthStore } from '@/stores/auth.store';
import { useRealtimeStore } from '@/stores/realtime.store';
import { Breadcrumb } from './breadcrumb';
import { apiPost } from '@/lib/api';

export function Header() {
  const router = useRouter();
  const { user, logout } = useAuthStore();
  const events = useRealtimeStore((s) => s.events);
  const unreadCount = events.filter((e) => {
    const ms = Date.now() - new Date(e.timestamp).getTime();
    return ms < 60000; // events in last 60s
  }).length;

  const handleLogout = async () => {
    try {
      await apiPost('/auth/logout');
    } catch { /* ignore */ }
    logout();
    router.push('/login');
  };

  return (
    <header className="h-14 border-b border-border flex items-center px-6 gap-4 bg-background/80 backdrop-blur-sm sticky top-0 z-40">
      <Breadcrumb />

      <div className="ml-auto flex items-center gap-2">
        {/* New Agent CTA */}
        <Button asChild size="sm" className="gap-1.5">
          <Link href="/agents/new">
            <Plus className="w-3.5 h-3.5" />
            New Agent
          </Link>
        </Button>

        {/* Notifications */}
        <Button variant="ghost" size="icon" className="relative">
          <Bell className="w-4 h-4" />
          {unreadCount > 0 && (
            <span className="absolute -top-0.5 -right-0.5 w-4 h-4 rounded-full bg-primary text-[10px] flex items-center justify-center text-white">
              {Math.min(unreadCount, 9)}
            </span>
          )}
        </Button>

        {/* User menu */}
        <div className="flex items-center gap-2 pl-2 border-l border-border">
          <div className="w-7 h-7 rounded-full bg-zinc-700 flex items-center justify-center">
            <User className="w-3.5 h-3.5 text-zinc-300" />
          </div>
          <span className="text-sm text-muted-foreground hidden sm:block">
            {user?.name ?? user?.email ?? 'User'}
          </span>
          <Button variant="ghost" size="icon" onClick={handleLogout} title="Logout">
            <LogOut className="w-4 h-4" />
          </Button>
        </div>
      </div>
    </header>
  );
}
