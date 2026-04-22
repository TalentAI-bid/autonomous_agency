'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuthStore } from '@/stores/auth.store';
import { useRealtimeStore } from '@/stores/realtime.store';
import { useDashboardAnalytics } from '@/hooks/use-analytics';
import { useAgents } from '@/hooks/use-agents';
import { Icon } from '@/components/ui/icon';
import { Dot } from '@/components/ui/dot';
import { WorkspaceSwitcher } from './workspace-switcher';
import { apiPost } from '@/lib/api';

function fmtMoney(n?: number | null) {
  if (n == null) return '—';
  if (n >= 1e6) return '$' + (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return '$' + (n / 1e3).toFixed(n >= 10000 ? 0 : 1) + 'K';
  return '$' + n;
}

export function Header() {
  const router = useRouter();
  const { logout } = useAuthStore();
  const connected = useRealtimeStore((s) => s.connected);
  const events = useRealtimeStore((s) => s.events);
  const { data: analytics } = useDashboardAnalytics();
  const { data: agents } = useAgents();

  const unread = events.filter((e) => Date.now() - new Date(e.timestamp).getTime() < 60000).length;
  const runningAgents = agents?.filter((a) => a.status === 'running').length ?? 0;
  const totalAgents = agents?.length ?? 0;
  const leadsToday = analytics?.contacts.total ?? 0;
  const sent = analytics?.emails.sent ?? 0;
  const replied = analytics?.emails.replied ?? 0;
  const replyRate = sent > 0 ? ((replied / sent) * 100).toFixed(1) + '%' : '—';

  const handleLogout = async () => {
    try {
      await apiPost('/auth/logout');
    } catch {
      /* ignore */
    }
    logout();
    router.push('/login');
  };

  return (
    <div className="topbar">
      <div className="topbar-cell">
        <Dot state={connected ? 'live' : 'paused'} />
        <span className="label">System</span>
        <span className="val">{connected ? 'LIVE' : 'PAUSED'}</span>
      </div>
      <div className="topbar-cell">
        <span className="label">Agents</span>
        <span className="val">
          {runningAgents}/{totalAgents}
        </span>
        <span className="delta" style={{ color: 'var(--up)' }}>
          active
        </span>
      </div>
      <div className="topbar-cell">
        <span className="label">Leads</span>
        <span className="val">{leadsToday.toLocaleString()}</span>
      </div>
      <div className="topbar-cell">
        <span className="label">Reply rate</span>
        <span className="val">{replyRate}</span>
      </div>
      <div className="topbar-cell">
        <span className="label">Interviews</span>
        <span className="val">{analytics?.interviews.scheduled ?? 0}</span>
      </div>

      <div className="searchbar" role="search">
        <Icon name="search" size={13} />
        <span>Jump to agent, lead, company… or type a command</span>
        <span style={{ marginLeft: 'auto' }}>
          <kbd>⌘K</kbd>
        </span>
      </div>

      <div className="topbar-right">
        <WorkspaceSwitcher />
        <Link href="/agents/new" className="btn is-primary is-sm" style={{ gap: 6 }}>
          <Icon name="plus" size={12} /> New agent
        </Link>
        <button className="topbar-cell" type="button" aria-label="Notifications">
          <Icon name="bell" size={13} />
          {unread > 0 && <span style={{ fontSize: 11 }}>{Math.min(unread, 9)}</span>}
        </button>
        <button
          className="topbar-cell"
          type="button"
          style={{ color: 'var(--ink-2)' }}
          onClick={handleLogout}
          title="Logout"
          aria-label="Logout"
        >
          <Icon name="cog" size={13} />
        </button>
      </div>
    </div>
  );
}
