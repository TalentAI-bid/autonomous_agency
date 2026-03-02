'use client';

import { useState } from 'react';
import { useMailboxSent, useMailboxInbox, useMailboxStats, useMailboxThreads, useMailboxDigest, useBulkAction } from '@/hooks/use-mailbox';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { EmailDetailDialog } from '@/components/mailbox/email-detail-dialog';
import { ThreadDetailDialog } from '@/components/mailbox/thread-detail-dialog';
import { formatDate, formatRelative, formatNumber } from '@/lib/utils';
import {
  Mail, Inbox, Send, ArrowDown, ArrowUp, Search, MessageSquare,
  Archive, Ban, AlertCircle, ExternalLink,
} from 'lucide-react';
import Link from 'next/link';
import type { MailboxEmail, MailboxThread } from '@/types';

function classificationBadge(c?: string) {
  if (!c) return null;
  const colorMap: Record<string, string> = {
    interested: 'bg-emerald-900/30 text-emerald-400',
    inquiry: 'bg-blue-900/30 text-blue-400',
    application: 'bg-indigo-900/30 text-indigo-400',
    partnership: 'bg-purple-900/30 text-purple-400',
    introduction: 'bg-cyan-900/30 text-cyan-400',
    objection: 'bg-orange-900/30 text-orange-400',
    not_now: 'bg-yellow-900/30 text-yellow-400',
    out_of_office: 'bg-zinc-800 text-zinc-400',
    unsubscribe: 'bg-red-900/30 text-red-400',
    bounce: 'bg-red-900/30 text-red-400',
    spam: 'bg-red-900/30 text-red-300',
    support_request: 'bg-amber-900/30 text-amber-400',
  };
  return (
    <Badge className={colorMap[c] ?? 'bg-zinc-800 text-zinc-400'}>
      {c.replace(/_/g, ' ')}
    </Badge>
  );
}

function statusBadge(s?: string) {
  if (!s) return null;
  const colorMap: Record<string, string> = {
    sent: 'bg-emerald-900/30 text-emerald-400',
    queued: 'bg-blue-900/30 text-blue-400',
    sending: 'bg-yellow-900/30 text-yellow-400',
    failed: 'bg-red-900/30 text-red-400',
    cancelled: 'bg-zinc-800 text-zinc-400',
  };
  return (
    <Badge className={colorMap[s] ?? 'bg-zinc-800 text-zinc-400'}>
      {s}
    </Badge>
  );
}

const priorityColors: Record<string, string> = {
  high: 'bg-red-900/30 text-red-400',
  medium: 'bg-yellow-900/30 text-yellow-400',
  low: 'bg-zinc-800 text-zinc-400',
};

const threadStatusColors: Record<string, string> = {
  active: 'bg-emerald-900/30 text-emerald-400',
  needs_action: 'bg-red-900/30 text-red-400',
  waiting: 'bg-blue-900/30 text-blue-400',
  archived: 'bg-zinc-800 text-zinc-400',
};

export default function MailboxPage() {
  const [tab, setTab] = useState<'inbox' | 'sent' | 'threads'>('threads');
  const [search, setSearch] = useState('');
  const [threadStatusFilter, setThreadStatusFilter] = useState<string>('');
  const [selectedEmail, setSelectedEmail] = useState<MailboxEmail | null>(null);
  const [selectedThread, setSelectedThread] = useState<MailboxThread | null>(null);
  const [selectedThreadIds, setSelectedThreadIds] = useState<Set<string>>(new Set());

  const { data: stats, isLoading: statsLoading } = useMailboxStats();
  const { data: digest } = useMailboxDigest();
  const { data: sentData, isLoading: sentLoading } = useMailboxSent({ search: search || undefined });
  const { data: inboxData, isLoading: inboxLoading } = useMailboxInbox({ search: search || undefined });
  const { data: threadData, isLoading: threadsLoading } = useMailboxThreads({
    search: search || undefined,
    status: threadStatusFilter || undefined,
  });
  const bulkAction = useBulkAction();

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

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Mail className="w-6 h-6 text-blue-400" />
        <div>
          <h1 className="text-2xl font-bold">Mailbox</h1>
          <p className="text-muted-foreground text-sm mt-0.5">Manage email threads and conversations</p>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-4">
        {statsLoading ? (
          Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-[80px]" />)
        ) : (
          <>
            <Card>
              <CardContent className="p-4 flex items-center gap-3">
                <div className="p-2 rounded-lg bg-blue-500/10">
                  <ArrowDown className="w-4 h-4 text-blue-400" />
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Received Today</p>
                  <p className="text-xl font-bold">{formatNumber(stats?.todayReceived ?? 0)}</p>
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4 flex items-center gap-3">
                <div className="p-2 rounded-lg bg-emerald-500/10">
                  <ArrowUp className="w-4 h-4 text-emerald-400" />
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Sent Today</p>
                  <p className="text-xl font-bold">{formatNumber(stats?.todaySent ?? 0)}</p>
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4 flex items-center gap-3">
                <div className="p-2 rounded-lg bg-indigo-500/10">
                  <MessageSquare className="w-4 h-4 text-indigo-400" />
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Total Threads</p>
                  <p className="text-xl font-bold">{formatNumber(digest?.totalThreads ?? 0)}</p>
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4 flex items-center gap-3">
                <div className="p-2 rounded-lg bg-red-500/10">
                  <AlertCircle className="w-4 h-4 text-red-400" />
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Needs Action</p>
                  <p className="text-xl font-bold">{formatNumber(digest?.needsAction ?? 0)}</p>
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4 flex items-center gap-3">
                <div className="p-2 rounded-lg bg-orange-500/10">
                  <ArrowUp className="w-4 h-4 text-orange-400" />
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">High Priority</p>
                  <p className="text-xl font-bold">{formatNumber(digest?.highPriority ?? 0)}</p>
                </div>
              </CardContent>
            </Card>
          </>
        )}
      </div>

      {/* Tab Toggle + Search */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex bg-muted rounded-lg p-0.5">
          <Button
            variant={tab === 'threads' ? 'default' : 'ghost'}
            size="sm"
            onClick={() => setTab('threads')}
            className="text-xs"
          >
            <MessageSquare className="w-3.5 h-3.5 mr-1.5" />
            Threads
          </Button>
          <Button
            variant={tab === 'inbox' ? 'default' : 'ghost'}
            size="sm"
            onClick={() => setTab('inbox')}
            className="text-xs"
          >
            <Inbox className="w-3.5 h-3.5 mr-1.5" />
            Inbox
          </Button>
          <Button
            variant={tab === 'sent' ? 'default' : 'ghost'}
            size="sm"
            onClick={() => setTab('sent')}
            className="text-xs"
          >
            <Send className="w-3.5 h-3.5 mr-1.5" />
            Sent
          </Button>
        </div>
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            placeholder={tab === 'threads' ? 'Search threads...' : 'Search emails...'}
            className="pl-9 h-9"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        {tab === 'threads' && (
          <div className="flex gap-1.5">
            {['', 'active', 'needs_action', 'waiting', 'archived'].map((s) => (
              <Button
                key={s}
                variant={threadStatusFilter === s ? 'default' : 'outline'}
                size="sm"
                className="text-xs h-8"
                onClick={() => setThreadStatusFilter(s)}
              >
                {s ? s.replace(/_/g, ' ') : 'All'}
              </Button>
            ))}
          </div>
        )}
      </div>

      {/* Bulk Action Toolbar for Threads */}
      {tab === 'threads' && selectedThreadIds.size > 0 && (
        <div className="flex items-center gap-3 p-3 bg-muted/50 rounded-lg border border-border/50">
          <span className="text-sm font-medium">{selectedThreadIds.size} selected</span>
          <Button variant="outline" size="sm" onClick={() => handleBulkAction('archive')} disabled={bulkAction.isPending}>
            <Archive className="w-3.5 h-3.5 mr-1.5" />
            Archive
          </Button>
          <Button variant="outline" size="sm" onClick={() => handleBulkAction('mark_spam')} disabled={bulkAction.isPending}>
            <Ban className="w-3.5 h-3.5 mr-1.5" />
            Mark Spam
          </Button>
          <Button variant="outline" size="sm" onClick={() => handleBulkAction('unsubscribe')} disabled={bulkAction.isPending}>
            Unsubscribe
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setSelectedThreadIds(new Set())}>
            Clear
          </Button>
        </div>
      )}

      {/* Content */}
      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-6 space-y-3">
              {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-12" />)}
            </div>
          ) : tab === 'threads' ? (
            /* Thread Table */
            threads.length === 0 ? (
              <div className="text-center py-12">
                <MessageSquare className="w-10 h-10 text-muted-foreground mx-auto mb-3" />
                <p className="text-sm text-muted-foreground">No threads found</p>
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-10">
                      <Checkbox
                        checked={selectedThreadIds.size === threads.length && threads.length > 0}
                        onCheckedChange={toggleAllThreads}
                      />
                    </TableHead>
                    <TableHead>Contact</TableHead>
                    <TableHead>Subject</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Priority</TableHead>
                    <TableHead>Deal</TableHead>
                    <TableHead>Messages</TableHead>
                    <TableHead>Last Activity</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {threads.map((thread) => (
                    <TableRow key={thread.id} className="cursor-pointer">
                      <TableCell onClick={(e) => e.stopPropagation()}>
                        <Checkbox
                          checked={selectedThreadIds.has(thread.id)}
                          onCheckedChange={() => toggleThreadSelection(thread.id)}
                        />
                      </TableCell>
                      <TableCell onClick={() => setSelectedThread(thread)}>
                        <div>
                          {thread.contactName && (
                            <p className="text-sm font-medium">{thread.contactName}</p>
                          )}
                          <p className="text-xs text-muted-foreground">{thread.contactEmail ?? '—'}</p>
                        </div>
                      </TableCell>
                      <TableCell onClick={() => setSelectedThread(thread)} className="max-w-[250px]">
                        <p className="text-sm truncate">{thread.subject ?? '(No subject)'}</p>
                        {thread.summary && (
                          <p className="text-xs text-muted-foreground truncate mt-0.5">{thread.summary}</p>
                        )}
                      </TableCell>
                      <TableCell onClick={() => setSelectedThread(thread)}>
                        <Badge className={threadStatusColors[thread.status] ?? 'bg-zinc-800 text-zinc-400'}>
                          {thread.status.replace(/_/g, ' ')}
                        </Badge>
                      </TableCell>
                      <TableCell onClick={() => setSelectedThread(thread)}>
                        <Badge className={priorityColors[thread.priority] ?? ''}>
                          {thread.priority}
                        </Badge>
                      </TableCell>
                      <TableCell onClick={() => setSelectedThread(thread)}>
                        {thread.deal ? (
                          <Link
                            href={`/crm?dealId=${thread.deal.id}`}
                            className="flex items-center gap-1.5 text-xs text-blue-400 hover:text-blue-300"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <div
                              className="w-2 h-2 rounded-full"
                              style={{ backgroundColor: thread.deal.stage?.color ?? '#6366f1' }}
                            />
                            {thread.deal.stage?.name ?? 'Deal'}
                            <ExternalLink className="w-2.5 h-2.5" />
                          </Link>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell onClick={() => setSelectedThread(thread)} className="text-sm text-muted-foreground">
                        {thread.messageCount}
                      </TableCell>
                      <TableCell onClick={() => setSelectedThread(thread)} className="text-sm text-muted-foreground">
                        {thread.lastMessageAt ? formatDate(thread.lastMessageAt, 'MMM d, h:mm a') : '—'}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )
          ) : (
            /* Email Table (Inbox/Sent) */
            emails.length === 0 ? (
              <div className="text-center py-12">
                <Mail className="w-10 h-10 text-muted-foreground mx-auto mb-3" />
                <p className="text-sm text-muted-foreground">No emails found</p>
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
                        <TableHead>Sent At</TableHead>
                      </>
                    ) : (
                      <>
                        <TableHead>From</TableHead>
                        <TableHead>Subject</TableHead>
                        <TableHead>Classification</TableHead>
                        <TableHead>Received At</TableHead>
                      </>
                    )}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {emails.map((email) => (
                    <TableRow
                      key={email.id}
                      className="cursor-pointer"
                      onClick={() => setSelectedEmail(email)}
                    >
                      {tab === 'sent' ? (
                        <>
                          <TableCell>
                            <div>
                              {email.contactName && (
                                <p className="text-sm font-medium">{email.contactName}</p>
                              )}
                              <p className="text-xs text-muted-foreground">{email.toEmail}</p>
                            </div>
                          </TableCell>
                          <TableCell className="max-w-[300px] truncate text-sm">
                            {email.subject ?? '(No subject)'}
                          </TableCell>
                          <TableCell>{statusBadge(email.status)}</TableCell>
                          <TableCell>
                            {email.openedAt ? (
                              <Badge className="bg-emerald-900/30 text-emerald-400" title={formatDate(email.openedAt, 'MMM d, h:mm a')}>
                                Opened {formatRelative(email.openedAt)}
                              </Badge>
                            ) : (
                              <Badge className="bg-zinc-800 text-zinc-400">Not opened</Badge>
                            )}
                          </TableCell>
                          <TableCell className="text-sm text-muted-foreground">
                            {formatDate(email.sentAt ?? email.createdAt ?? '', 'MMM d, h:mm a') || '—'}
                          </TableCell>
                        </>
                      ) : (
                        <>
                          <TableCell>
                            <div>
                              {email.contactName && (
                                <p className="text-sm font-medium">{email.contactName}</p>
                              )}
                              <p className="text-xs text-muted-foreground">{email.fromEmail}</p>
                            </div>
                          </TableCell>
                          <TableCell className="max-w-[300px] truncate text-sm">
                            {email.subject ?? '(No subject)'}
                          </TableCell>
                          <TableCell>{classificationBadge(email.classification)}</TableCell>
                          <TableCell className="text-sm text-muted-foreground">
                            {email.createdAt ? formatDate(email.createdAt, 'MMM d, h:mm a') : '—'}
                          </TableCell>
                        </>
                      )}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )
          )}
        </CardContent>
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
