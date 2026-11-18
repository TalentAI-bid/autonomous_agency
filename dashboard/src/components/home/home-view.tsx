'use client';

import * as React from 'react';
import Link from 'next/link';
import { CheckSquare, CircleAlert, Inbox, Settings as Cog } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { useHomeData, type ConnState, type NeedItem } from '@/hooks/use-home';
import { HomeAction, HomeSection, RowIcon, StatCard, StatusPill } from './home-parts';

type HomeData = ReturnType<typeof useHomeData>;

const DAY_MS = 86_400_000;

const NEED_ICON: Record<NeedItem['key'], React.ReactNode> = {
  approvals: <CheckSquare size={15} />,
  replies: <Inbox size={15} />,
  placeholder: <CircleAlert size={15} />,
};

const DOT_TONE: Record<ConnState, string> = {
  on: 'bg-up',
  warn: 'bg-warn',
  off: 'bg-ink-4',
};

const shortDate = (d: Date) => d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
const num = (n: number) => n.toLocaleString();

/** One list row inside a HomeSection. */
function Row({ className, children }: { className?: string; children: React.ReactNode }) {
  return <div className={cn('flex items-center gap-3 border-t border-line px-4 py-3', className)}>{children}</div>;
}

function EmptyRow({ children }: { children: React.ReactNode }) {
  return <div className="border-t border-line px-4 py-6 text-center text-body text-ink-3">{children}</div>;
}

function HomeSkeleton() {
  return (
    <div className="mx-auto flex max-w-[940px] flex-col gap-4 p-5" aria-busy="true" aria-label="Loading overview">
      <Skeleton className="h-40 rounded-2xl" />
      <Skeleton className="h-44 rounded-2xl" />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="h-24 rounded-2xl" />
        ))}
      </div>
      <Skeleton className="h-52 rounded-2xl" />
    </div>
  );
}

function NeedsSection({ needs }: { needs: HomeData['needs'] }) {
  return (
    <HomeSection
      title="Needs you today"
      meta={needs.length > 0 ? `${needs.length} thing${needs.length === 1 ? '' : 's'} · newest first` : undefined}
    >
      {needs.length === 0 ? (
        <EmptyRow>Nothing needs you right now. New approvals and replies show up here.</EmptyRow>
      ) : (
        needs.map((n) => (
          <Row key={n.key}>
            <RowIcon tone={n.tone}>{NEED_ICON[n.key]}</RowIcon>
            <div className="min-w-0 flex-1">
              <div className="text-body font-medium text-ink">{n.title}</div>
              <div className="truncate text-xs text-ink-3">{n.subtitle}</div>
            </div>
            <HomeAction href={n.href}>{n.actionLabel}</HomeAction>
          </Row>
        ))
      )}
    </HomeSection>
  );
}

function ConnectionsSection({ sending, connections }: Pick<HomeData, 'sending' | 'connections'>) {
  return (
    <HomeSection
      title="Connections"
      meta={
        <span className="inline-flex items-center gap-1.5">
          <span className={cn('size-1.5 rounded-full', DOT_TONE[sending.state])} aria-hidden />
          {sending.text}
        </span>
      }
    >
      {connections.map((c) => (
        <Row key={c.key} className="flex-wrap gap-x-4 gap-y-1.5 py-3.5">
          <div className="w-[116px] shrink-0 text-body font-medium text-ink">{c.label}</div>
          <StatusPill tone={c.state === 'on' ? 'up' : 'warn'}>{c.pill}</StatusPill>
          <div className="min-w-0 flex-1 basis-40 truncate text-xs text-ink-3">{c.detail}</div>
          {c.state !== 'on' && <HomeAction href={c.href}>{c.actionLabel}</HomeAction>}
        </Row>
      ))}
    </HomeSection>
  );
}

function StatsSection({ stats }: { stats: HomeData['stats'] }) {
  // Recomputed only when the window changes, not on every render.
  const range = React.useMemo(() => {
    const to = new Date();
    return { from: new Date(to.getTime() - stats.windowDays * DAY_MS), to };
  }, [stats.windowDays]);

  const noMeetings = stats.meetings === 0;

  return (
    <section aria-label="Results">
      <div className="mb-2 flex items-baseline gap-2 px-1 text-2xs font-medium uppercase tracking-[0.09em] text-ink-4">
        {stats.windowed ? (
          <>
            <span>Last {stats.windowDays} days</span>
            <span className="normal-case tracking-normal text-ink-3">
              {shortDate(range.from)} – {shortDate(range.to)}
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
          value={num(stats.approvedSent)}
          tail={stats.reviewed != null ? `of ${num(stats.reviewed)}` : undefined}
          detail={`${stats.skipped ?? '—'} skipped`}
        />
        <StatCard
          label="Replies"
          value={num(stats.replies)}
          tail={stats.replyRate != null ? `· ${stats.replyRate.toFixed(1)}% of sent` : undefined}
          detail={`${stats.stillWaiting} still waiting on you`}
        />
        <StatCard
          label="Meetings booked"
          value={num(stats.meetings)}
          tail={noMeetings ? '· None yet' : undefined}
          detail={noMeetings ? 'Nothing booked yet' : 'Scheduled with your leads'}
          muted={noMeetings}
        />
        <StatCard
          label="Leads scored"
          value={num(stats.scored)}
          tail={`of ${num(stats.discovered)}`}
          detail={
            stats.bar != null && stats.cleared != null
              ? `${num(stats.cleared)} cleared your bar of ${stats.bar}`
              : 'Score bar not set yet'
          }
        />
      </div>
    </section>
  );
}

function AgentsSection({ agents }: { agents: HomeData['agents'] }) {
  return (
    <HomeSection
      title="Your agents"
      meta={
        <Link href="/agents" className="font-medium text-accent hover:underline">
          All agents
        </Link>
      }
    >
      {agents.length === 0 ? (
        <EmptyRow>
          No agents yet.{' '}
          <Link href="/agents/new" className="font-medium text-accent hover:underline">
            Create your first agent
          </Link>
        </EmptyRow>
      ) : (
        agents.map((a) => (
          <Row key={a.id} className="flex-wrap gap-y-2 py-3.5">
            <RowIcon tone="muted">
              <Cog size={15} />
            </RowIcon>
            <div className="min-w-0 basis-40 truncate text-body font-medium text-ink sm:w-[230px] sm:shrink-0 sm:basis-auto">
              {a.name}
            </div>
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
          </Row>
        ))
      )}
    </HomeSection>
  );
}

export function HomeView() {
  const home = useHomeData();

  if (home.isLoading) return <HomeSkeleton />;

  return (
    <div className="mx-auto flex max-w-[940px] flex-col gap-4 p-5">
      <NeedsSection needs={home.needs} />
      <ConnectionsSection sending={home.sending} connections={home.connections} />
      <StatsSection stats={home.stats} />
      <AgentsSection agents={home.agents} />
    </div>
  );
}
