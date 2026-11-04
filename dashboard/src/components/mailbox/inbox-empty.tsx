'use client';

import Link from 'next/link';
import { Inbox } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useEmailAccounts, useEmailListeners } from '@/hooks/use-email-settings';
import { useMailboxDigest, useMailboxStats } from '@/hooks/use-mailbox';

/** True when the workspace has never received a reply, so the thread list has nothing to show. */
export function useInboxIsEmpty() {
  const stats = useMailboxStats();
  const digest = useMailboxDigest();
  const ready = !!stats.data && !!digest.data;
  return {
    ready,
    // Both counts are still being fetched: callers should show a placeholder, not guess.
    loading: stats.isLoading || digest.isLoading,
    empty: ready && stats.data!.totalReceived === 0 && digest.data!.totalThreads === 0,
    sent: stats.data?.totalSent ?? 0,
  };
}

/** Top-bar subtitle for /mailbox. */
export function MailboxSubtitle() {
  const { ready, empty, sent } = useInboxIsEmpty();
  const digest = useMailboxDigest();
  if (!ready) return <>Replies and conversations.</>;
  if (empty) return <>Nothing here yet · {sent} sent</>;
  const n = digest.data?.needsAction ?? 0;
  return <>{n} need{n === 1 ? 's' : ''} an answer · {sent} sent</>;
}

type Cause = 'no-mailbox' | 'no-listener' | 'quiet';

/** Two-pane empty Inbox: an empty thread list plus a card that says why. */
export function InboxEmptyState({ sent }: { sent: number }) {
  const accounts = useEmailAccounts();
  const listeners = useEmailListeners();

  const active = (accounts.data ?? []).filter((a) => a.isActive);
  const watched = new Set((listeners.data ?? []).filter((l) => l.isActive).map((l) => l.emailAccountId));
  const unwatched = active.find((a) => !watched.has(a.id));
  const cause: Cause = active.length === 0 ? 'no-mailbox' : unwatched ? 'no-listener' : 'quiet';

  const messages = sent > 0 ? `the ${sent} message${sent === 1 ? '' : 's'} you sent` : 'the messages you send';

  const copy: Record<Cause, { title: string; body: string; cta?: { label: string; href: string } }> = {
    'no-mailbox': {
      title: 'No mailbox connected',
      body: 'Connect a mailbox to send from. Replies to what you send land here within a minute of arriving.',
      cta: { label: 'Connect a mailbox', href: '/settings/email' },
    },
    'no-listener': {
      title: 'Reply detection is not connected',
      body: `Nothing is watching ${unwatched?.fromEmail ?? 'your mailbox'}, so replies to ${messages} cannot reach your Inbox. This page is empty for that reason — not because nobody replied. Connect it and replies land here within a minute of arriving.`,
      cta: { label: 'Connect reply detection', href: '/settings/email' },
    },
    quiet: {
      title: 'No replies yet',
      body: `Reply detection is on, so replies to ${messages} land here within a minute of arriving.`,
    },
  };
  const c = copy[cause];

  return (
    <div className="mx-auto grid max-w-[1100px] items-start gap-4 p-6 md:grid-cols-[300px_1fr]">
      <section className="rounded-xl border border-line bg-bg-panel shadow-sm">
        <div className="border-b border-line px-4 py-3 text-xs text-ink-3">No threads yet</div>
        <p className="m-0 px-4 py-4 text-xs leading-relaxed text-ink-3">
          Replies appear here within a minute of arriving
          {cause === 'quiet' ? '.' : ' — once reply detection is connected.'}
        </p>
      </section>

      <section className="rounded-2xl border border-line bg-bg-panel p-7 shadow-sm">
        <span className="grid size-9 place-items-center rounded-full bg-warn/10 text-warn-fg">
          <Inbox size={16} />
        </span>
        <h2 className="mb-0 mt-4 font-display text-[26px] font-normal leading-tight tracking-[-0.01em] text-ink">{c.title}</h2>
        <p className="mb-5 mt-2 max-w-[470px] text-body leading-relaxed text-ink-3">{c.body}</p>
        {c.cta && (
          <Button asChild variant="brand">
            <Link href={c.cta.href}>{c.cta.label}</Link>
          </Button>
        )}
      </section>
    </div>
  );
}
