'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { cn } from '@/lib/utils';
import { useRealtimeStore } from '@/stores/realtime.store';
import { useAuthStore } from '@/stores/auth.store';
import { Icon, type IconName } from '@/components/ui/icon';
import { Dot } from '@/components/ui/dot';
import { useAgents } from '@/hooks/use-agents';
import { useContacts } from '@/hooks/use-contacts';
import { useCompanies } from '@/hooks/use-companies';
import { apiPost } from '@/lib/api';

type NavItem = { href: string; label: string; icon: IconName; count?: number };

function initials(source?: string | null) {
  if (!source) return 'U';
  return source
    .split(/\s+/)
    .map((p) => p.charAt(0))
    .join('')
    .slice(0, 2)
    .toUpperCase();
}

export function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const queryClient = useQueryClient();
  const connected = useRealtimeStore((s) => s.connected);
  const resetRealtime = useRealtimeStore((s) => s.clear);
  const { user, tenant } = useAuthStore();
  const logout = useAuthStore((s) => s.logout);
  const { data: agents } = useAgents();
  const { data: contacts } = useContacts();
  const { data: companies } = useCompanies();

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

  const workspace: NavItem[] = [
    { href: '/dashboard', label: 'Dashboard', icon: 'dash' },
    { href: '/agents', label: 'Agents', icon: 'bot', count: agents?.length },
    { href: '/agents/new', label: 'New Agent', icon: 'plus' },
  ];
  const data: NavItem[] = [
    { href: '/contacts', label: 'Leads', icon: 'users', count: contacts?.pagination.total },
    { href: '/companies', label: 'Companies', icon: 'build', count: companies?.pagination.total },
    { href: '/crm', label: 'Pipeline', icon: 'deal' },
    { href: '/analytics', label: 'Analytics', icon: 'chart' },
  ];
  const setup: NavItem[] = [
    { href: '/settings/company', label: 'Company Profile', icon: 'flag' },
    { href: '/settings/products', label: 'Products', icon: 'zap' },
    { href: '/settings/email', label: 'Email Accounts', icon: 'mail' },
    { href: '/linkedin-extension', label: 'LinkedIn Extension', icon: 'globe' },
  ];
  const tools: NavItem[] = [
    { href: '/mailbox', label: 'Inbox', icon: 'mail' },
    { href: '/schedule', label: 'Meetings', icon: 'calendar' },
    { href: '/settings', label: 'Settings', icon: 'cog' },
  ];

  const renderItem = ({ href, label, icon, count }: NavItem) => {
    const active = pathname === href || pathname.startsWith(href + '/');
    return (
      <Link key={href} href={href} className={cn('nav-item', active && 'is-active')}>
        <Icon name={icon} />
        <span>{label}</span>
        {count != null && <span className="count">{count.toLocaleString()}</span>}
      </Link>
    );
  };

  return (
    <div className="sidebar">
      <div className="sidebar-brand">
        <div className="brand-mark">T</div>
        <div style={{ minWidth: 0 }}>
          <div className="brand-name">
            TalentAI <span style={{ color: 'var(--ink-3)', fontWeight: 400 }}>Sales</span>
          </div>
        </div>
        <div className="brand-sub">v2.4</div>
      </div>

      <div className="nav">
        <div className="nav-section">Workspace</div>
        {workspace.map(renderItem)}
        <div className="nav-section">Data</div>
        {data.map(renderItem)}
        <div className="nav-section">Setup</div>
        {setup.map(renderItem)}
        <div className="nav-section">Tools</div>
        {tools.map(renderItem)}
      </div>

      <div className="sidebar-foot">
        <div className="avatar">{initials(user?.name ?? user?.email)}</div>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 12, fontWeight: 500 }}>{user?.name ?? user?.email ?? 'User'}</div>
          <div style={{ fontSize: 10.5, color: 'var(--ink-3)' }}>
            {tenant?.name ?? 'Workspace'} · {user?.role ?? 'Member'}
          </div>
        </div>
        <Dot state={connected ? 'live' : 'paused'} title={connected ? 'Connected' : 'Disconnected'} />
        <button
          type="button"
          onClick={handleLogout}
          className="nav-item"
          title="Sign out"
          style={{ padding: 6, minHeight: 0, width: 28, height: 28, justifyContent: 'center', flexShrink: 0 }}
          aria-label="Sign out"
        >
          <Icon name="signOut" size={14} />
        </button>
      </div>
    </div>
  );
}
