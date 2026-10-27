'use client';

import Link from 'next/link';
import { CheckSquare, CircleAlert, Inbox, Settings as Cog } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { useHomeData, type NeedItem } from '@/hooks/use-home';
import { HomeAction, HomeSection, RowIcon, StatCard, StatusPill } from './home-parts';

const NEED_ICON: Record<NeedItem['key'], React.ReactNode> = {
  approvals: <CheckSquare size={15} />,
  replies: <Inbox size={15} />,
  placeholder: <CircleAlert size={15} />,
};

function shortDate(d: Date) {
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

export function HomeView() {
  const home = useHomeData();
  const { stats } = home;

  const to = new Date();
  const from = new Date(to.getTime() - stats.windowDays * 86400000);

  if (home.isLoading) {
    return (
      <div className="mx-auto flex max-w-[940px] flex-col gap-4 p-5">
        <Skeleton className="h-52 rounded-xl" />
        <Skeleton className="h-40 rounded-xl" />
        <Skeleton className="h-28 rounded-xl" />
        <Skeleton className="h-52 rounded-xl" />
      </div>
    );
  }

  return (
    <div className="mx-auto flex max-w-[940px] flex-col gap-4 p-5">
      {/* Needs you today */}
      <HomeSection
        title="Needs you today"
        meta={home.needs.length > 0 ? `${home.needs.length} thing${home.needs.length === 1 ? '' : 's'} · newest first` : undefined}
      >
        {home.needs.length === 0 ? (
          <div className="border-t border-line px-4 py-6 text-center text-body text-ink-3">
            Nothing needs you right now. New approvals and replies show up here.
          </div>
        ) : (
          home.needs.map((n) => (
            <div key={n.key} className="flex items-center gap-3 border-t border-line px-4 py-3">
              <RowIcon tone={n.tone}>{NEED_ICON[n.key]}</RowIcon>
              <div className="min-w-0 flex-1">
                <div className="text-body font-medium text-ink">{n.title}</div>
                <div className="truncate text-xs text-ink-3">{n.subtitle}</div>
              </div>
              <HomeAction href={n.href}>{n.actionLabel}</HomeAction>
            </div>
          ))
        )}
      </HomeSection>

      {/* Connections */}
      <HomeSection
        title="Connections"
        meta={
          <span className="inline-flex items-center gap-1.5">
            <span className={cn('size-1.5 rounded-full', home.sending.state === 'on' ? 'bg-up' : home.sending.state === 'warn' ? 'bg-warn' : 'bg-ink-4')} />
            {home.sending.text}
          </span>
        }
      >
        {home.connections.map((c) => (
          <div key={c.key} className="flex items-center gap-4 border-t border-line px-4 py-3.5">
            <div className="w-[116px] shrink-0 text-body font-medium text-ink">{c.label}</div>
            <StatusPill tone={c.state === 'on' ? 'up' : 'warn'}>{c.pill}</StatusPill>
            <div className="min-w-0 flex-1 truncate text-xs text-ink-3">{c.detail}</div>
            {c.state !== 'on' && <HomeAction href={c.href}>{c.actionLabel}</HomeAction>}
          </div>
        ))}
      </HomeSection>

      {/* Stats */}
      <div>
        <div className="mb-2 flex items-baseline gap-2 px-1 text-2xs font-medium uppercase tracking-[0.09em] text-ink-4">
          {stats.windowed ? (
            <>
              <span>Last {stats.windowDays} days</span>
              <span className="normal-case tracking-normal text-ink-3">
                {shortDate(from)} – {shortDate(to)}
              </span>
            </>
          ) : (
            <>
              <span>All time</span>
              <span className="normal-case tracking-normal text-ink-3">last {stats.windowDays} days needs the 30-day report</span>
            </>
          )}
        </div>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatCard
            label="Approved & sent"
            value={stats.approvedSent.toLocaleString()}
            tail={stats.reviewed != null ? `of ${stats.reviewed.toLocaleString()}` : undefined}
            detail={`${stats.skipped != null ? stats.skipped : '—'} skipped`}
          />
          <StatCard
            label="Replies"
            value={stats.replies.toLocaleString()}
            tail={stats.replyRate != null ? `· ${stats.replyRate.toFixed(1)}% of sent` : undefined}
            detail={`${stats.stillWaiting} still waiting on you`}
          />
          <StatCard
            label="Meetings booked"
            value={stats.meetings.toLocaleString()}
            tail={stats.meetings === 0 ? '· None yet' : undefined}
            detail={stats.meetings === 0 ? 'Nothing booked yet' : 'Scheduled with your leads'}
            muted={stats.meetings === 0}
          />
          <StatCard
            label="Leads scored"
            value={stats.scored.toLocaleString()}
            tail={`of ${stats.discovered.toLocaleString()}`}
            detail={
              stats.bar != null && stats.cleared != null
                ? `${stats.cleared.toLocaleString()} cleared your bar of ${stats.bar}`
                : 'Score bar not set yet'
            }
          />
        </div>
      </div>

      {/* Your agents */}
      <HomeSection
        title="Your agents"
        meta={
          <Link href="/agents" className="font-medium text-accent hover:underline">
            All agents
          </Link>
        }
      >
        {home.agents.length === 0 ? (
          <div className="border-t border-line px-4 py-6 text-center text-body text-ink-3">
            No agents yet.{' '}
            <Link href="/agents/new" className="font-medium text-accent hover:underline">
              Create your first agent
            </Link>
          </div>
        ) : (
          home.agents.map((a) => (
            <div key={a.id} className="flex items-center gap-3 border-t border-line px-4 py-3.5">
              <RowIcon tone="muted">
                <Cog size={15} />
              </RowIcon>
              <div className="w-[230px] shrink-0 truncate text-body font-medium text-ink">{a.name}</div>
              <StatusPill tone={a.tone}>{a.statusLabel}</StatusPill>
              <div className="ml-auto flex shrink-0 items-center gap-5">
                <span className="font-mono text-xs text-ink-4">
                  {a.leads ?? '—'} leads · {a.contacted ?? '—'} contacted
                  {a.replies ? ` · ${a.replies} replies` : ''}
                </span>
                <Link href={`/agents/${a.id}`} className="text-body font-medium text-ink hover:text-accent">
                  View
                </Link>
              </div>
            </div>
          ))
        )}
      </HomeSection>
    </div>
  );
}
