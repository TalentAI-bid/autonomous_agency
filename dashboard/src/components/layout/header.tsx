'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Icon } from '@/components/ui/icon';
import { Button } from '@/components/ui/button';
import { WorkspaceSwitcher } from './workspace-switcher';
import { numberWord, useGetStarted } from '@/hooks/use-get-started';
import { useAgents } from '@/hooks/use-agents';
import { useQueue } from '@/hooks/use-queue';
import { AgentsSubtitle } from '@/components/agents/agents-subtitle';
import { MailboxSubtitle } from '@/components/mailbox/inbox-empty';
import { settingsSectionFor } from '@/components/settings/settings-nav';

// Title + one-line subtitle for the top bar, matched on the longest route prefix.
const TITLES: Array<[string, { title: string; sub: string }]> = [
  ['/get-started', { title: 'Get started', sub: '' }],
  ['/dashboard', { title: 'Home', sub: 'What needs you today.' }],
  ['/approvals', { title: 'Approvals', sub: 'What your agents drafted for you to approve.' }],
  ['/mailbox', { title: 'Inbox', sub: 'Replies and conversations.' }],
  ['/schedule', { title: 'Schedule', sub: 'Queued emails and running agent tasks.' }],
  ['/prospects', { title: 'Leads', sub: 'People your agents have found.' }],
  ['/companies', { title: 'Companies', sub: 'Accounts your agents are working.' }],
  ['/crm', { title: 'Pipeline', sub: 'Deals by stage.' }],
  ['/analytics', { title: 'Analytics', sub: 'How outreach is performing.' }],
  ['/agents/new', { title: 'New agent', sub: 'Describe who to reach and let it run.' }],
  ['/agents', { title: 'Agents', sub: 'Your outbound agents.' }],
  ['/studio', { title: 'Studio', sub: 'Shape messaging and strategy.' }],
  ['/documents', { title: 'Documents', sub: 'Files your agents can use.' }],
  ['/campaigns', { title: 'Campaigns', sub: 'Outreach campaigns.' }],
  ['/settings', { title: 'Settings', sub: 'Workspace, mailboxes and team.' }],
];

function titleFor(pathname: string) {
  const hit = TITLES.filter(([p]) => pathname === p || pathname.startsWith(p + '/')).sort(
    (a, b) => b[0].length - a[0].length,
  )[0];
  return hit?.[1] ?? { title: 'Keenpipe', sub: '' };
}

export function Header() {
  const pathname = usePathname();
  const gs = useGetStarted();
  // Approvals only exist once an agent has run, so hide the shortcut until then.
  const { data: agents } = useAgents();
  const hasAgent = (agents?.length ?? 0) > 0;
  const queue = useQueue();
  const found = titleFor(pathname);
  const title = found.title;
  const handled = queue.data?.handledToday;
  const onAgentsList = pathname === '/agents';
  const sub: React.ReactNode = onAgentsList
    ? <AgentsSubtitle />
    : pathname.startsWith('/mailbox')
    ? <MailboxSubtitle />
    : pathname.startsWith('/settings')
    ? settingsSectionFor(pathname) || found.sub
    : pathname.startsWith('/get-started') && !gs.isLoading
      ? `${numberWord(gs.doneCount).replace(/^./, (c) => c.toUpperCase())} of ${numberWord(gs.total)} done · this page disappears when all ${numberWord(gs.total)} are`
      : pathname.startsWith('/approvals') && agents && !hasAgent
        ? 'Nothing to approve yet'
        : pathname.startsWith('/approvals') && queue.data
        ?`${queue.data.count} waiting${handled ? ` · ${handled.approved} approved, ${handled.skipped} skipped today` : ''}`
        : found.sub;

  return (
    <header className="flex h-[54px] shrink-0 items-center gap-4 border-b border-line bg-bg-panel px-5">
      <div className="min-w-0">
        <div className="truncate text-title font-semibold leading-tight text-ink">{title}</div>
        {sub && <div className="truncate text-xs text-ink-3">{sub}</div>}
      </div>

      <div className="ml-auto flex items-center gap-2.5">
        <WorkspaceSwitcher />
        <div
          role="search"
          className="flex h-8 w-[190px] items-center gap-2 rounded-lg border border-line bg-bg-panel px-2.5 text-body text-ink-3"
        >
          <Icon name="search" size={13} />
          <span>Search</span>
          <kbd className="ml-auto rounded-tag border border-line bg-bg-soft px-1.5 font-mono text-2xs text-ink-3">⌘K</kbd>
        </div>
        {onAgentsList ? (
          <Button size="sm" asChild variant="brand">
            <Link href="/agents/new">New agent</Link>
          </Button>
        ) : hasAgent && (
          <Button size="sm" asChild variant="brand">
            <Link href="/approvals">Open approvals</Link>
          </Button>
        )}
      </div>
    </header>
  );
}
