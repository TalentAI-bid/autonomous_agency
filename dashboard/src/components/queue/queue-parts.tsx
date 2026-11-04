'use client';

import * as React from 'react';
import { Card } from '@/components/ui/card';
import Link from 'next/link';
import { Check, Inbox } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useGetStarted } from '@/hooks/use-get-started';
import { useEmailAccounts, useEmailListeners } from '@/hooks/use-email-settings';

const DISMISS_KEY = 'kp.approvals.replyBannerDismissed';
const today = () => new Date().toISOString().slice(0, 10);

function readDismissed() {
  try {
    return localStorage.getItem(DISMISS_KEY) === today();
  } catch {
    return false;
  }
}

/** Amber strip shown while a connected mailbox has no reply listener. */
export function ReplyDetectionBanner() {
  const accounts = useEmailAccounts();
  const listeners = useEmailListeners();
  const [dismissed, setDismissed] = React.useState(false);
  React.useEffect(() => setDismissed(readDismissed()), []);

  const active = (accounts.data ?? []).filter((a) => a.isActive);
  const watched = new Set((listeners.data ?? []).filter((l) => l.isActive).map((l) => l.emailAccountId));
  const off = active.length > 0 && active.some((a) => !watched.has(a.id));
  if (accounts.isLoading || listeners.isLoading || !off || dismissed) return null;

  const dismiss = () => {
    try {
      localStorage.setItem(DISMISS_KEY, today());
    } catch {}
    setDismissed(true);
  };

  return (
    <div className="flex items-center gap-3 rounded-row border border-warn/30 bg-warn/10 px-3.5 py-2.5 text-body text-warn-fg">
      <span className="grid size-4 shrink-0 place-items-center rounded-full border border-current text-3xs font-bold leading-none">!</span>
      <p className="m-0 min-w-0 flex-1">
        <strong className="font-semibold">Reply detection is off</strong> — replies to anything you send today will not reach your Inbox.
        Nothing else is affected.
      </p>
      <Button size="dense" asChild variant="panel" className="border-warn/40 text-warn-fg">
        <Link href="/settings/email">Connect reply detection</Link>
      </Button>
      <button type="button" onClick={dismiss} className="rounded-md px-1.5 py-1 text-xs font-medium hover:bg-warn/10">
        Dismiss for today
      </button>
    </div>
  );
}

/** Shown instead of the queue until the workspace has its first agent. */
export function NoAgentCard() {
  const gs = useGetStarted();
  const onlyAgentLeft = !gs.isLoading && gs.remaining === 1;
  return (
    <Card as="section" className="p-7">
      <span className="grid size-9 place-items-center rounded-full bg-accent-weak text-accent">
        <Inbox size={16} />
      </span>
      <h2 className="mb-0 mt-4 font-display text-[26px] font-normal leading-tight tracking-[-0.01em] text-ink">No approvals yet</h2>
      <p className="mb-5 mt-2 max-w-[460px] text-body leading-relaxed text-ink-3">
        Approvals appear here once your first agent has run — the drafts are ready the next morning, and nothing sends until you approve them.
      </p>
      <Button asChild variant="brand">
        <Link href={onlyAgentLeft ? '/agents/new' : '/get-started'}>{onlyAgentLeft ? 'Create agent' : 'Finish setting up'}</Link>
      </Button>
    </Card>
  );
}

interface ClearedCardProps {
  summary: string;
  quotaText: string;
  exhausted: boolean;
  pending: boolean;
  remaining: number;
  limit: number;
  onRefresh: () => void;
  title?: string;
}

/** "Cleared for today" card shown when nothing is waiting. */
export function ClearedCard({ summary, quotaText, exhausted, pending, remaining, limit, onRefresh, title }: ClearedCardProps) {
  return (
    <Card as="section" className="p-7">
      <span className="grid size-9 place-items-center rounded-full bg-up/10 text-up">
        <Check size={16} strokeWidth={2.5} />
      </span>
      <h2 className="mb-0 mt-4 font-display text-[26px] font-normal leading-tight tracking-[-0.01em] text-ink">Cleared for today</h2>
      <p className="mb-5 mt-2 max-w-[460px] text-body leading-relaxed text-ink-3">{summary}</p>
      <div className="flex items-center gap-3">
        <Button
          type="button"
          variant="brand"
          onClick={onRefresh}
          disabled={pending || exhausted}
          title={title}
        >
          {pending ? 'Refreshing…' : exhausted ? 'Limit reached' : 'Refresh now'}
        </Button>
        <span className="text-xs text-ink-3">
          {quotaText || `${remaining} of ${limit} daily refreshes left`}
        </span>
      </div>
    </Card>
  );
}
