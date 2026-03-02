'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  LayoutDashboard, Bot, Users, Building2, Megaphone,
  FileText, BarChart3, Settings, Zap, Kanban, Mail, Inbox, CalendarClock,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useRealtimeStore } from '@/stores/realtime.store';

const navItems = [
  { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/agents', label: 'Agents', icon: Bot },
  { href: '/campaigns', label: 'Campaigns', icon: Megaphone },
  { href: '/crm', label: 'CRM', icon: Kanban },
  { href: '/analytics', label: 'Analytics', icon: BarChart3 },
  { href: '/mailbox', label: 'Mailbox', icon: Inbox },
  { href: '/schedule', label: 'Schedule', icon: CalendarClock },
  { href: '/settings/email', label: 'Email', icon: Mail },
  { href: '/settings', label: 'Settings', icon: Settings },
];

const allDataItems = [
  { href: '/contacts', label: 'Contacts', icon: Users },
  { href: '/companies', label: 'Companies', icon: Building2 },
  { href: '/documents', label: 'Documents', icon: FileText },
];

export function Sidebar() {
  const pathname = usePathname();
  const connected = useRealtimeStore((s) => s.connected);

  return (
    <aside className="w-60 flex-shrink-0 flex flex-col h-screen bg-sidebar border-r border-sidebar-border">
      {/* Logo */}
      <div className="flex items-center gap-2.5 px-5 h-14 border-b border-sidebar-border">
        <div className="w-7 h-7 rounded-lg bg-primary flex items-center justify-center">
          <Zap className="w-4 h-4 text-white" />
        </div>
        <span className="font-semibold text-sm tracking-tight">AgentCore</span>
        <div className={cn(
          'ml-auto w-1.5 h-1.5 rounded-full',
          connected ? 'bg-emerald-400' : 'bg-zinc-600',
        )} title={connected ? 'Connected' : 'Disconnected'} />
      </div>

      {/* Nav */}
      <nav className="flex-1 py-4 px-2 overflow-y-auto">
        <div className="space-y-0.5">
          {navItems.map(({ href, label, icon: Icon }) => {
            const active = pathname === href || pathname.startsWith(href + '/');
            return (
              <Link
                key={href}
                href={href}
                className={cn(
                  'flex items-center gap-3 px-3 py-2 rounded-md text-sm transition-colors',
                  active
                    ? 'bg-zinc-800 text-foreground font-medium'
                    : 'text-sidebar-foreground hover:bg-sidebar-accent hover:text-foreground',
                )}
              >
                <Icon className="w-4 h-4 flex-shrink-0" />
                {label}
              </Link>
            );
          })}
        </div>

        {/* All Data section */}
        <div className="mt-6 pt-4 border-t border-sidebar-border">
          <p className="px-3 mb-2 text-xs font-medium text-muted-foreground uppercase tracking-wider">All Data</p>
          <div className="space-y-0.5">
            {allDataItems.map(({ href, label, icon: Icon }) => {
              const active = pathname === href || pathname.startsWith(href + '/');
              return (
                <Link
                  key={href}
                  href={href}
                  className={cn(
                    'flex items-center gap-3 px-3 py-2 rounded-md text-sm transition-colors',
                    active
                      ? 'bg-zinc-800 text-foreground font-medium'
                      : 'text-sidebar-foreground hover:bg-sidebar-accent hover:text-foreground',
                  )}
                >
                  <Icon className="w-4 h-4 flex-shrink-0" />
                  {label}
                </Link>
              );
            })}
          </div>
        </div>
      </nav>

      {/* Footer */}
      <div className="px-3 py-3 border-t border-sidebar-border">
        <p className="text-xs text-muted-foreground text-center">AgentCore v1.0</p>
      </div>
    </aside>
  );
}
