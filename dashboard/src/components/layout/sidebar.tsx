'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { cn } from '@/lib/utils';
import { useRealtimeStore } from '@/stores/realtime.store';
import { useAuthStore } from '@/stores/auth.store';
import { Icon, type IconName } from '@/components/ui/icon';
import { useAgents } from '@/hooks/use-agents';
import { useSetupStatus } from '@/hooks/use-setup-status';
import { useGetStarted } from '@/hooks/use-get-started';
import { apiPost } from '@/lib/api';

type NavItem = { href: string; label: string; icon: IconName; count?: number; meta?: string };
type NavGroup = { title: string; items: NavItem[] };

function initials(source?: string | null) {
  if (!source) return 'U';
  return source
    .split(/[\s@]+/)
    .map((p) => p.charAt(0))
    .join('')
    .slice(0, 2)
    .toUpperCase();
}

function NavLink({ href, label, icon, count, meta, active }: NavItem & { active: boolean }) {
  return (
    <Link
      href={href}
      className={cn(
        'flex h-8 items-center gap-2.5 rounded-lg border px-2.5 text-body transition-colors',
        active
          ? 'border-accent-mid bg-accent-weak font-medium text-accent-fg'
          : 'border-transparent text-ink-2 hover:bg-bg-soft hover:text-ink',
      )}
    >
      <Icon name={icon} size={15} className={active ? 'text-accent' : 'text-ink-3'} />
      <span className="truncate">{label}</span>
      {meta && <span className="ml-auto font-mono text-2xs text-ink-3">{meta}</span>}
      {count != null && (
        <span className={cn('ml-auto font-mono text-2xs', active ? 'text-accent-fg' : 'text-ink-3')}>
          {count.toLocaleString()}
        </span>
      )}
    </Link>
  );
}

function ConnectionRow({ label, state }: { label: string; state: 'on' | 'off' | 'warn'; }) {
  const text = state === 'on' ? 'Connected' : state === 'warn' ? 'Off' : 'Not set up';
  return (
    <div className="flex items-center justify-between text-xs">
      <span className="text-ink-3">{label}</span>
      <span
        className={cn(
          'inline-flex items-center gap-1.5 font-medium',
          state === 'on' ? 'text-up' : state === 'warn' ? 'text-warn-fg' : 'text-ink-3',
        )}
      >
        <span className={cn('size-1.5 rounded-full', state === 'on' ? 'bg-up' : state === 'warn' ? 'bg-warn' : 'bg-ink-4')} />
        {text}
      </span>
    </div>
  );
}

export function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const queryClient = useQueryClient();
  const connected = useRealtimeStore((s) => s.connected);
  const resetRealtime = useRealtimeStore((s) => s.clear);
  const { user } = useAuthStore();
  const logout = useAuthStore((s) => s.logout);
  const { data: agents } = useAgents();
  const { steps } = useSetupStatus();
  const getStarted = useGetStarted();

  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [menuOpen]);

  async function handleLogout() {
    try {
      await apiPost('/auth/logout');
    } catch {
      // best-effort — the client-side state clear below is what matters
    }
    logout();
    queryClient.clear();
    resetRealtime();
    if (typeof window !== 'undefined') {
      localStorage.removeItem('agentcore-auth');
    }
    router.replace('/login');
  }

  const groups: NavGroup[] = [
    ...(!getStarted.isLoading && !getStarted.allDone
      ? [{ title: 'Start', items: [{ href: '/get-started', label: 'Get started', icon: 'check' as IconName, meta: `${getStarted.doneCount} of ${getStarted.total}` }] }]
      : []),
    {
      title: 'Work',
      items: [
        { href: '/dashboard', label: 'Home', icon: 'dash' },
        { href: '/queue', label: 'Daily Queue', icon: 'target' },
        { href: '/mailbox', label: 'Inbox', icon: 'mail' },
        { href: '/schedule', label: 'Meetings', icon: 'calendar' },
      ],
    },
    {
      title: 'Pipeline',
      items: [
        { href: '/prospects', label: 'Leads', icon: 'users' },
        { href: '/companies', label: 'Companies', icon: 'build' },
        { href: '/crm', label: 'Pipeline', icon: 'deal' },
        { href: '/analytics', label: 'Analytics', icon: 'chart' },
      ],
    },
    {
      title: 'Agents',
      items: [
        { href: '/agents', label: 'Agents', icon: 'bot', count: agents?.length },
        { href: '/studio', label: 'Studio', icon: 'zap' },
      ],
    },
    {
      title: 'Account',
      items: [
        { href: '/settings/company', label: 'Company Profile', icon: 'flag' },
        { href: '/settings/products', label: 'Products', icon: 'zap' },
        { href: '/settings/email', label: 'Email Accounts', icon: 'mail' },
        { href: '/settings/messaging', label: 'Messaging', icon: 'msg' },
        { href: '/linkedin-extension', label: 'LinkedIn Extension', icon: 'globe' },
        { href: '/settings', label: 'Settings', icon: 'cog' },
      ],
    },
  ];

  // A route is active when it is the path or a parent of it; the longest
  // matching href wins so /settings doesn't light up on /settings/email.
  const allHrefs = groups.flatMap((g) => g.items.map((i) => i.href));
  const activeHref = allHrefs
    .filter((h) => pathname === h || pathname.startsWith(h + '/'))
    .sort((a, b) => b.length - a.length)[0];

  return (
    <aside className="flex min-w-0 flex-col border-r border-line bg-bg-panel">
      <div className="flex h-[54px] items-center gap-2.5 px-4">
        <div className="grid size-7 place-items-center rounded-lg bg-accent text-[14px] font-semibold text-white">K</div>
        <div className="text-[14px] font-semibold tracking-[-0.01em] text-ink">Keenpipe</div>
      </div>

      <nav className="scroll-thin flex-1 overflow-y-auto px-2 pb-3">
        {groups.map((g) => (
          <div key={g.title} className="mb-1">
            <div className="px-2.5 pb-1.5 pt-3.5 text-2xs font-medium uppercase tracking-[0.09em] text-ink-4">{g.title}</div>
            <div className="flex flex-col gap-0.5">
              {g.items.map((item) => (
                <NavLink key={g.title + item.href} {...item} active={item.href === activeHref} />
              ))}
            </div>
          </div>
        ))}
      </nav>

      <div className="border-t border-line px-4 py-3">
        <div className="pb-2 text-2xs font-medium uppercase tracking-[0.09em] text-ink-4">Connections</div>
        <div className="flex flex-col gap-1.5">
          <ConnectionRow label="Sending" state={steps.mailbox ? 'on' : 'off'} />
          <ConnectionRow label="LinkedIn" state={steps.extension ? 'on' : 'warn'} />
          <ConnectionRow label="Realtime" state={connected ? 'on' : 'warn'} />
        </div>
      </div>

      <div ref={menuRef} className="relative border-t border-line p-2.5">
        {menuOpen && (
          <div className="absolute inset-x-2.5 bottom-full mb-1 rounded-lg border border-line bg-bg-panel p-1 shadow-lg">
            <button
              type="button"
              onClick={handleLogout}
              className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-body text-ink-2 hover:bg-bg-soft hover:text-ink"
            >
              <Icon name="signOut" size={14} />
              Sign out
            </button>
          </div>
        )}
        <button
          type="button"
          onClick={() => setMenuOpen((o) => !o)}
          className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left hover:bg-bg-soft"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
        >
          <span className="grid size-7 shrink-0 place-items-center rounded-full bg-accent-weak text-2xs font-semibold text-accent-fg">
            {initials(user?.name ?? user?.email)}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-body font-medium text-ink">{user?.name ?? user?.email ?? 'User'}</span>
            <span className="block truncate text-xs text-ink-3">{user?.email ?? ''}</span>
          </span>
          <Icon name="caret" size={14} className="shrink-0 text-ink-3" />
        </button>
      </div>
    </aside>
  );
}
