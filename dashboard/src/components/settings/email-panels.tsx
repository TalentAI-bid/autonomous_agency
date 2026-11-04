'use client';

import * as React from 'react';
import { Badge } from '@/components/ui/badge';
import { Info, Inbox, Mail } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { StatTile } from '@/components/ui/stat-tile';
import { useEmailAccountQuota, useTestEmailAccount } from '@/hooks/use-email-settings';
import { useMailboxDigest, useMailboxSent, useMailboxStats, useMailboxThreads } from '@/hooks/use-mailbox';
import { useToast } from '@/hooks/use-toast';
import { cn, formatDate, formatRelative } from '@/lib/utils';
import type { EmailAccount, EmailListenerConfig } from '@/types';

/* ─── Shared pieces ─────────────────────────────────────────────────────────── */

function PanelHead({
  icon,
  title,
  sub,
  connected,
  actions,
}: {
  icon: React.ReactNode;
  title: string;
  sub: React.ReactNode;
  connected: boolean;
  actions: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-bg-soft text-ink-3">{icon}</span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-body font-semibold text-ink">{title}</div>
        <div className="truncate text-xs text-ink-3">{sub}</div>
      </div>
      <span
        className={cn(
          'inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-xs font-medium',
          connected ? 'bg-up/10 text-up' : 'bg-bg-soft text-ink-3',
        )}
      >
        <span className="size-1.5 rounded-full bg-current" />
        {connected ? 'Connected' : 'Disabled'}
      </span>
      {actions}
    </div>
  );
}

const linkBtn = 'h-8 rounded-lg px-2.5 text-xs font-medium';

const PROVIDER_LABEL: Record<string, string> = { smtp: 'SMTP', ses: 'AWS SES', sendgrid: 'SendGrid', custom: 'Custom' };

const shortDay = (iso?: string) => (iso ? formatDate(iso, 'd MMM') : '');

/* ─── Sending ───────────────────────────────────────────────────────────────── */

export function useSendingHealth(accounts: EmailAccount[]) {
  // Used by the card header; reads the first active account's quota.
  const first = accounts.find((a) => a.isActive);
  const quota = useEmailAccountQuota(first?.id ?? '');
  return { quota: quota.data, hasActive: !!first };
}

interface AccountPanelProps {
  account: EmailAccount;
  busy: boolean;
  onToggle: () => void;
  onDisconnect: () => void;
}

export function AccountPanel({ account, busy, onToggle, onDisconnect }: AccountPanelProps) {
  const { toast } = useToast();
  const quota = useEmailAccountQuota(account.id);
  const sent = useMailboxSent({ limit: 1 });
  const testSend = useTestEmailAccount();

  const [to, setTo] = React.useState(account.fromEmail);
  const [result, setResult] = React.useState<{ at: Date; ms: number } | null>(null);

  const q = quota.data;
  const last = sent.data?.data?.[0];
  const lastAt = last?.sentAt ?? last?.createdAt;

  async function sendTest() {
    if (!to.trim()) return;
    const started = Date.now();
    setResult(null);
    try {
      await testSend.mutateAsync({ id: account.id, to: to.trim() });
      setResult({ at: new Date(), ms: Date.now() - started });
    } catch {
      toast({ title: 'Test send failed', variant: 'destructive' });
    }
  }

  return (
    <div className="space-y-5">
      <PanelHead
        icon={<Mail size={16} />}
        title={account.fromEmail}
        sub={[
          account.smtpHost ?? PROVIDER_LABEL[account.provider] ?? account.provider,
          `connected ${shortDay(account.createdAt)}`,
          account.fromName ? `sends as ${account.fromName}` : null,
        ]
          .filter(Boolean)
          .join(' · ')}
        connected={account.isActive}
        actions={
          <>
            <Button type="button" variant="ghost" size="dense" onClick={onToggle} disabled={busy} className={linkBtn}>
              {account.isActive ? 'Disable' : 'Enable'}
            </Button>
            <Button type="button" variant="ghost" size="dense" onClick={onDisconnect} disabled={busy} className={linkBtn}>
              Disconnect
            </Button>
          </>
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {/* Not reported by the API yet — the tile is ready for it. */}
        <StatTile label="SPF · DKIM · DMARC" value="—" sub="Not checked yet" />
        <StatTile
          label="Sends today"
          value={q ? `${q.dailyUsed} of ${q.dailyLimit}` : '—'}
          sub={account.isWarmup ? 'Cap rises as the mailbox warms up' : 'Daily cap'}
        />
        {/* Not reported by the API yet. */}
        <StatTile label="Bounce rate · 30 days" value="—" sub="Not tracked yet" />
        <StatTile
          label="Last successful send"
          value={lastAt ? formatRelative(lastAt).replace(/^about /, '') : '—'}
          sub={last ? `to ${last.contactName ?? last.toEmail ?? 'a contact'}` : 'Nothing sent yet'}
        />
      </div>

      <div>
        <div className="text-3xs font-medium uppercase tracking-[0.09em] text-ink-4">Test send</div>
        <label htmlFor={`test-${account.id}`} className="mt-2 block text-xs font-medium text-ink">
          Send a test to
        </label>
        <div className="mt-1.5 flex flex-wrap items-center gap-2">
          <Input
            id={`test-${account.id}`}
            type="email"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className="h-9 w-full max-w-[320px] rounded-lg bg-bg-panel text-body"
          />
          <Button type="button" variant="panel" size="dense" onClick={sendTest} disabled={testSend.isPending || !to.trim()} className="h-9 rounded-lg px-4 text-body font-medium">
            {testSend.isPending ? 'Sending…' : 'Send test'}
          </Button>
          {result && (
            <Badge variant="up" dot>
              Sent · {formatDate(result.at, 'HH:mm')} · {(result.ms / 1000).toFixed(1)} s
            </Badge>
          )}
        </div>
        <p className="mb-0 mt-2 text-xs text-ink-3">Sends one real email from {account.fromEmail} to the address above.</p>
      </div>
    </div>
  );
}

/* ─── Reply detection ───────────────────────────────────────────────────────── */

interface ListenerPanelProps {
  listener: EmailListenerConfig;
  busy: boolean;
  onTest: () => void;
  onPoll: () => void;
  onDisconnect: () => void;
}

export function ListenerPanel({ listener, busy, onTest, onPoll, onDisconnect }: ListenerPanelProps) {
  const stats = useMailboxStats();
  const digest = useMailboxDigest();
  const waiting = useMailboxThreads({ status: 'needs_action', limit: 2 });

  const received = stats.data?.totalReceived ?? 0;
  const sentTotal = stats.data?.totalSent ?? 0;
  const pct = sentTotal > 0 ? ((received / sentTotal) * 100).toFixed(1) : null;
  const needs = digest.data?.needsAction ?? 0;
  const names = (waiting.data?.data ?? []).map((t) => t.contactName ?? t.contactEmail).filter(Boolean).join(' · ');

  return (
    <div className="space-y-5">
      <PanelHead
        icon={<Inbox size={16} />}
        title={listener.username}
        sub={`Reads replies to messages Keenpipe sent · nothing else · connected ${shortDay(listener.createdAt)}`}
        connected={listener.isActive}
        actions={
          <>
            <Button type="button" variant="ghost" size="dense" onClick={onTest} disabled={busy} className={linkBtn}>
              Test
            </Button>
            <Button type="button" variant="ghost" size="dense" onClick={onPoll} disabled={busy} className={linkBtn}>
              Check now
            </Button>
            <Button type="button" variant="ghost" size="dense" onClick={onDisconnect} disabled={busy} className={linkBtn}>
              Disconnect
            </Button>
          </>
        }
      />

      <div className="grid gap-3 sm:grid-cols-3">
        <StatTile
          label="Replies detected"
          value={`${received} of ${sentTotal}`}
          sub={pct ? `${pct}% of sent · all time` : 'Nothing sent yet'}
        />
        <StatTile label="Waiting for an answer" value={needs} sub={names || 'Nobody is waiting'} tone={needs > 0 ? 'warn' : 'default'} />
        {/* Not reported by the API yet. */}
        <StatTile label="Unmatched" value="—" sub="Replies we could not link to a message" />
      </div>
    </div>
  );
}

export function UnlocksNote() {
  return (
    <div className="flex items-start gap-2.5 rounded-row bg-bg-soft px-3.5 py-3 text-xs leading-relaxed text-ink-3">
      <Info size={13} className="mt-0.5 shrink-0" />
      <p className="m-0">
        <strong className="font-semibold text-ink">What this unlocks.</strong> Replies land in your Inbox within a minute, the reply rate on Home
        and Reports is real, and a deal card moves to Replied on its own when someone answers.
      </p>
    </div>
  );
}
