'use client';

import { useState } from 'react';
import { Card } from '@/components/ui/card';
import { Badge, type BadgeProps } from '@/components/ui/badge';
import { useMailboxSent, useMailboxInbox, useMailboxStats, useMailboxThreads, useMailboxDigest, useBulkAction } from '@/hooks/use-mailbox';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { EmailDetailDialog } from '@/components/mailbox/email-detail-dialog';
import { ThreadDetailDialog } from '@/components/mailbox/thread-detail-dialog';
import { InboxEmptyState, useInboxIsEmpty } from '@/components/mailbox/inbox-empty';
import { StatCard } from '@/components/home/home-parts';
import { formatDate, formatRelative, formatNumber, cn } from '@/lib/utils';
import { Mail, Inbox, Send, Search, MessageSquare, Archive, Ban, ExternalLink } from 'lucide-react';
import Link from 'next/link';
import type { MailboxEmail, MailboxThread } from '@/types';

function Tag({ tone, children, title }: { tone?: BadgeProps['variant']; children: React.ReactNode; title?: string }) {
  return (
    <Badge variant={tone ?? 'muted'} className="capitalize" title={title}>
      {children}
    </Badge>
  );
}

const CLASSIFICATION_TONE: Record<string, BadgeProps['variant']> = {
  interested: 'up',
  inquiry: 'info',
  application: 'info',
  partnership: 'accent',
  introduction: 'accent',
  objection: 'warn',
  not_now: 'warn',
  out_of_office: 'muted',
  unsubscribe: 'down',
  bounce: 'down',
  spam: 'down',
  support_request: 'warn',
};

const SENT_TONE: Record<string, BadgeProps['variant']> = {
  sent: 'up',
  queued: 'info',
  sending: 'warn',
  failed: 'down',
  cancelled: 'muted',
};

const PRIORITY_TONE: Record<string, BadgeProps['variant']> = {
  high: 'down',
  medium: 'warn',
  low: 'muted',
};

const THREAD_TONE: Record<string, BadgeProps['variant']> = {
  active: 'up',
  needs_action: 'down',
  waiting: 'info',
  archived: 'muted',
};

const TABS = [
  { key: 'threads', label: 'Threads', icon: MessageSquare },
  { key: 'inbox', label: 'Inbox', icon: Inbox },
  { key: 'sent', label: 'Sent', icon: Send },
] as const;

export default function MailboxPage() {
  const [tab, setTab] = useState<'inbox' | 'sent' | 'threads'>('threads');
  const [search, setSearch] = useState('');
  const [threadStatusFilter, setThreadStatusFilter] = useState<string>('');
  const [selectedEmail, setSelectedEmail] = useState<MailboxEmail | null>(null);
  const [selectedThread, setSelectedThread] = useState<MailboxThread | null>(null);
  const [selectedThreadIds, setSelectedThreadIds] = useState<Set<string>>(new Set());

  const { data: stats } = useMailboxStats();
  const { data: digest } = useMailboxDigest();
  const { data: sentData, isLoading: sentLoading } = useMailboxSent({ search: search || undefined });
  const { data: inboxData, isLoading: inboxLoading } = useMailboxInbox({ search: search || undefined });
  const { data: threadData, isLoading: threadsLoading } = useMailboxThreads({
    search: search || undefined,
    status: threadStatusFilter || undefined,
  });
  const bulkAction = useBulkAction();
  const inbox = useInboxIsEmpty();

  const sentEmails = sentData?.data ?? [];
  const inboxEmails = inboxData?.data ?? [];
  const threads = threadData?.data ?? [];

  const isLoading = tab === 'sent' ? sentLoading : tab === 'inbox' ? inboxLoading : threadsLoading;
  const emails = tab === 'sent' ? sentEmails : inboxEmails;

  const toggleThreadSelection = (id: string) => {
    setSelectedThreadIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAllThreads = () => {
    if (selectedThreadIds.size === threads.length) {
      setSelectedThreadIds(new Set());
    } else {
      setSelectedThreadIds(new Set(threads.map((t) => t.id)));
    }
  };

  const handleBulkAction = (action: string) => {
    if (selectedThreadIds.size === 0) return;
    bulkAction.mutate({ action, threadIds: Array.from(selectedThreadIds) });
    setSelectedThreadIds(new Set());
  };

  // Wait for the counts that decide between the empty state and the full page.
  // Without this the full page flashes for a moment, then is replaced by the empty state.
  if (inbox.loading) {
    return (
      <div className="mx-auto flex max-w-[1100px] flex-col gap-4 p-5">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-[88px] rounded-xl" />
          ))}
        </div>
        <Skeleton className="h-10 w-72 rounded-lg" />
        <Skeleton className="h-72 rounded-2xl" />
      </div>
    );
  }

  // Never received a reply: show the explanatory empty state instead of an empty table.
  if (inbox.empty && !search && !threadStatusFilter) return <InboxEmptyState sent={inbox.sent} />;

  const needsAction = digest?.needsAction ?? 0;

  return (
    <div className="mx-auto flex max-w-[1100px] flex-col gap-4 p-5">
      {/* Stats */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        <StatCard label="Received today" value={formatNumber(stats?.todayReceived ?? 0)} detail="Replies and new mail" muted={(stats?.todayReceived ?? 0) === 0} />
        <StatCard label="Sent today" value={formatNumber(stats?.todaySent ?? 0)} detail="From your mailbox" muted={(stats?.todaySent ?? 0) === 0} />
        <StatCard label="Threads" value={formatNumber(digest?.totalThreads ?? 0)} detail="Conversations in total" />
        <StatCard label="Needs action" value={formatNumber(needsAction)} detail={needsAction > 0 ? 'Waiting on your answer' : 'All caught up'} muted={needsAction === 0} />
        <StatCard label="High priority" value={formatNumber(digest?.highPriority ?? 0)} detail="Look at these first" muted={(digest?.highPriority ?? 0) === 0} />
      </div>

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2.5">
        <div className="flex items-center gap-0.5 rounded-lg border border-line bg-bg-soft p-0.5" role="tablist" aria-label="Mailbox view">
          {TABS.map(({ key, label, icon: Icon }) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={tab === key}
              onClick={() => setTab(key)}
              className={cn(
                'inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-body font-medium transition-colors',
                tab === key ? 'bg-bg-panel text-ink shadow-sm' : 'text-ink-3 hover:text-ink',
              )}
            >
              <Icon size={14} />
              {label}
            </button>
          ))}
        </div>

        <label className="flex h-9 min-w-[200px] flex-1 cursor-text items-center gap-2 rounded-lg border border-line bg-bg-panel px-3 text-body text-ink-3 transition-colors focus-within:border-accent-mid focus-within:ring-2 focus-within:ring-accent-weak hover:border-line-strong sm:max-w-xs">
          <Search size={14} className="shrink-0" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={tab === 'threads' ? 'Search threads…' : 'Search emails…'}
            className="min-w-0 flex-1 border-0 bg-transparent text-body text-ink outline-none placeholder:text-ink-4"
          />
        </label>

        {tab === 'threads' && (
          <div className="flex flex-wrap gap-1.5">
            {['', 'active', 'needs_action', 'waiting', 'archived'].map((s) => (
              <button
                key={s}
                type="button"
                aria-pressed={threadStatusFilter === s}
                onClick={() => setThreadStatusFilter(s)}
                className={cn(
                  'h-8 rounded-full border px-3 text-xs font-medium capitalize transition-colors',
                  threadStatusFilter === s
                    ? 'border-accent-mid bg-accent-weak text-accent-fg'
                    : 'border-line bg-bg-panel text-ink-2 hover:border-line-strong hover:bg-hover',
                )}
              >
                {s ? s.replace(/_/g, ' ') : 'All'}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Bulk actions */}
      {tab === 'threads' && selectedThreadIds.size > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-accent-mid bg-accent-weak px-4 py-2.5">
          <span className="mr-1 text-body font-medium text-accent-fg">{selectedThreadIds.size} selected</span>
          <Button size="sm" type="button" variant="panel" onClick={() => handleBulkAction('archive')} disabled={bulkAction.isPending}>
            <Archive className="mr-1.5 size-3.5" /> Archive
          </Button>
          <Button size="sm" type="button" variant="panel" onClick={() => handleBulkAction('mark_spam')} disabled={bulkAction.isPending}>
            <Ban className="mr-1.5 size-3.5" /> Mark spam
          </Button>
          <Button size="sm" type="button" variant="panel" onClick={() => handleBulkAction('unsubscribe')} disabled={bulkAction.isPending}>
            Unsubscribe
          </Button>
          <button type="button" onClick={() => setSelectedThreadIds(new Set())} className="ml-auto text-xs font-medium text-accent-fg hover:underline">
            Clear
          </button>
        </div>
      )}

      {/* Content */}
      <Card as="section" className="overflow-hidden">
        {isLoading ? (
          <div className="space-y-2 p-5">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-12 rounded-lg" />
            ))}
          </div>
        ) : tab === 'threads' ? (
          threads.length === 0 ? (
            <div className="px-5 py-14 text-center">
              <span className="mx-auto grid size-10 place-items-center rounded-full bg-accent-weak text-accent">
                <MessageSquare size={18} />
              </span>
              <p className="mb-0 mt-3 text-body font-semibold text-ink">No threads found</p>
              <p className="mx-auto mb-0 mt-1 max-w-sm text-xs text-ink-3">Try a different search or status filter.</p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10">
                    <Checkbox checked={selectedThreadIds.size === threads.length && threads.length > 0} onCheckedChange={toggleAllThreads} />
                  </TableHead>
                  <TableHead>Contact</TableHead>
                  <TableHead>Subject</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Priority</TableHead>
                  <TableHead>Deal</TableHead>
                  <TableHead className="text-right">Msgs</TableHead>
                  <TableHead>Last activity</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {threads.map((thread) => (
                  <TableRow key={thread.id} className="cursor-pointer">
                    <TableCell onClick={(e) => e.stopPropagation()}>
                      <Checkbox checked={selectedThreadIds.has(thread.id)} onCheckedChange={() => toggleThreadSelection(thread.id)} />
                    </TableCell>
                    <TableCell onClick={() => setSelectedThread(thread)}>
                      {thread.contactName && <p className="m-0 text-body font-medium text-ink">{thread.contactName}</p>}
                      <p className="m-0 text-xs text-ink-3">{thread.contactEmail ?? '—'}</p>
                    </TableCell>
                    <TableCell onClick={() => setSelectedThread(thread)} className="max-w-[260px]">
                      <p className="m-0 truncate text-body text-ink">{thread.subject ?? '(No subject)'}</p>
                      {thread.summary && <p className="m-0 mt-0.5 truncate text-xs text-ink-3">{thread.summary}</p>}
                    </TableCell>
                    <TableCell onClick={() => setSelectedThread(thread)}>
                      <Tag tone={THREAD_TONE[thread.status]}>{thread.status.replace(/_/g, ' ')}</Tag>
                    </TableCell>
                    <TableCell onClick={() => setSelectedThread(thread)}>
                      <Tag tone={PRIORITY_TONE[thread.priority]}>{thread.priority}</Tag>
                    </TableCell>
                    <TableCell onClick={() => setSelectedThread(thread)}>
                      {thread.deal ? (
                        <Link
                          href={`/crm?dealId=${thread.deal.id}`}
                          className="inline-flex items-center gap-1.5 text-xs font-medium text-ink-2 no-underline hover:text-accent"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <span className="size-2 rounded-full" style={{ backgroundColor: thread.deal.stage?.color ?? '#6366f1' }} />
                          {thread.deal.stage?.name ?? 'Deal'}
                          <ExternalLink className="size-2.5" />
                        </Link>
                      ) : (
                        <span className="text-xs text-ink-4">—</span>
                      )}
                    </TableCell>
                    <TableCell onClick={() => setSelectedThread(thread)} className="text-right font-mono text-body text-ink-3">
                      {thread.messageCount}
                    </TableCell>
                    <TableCell onClick={() => setSelectedThread(thread)} className="whitespace-nowrap text-xs text-ink-3">
                      {thread.lastMessageAt ? formatDate(thread.lastMessageAt, 'MMM d, h:mm a') : '—'}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )
        ) : emails.length === 0 ? (
          <div className="px-5 py-14 text-center">
            <span className="mx-auto grid size-10 place-items-center rounded-full bg-accent-weak text-accent">
              <Mail size={18} />
            </span>
            <p className="mb-0 mt-3 text-body font-semibold text-ink">No emails found</p>
            <p className="mx-auto mb-0 mt-1 max-w-sm text-xs text-ink-3">{search ? 'Nothing matches your search.' : tab === 'sent' ? 'Emails you send will appear here.' : 'Replies will appear here.'}</p>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                {tab === 'sent' ? (
                  <>
                    <TableHead>To</TableHead>
                    <TableHead>Subject</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Opened</TableHead>
                    <TableHead>Sent at</TableHead>
                  </>
                ) : (
                  <>
                    <TableHead>From</TableHead>
                    <TableHead>Subject</TableHead>
                    <TableHead>Classification</TableHead>
                    <TableHead>Received at</TableHead>
                  </>
                )}
              </TableRow>
            </TableHeader>
            <TableBody>
              {emails.map((email) => (
                <TableRow key={email.id} className="cursor-pointer" onClick={() => setSelectedEmail(email)}>
                  {tab === 'sent' ? (
                    <>
                      <TableCell>
                        {email.contactName && <p className="m-0 text-body font-medium text-ink">{email.contactName}</p>}
                        <p className="m-0 text-xs text-ink-3">{email.toEmail}</p>
                      </TableCell>
                      <TableCell className="max-w-[300px] truncate text-body text-ink">{email.subject ?? '(No subject)'}</TableCell>
                      <TableCell>{email.status && <Tag tone={SENT_TONE[email.status]}>{email.status}</Tag>}</TableCell>
                      <TableCell>
                        {email.openedAt ? (
                          <Tag tone="up" title={formatDate(email.openedAt, 'MMM d, h:mm a')}>
                            Opened {formatRelative(email.openedAt)}
                          </Tag>
                        ) : (
                          <Tag>Not opened</Tag>
                        )}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-xs text-ink-3">
                        {formatDate(email.sentAt ?? email.createdAt ?? '', 'MMM d, h:mm a') || '—'}
                      </TableCell>
                    </>
                  ) : (
                    <>
                      <TableCell>
                        {email.contactName && <p className="m-0 text-body font-medium text-ink">{email.contactName}</p>}
                        <p className="m-0 text-xs text-ink-3">{email.fromEmail}</p>
                      </TableCell>
                      <TableCell className="max-w-[300px] truncate text-body text-ink">{email.subject ?? '(No subject)'}</TableCell>
                      <TableCell>
                        {email.classification && <Tag tone={CLASSIFICATION_TONE[email.classification]}>{email.classification.replace(/_/g, ' ')}</Tag>}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-xs text-ink-3">
                        {email.createdAt ? formatDate(email.createdAt, 'MMM d, h:mm a') : '—'}
                      </TableCell>
                    </>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>

      {/* Email Detail Dialog */}
      <EmailDetailDialog
        email={selectedEmail}
        open={!!selectedEmail}
        onOpenChange={(open) => { if (!open) setSelectedEmail(null); }}
      />

      {/* Thread Detail Dialog */}
      <ThreadDetailDialog
        thread={selectedThread}
        open={!!selectedThread}
        onOpenChange={(open) => { if (!open) setSelectedThread(null); }}
      />
    </div>
  );
}
