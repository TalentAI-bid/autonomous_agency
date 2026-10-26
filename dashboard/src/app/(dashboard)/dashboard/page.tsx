'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAgents } from '@/hooks/use-agents';
import { useContacts } from '@/hooks/use-contacts';
import { useDashboardAnalytics } from '@/hooks/use-analytics';
import { useRealtimeStore } from '@/stores/realtime.store';
import { useAuthStore } from '@/stores/auth.store';
import { Icon } from '@/components/ui/icon';
import { Dot } from '@/components/ui/dot';
import { Spark } from '@/components/ui/spark';
import { KpiTile } from '@/components/ui/kpi-tile';
import { FunnelRow } from '@/components/ui/funnel-row';
import { StreamRow } from '@/components/ui/stream-row';
import { AgentGlyph, type AgentType } from '@/components/ui/agent-glyph';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { Panel, PanelBody, PanelHead } from '@/components/ui/panel';
import { ExportButton } from '@/components/shared/export-button';
import { OnboardingView } from '@/components/dashboard/onboarding-view';
import { useSetupStatus } from '@/hooks/use-setup-status';
import type { Contact, MasterAgent } from '@/types';

const LANES: AgentType[] = ['discovery', 'enrichment', 'scoring', 'outreach', 'reply', 'action'];

function greeting() {
  const h = new Date().getHours();
  if (h < 5) return 'Up late';
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
}

function firstName(source?: string | null) {
  if (!source) return 'there';
  return source.split(/[\s@]/)[0];
}

function initials(c: Contact) {
  const a = (c.firstName ?? '').charAt(0);
  const b = (c.lastName ?? '').charAt(0);
  return (a + b || (c.email ?? '?').charAt(0)).toUpperCase();
}

function AgentTile({ agent }: { agent: MasterAgent }) {
  const router = useRouter();
  // Derived mini pipeline — show lanes driven by status; runtime can refine later.
  const activeLanes: AgentType[] =
    agent.status === 'running' ? ['discovery', 'enrichment', 'scoring', 'outreach'] : [];

  return (
    <Panel className="cursor-pointer" onClick={() => router.push(`/agents/${agent.id}`)}>
      <PanelHead>
        <Dot state={agent.status === 'running' ? 'live' : agent.status === 'error' ? 'warn' : 'paused'} />
        <h3 className="m-0 text-[12.5px] font-medium normal-case tracking-[-0.005em] text-ink">{agent.name}</h3>
        <span className="meta">{agent.useCase}</span>
      </PanelHead>
      <PanelBody className="p-3">
        <div className="mb-2.5 flex items-end gap-3.5">
          <div>
            <div className="caps mb-0.5 text-2xs text-ink-3">Status</div>
            <div className="mono text-sm font-medium leading-none">{agent.status}</div>
          </div>
          <div className="ml-auto">
            <Spark
              data={[2, 3, 4, 5, 4, 6, 7, 6, 8, 9, 10, 11]}
              width={100}
              height={30}
              color="var(--accent)"
              fill
            />
          </div>
        </div>

        <div className="flex gap-1">
          {LANES.map((lane) => {
            const on = activeLanes.includes(lane);
            return (
              <div
                key={lane}
                title={lane}
                className={cn('h-1.5 flex-1 rounded-[1px] border', on ? 'border-transparent' : 'border-line bg-bg-soft opacity-60')}
                style={on ? { background: `var(--a-${lane})` } : undefined}
              />
            );
          })}
        </div>
        <div className="mt-[3px] flex gap-1">
          {LANES.map((lane) => (
            <div key={lane} className="flex-1 text-center text-3xs uppercase tracking-[0.04em] text-ink-3">
              {lane.slice(0, 3)}
            </div>
          ))}
        </div>
      </PanelBody>
    </Panel>
  );
}

export default function DashboardPage() {
  const { data: agents } = useAgents();
  const { data: contactsRes } = useContacts({ limit: 14 });
  const { data: analytics } = useDashboardAnalytics();
  const events = useRealtimeStore((s) => s.events);
  const agentMessages = useRealtimeStore((s) => s.agentMessages);
  const user = useAuthStore((s) => s.user);
  const { showOnboarding } = useSetupStatus();

  const contacts = contactsRes?.data ?? [];
  const total = analytics?.contacts.total ?? 0;
  const byStatus = analytics?.contacts.byStatus ?? {};
  const discovered = byStatus.discovered ?? 0;
  const enriched = byStatus.enriched ?? 0;
  const scored = byStatus.scored ?? 0;
  const contacted = byStatus.contacted ?? 0;
  const replied = analytics?.emails.replied ?? 0;
  const qualified = byStatus.qualified ?? 0;
  const interviews = analytics?.interviews.scheduled ?? 0;
  const sent = analytics?.emails.sent ?? 0;

  const runningAgents = agents?.filter((a) => a.status === 'running').length ?? 0;
  const totalAgents = agents?.length ?? 0;
  const replyRate = sent > 0 ? ((replied / sent) * 100).toFixed(1) + '%' : '—';

  const denom = Math.max(1, total || discovered);
  const funnel = [
    { label: 'Discovered', v: total, pct: total / denom },
    { label: 'Enriched', v: enriched, pct: enriched / denom },
    { label: 'Scored', v: scored, pct: scored / denom },
    { label: 'Contacted', v: contacted, pct: contacted / denom },
    { label: 'Replied', v: replied, pct: replied / denom },
    { label: 'Qualified', v: qualified, pct: qualified / denom },
    { label: 'Meetings', v: interviews, pct: interviews / denom },
  ];

  const overallConv = total > 0 ? ((interviews / total) * 100).toFixed(2) + '%' : '—';

  const feed = agentMessages.slice(0, 20);
  const eventFeed = events.slice(0, 20);

  // First-run: no agent deployed yet → clean onboarding view. Once an agent is
  // deployed this falls through to the live-ops dashboard below.
  if (showOnboarding) return <OnboardingView />;

  return (
    <div className="page">
      <div className="page-head pb-[18px]">
        <div className="page-title-group">
          <h1>
            <span className="display">
              {greeting()}, {firstName(user?.name ?? user?.email)}.
            </span>
          </h1>
          <p>
            Autonomous outbound sales — live operations overview ·{' '}
            <span className="mono">
              {new Date().toLocaleDateString('en-GB', {
                weekday: 'short',
                day: 'numeric',
                month: 'short',
                year: 'numeric',
              })}
            </span>
          </p>
        </div>
        <div className="page-actions">
          <Button variant="panel" size="dense" type="button">
            <Icon name="filter" /> Filters
          </Button>
          <Button variant="panel" size="dense" type="button">
            <Icon name="calendar" /> Today
          </Button>
          <ExportButton />
          <Button asChild variant="ink" size="dense"><Link href="/agents/new">
            <Icon name="plus" /> Deploy agent
          </Link></Button>
        </div>
      </div>

      {/* KPI row */}
      <div className="grid grid-cols-5 border-b border-line">
        <KpiTile
          label="Pipeline leads"
          value={total.toLocaleString()}
          sub="all time"
          spark={[52, 54, 55, 58, 60, 64, 62, 66, 70, 68, 72, 76]}
        />
        <KpiTile
          label="Active agents"
          value={runningAgents}
          sub={`of ${totalAgents} deployed`}
          spark={[3, 3, 4, 4, 4, 5, 5, 5, 5, 4, 5, 5]}
        />
        <KpiTile
          label="Emails sent"
          value={sent.toLocaleString()}
          spark={[88, 91, 95, 102, 110, 118, 121, 128, 131, 135, 138, 142]}
        />
        <KpiTile
          label="Meetings booked"
          value={interviews}
          sub="scheduled"
          up={interviews > 0}
          spark={[1, 2, 2, 3, 3, 4, 5, 6, 7, 7, 8, 9]}
        />
        <KpiTile
          label="Reply rate"
          value={replyRate}
          sub="all emails"
          up={replied > 0}
          spark={[9.8, 10.1, 10.3, 10.5, 10.2, 10.7, 11.0, 10.9, 11.1, 11.2, 11.3, 11.4]}
        />
      </div>

      {/* Hero layout: Left = lead stream, center = funnel + agents, right = live feed */}
      <div className="grid min-h-[560px] grid-cols-[320px_1fr_360px]">
        {/* LEFT: Live lead stream */}
        <div className="hairline-r flex min-h-0 min-w-0 flex-col">
          <div className="flex items-center gap-2 border-b border-line bg-bg-sub px-3.5 py-3">
            <Dot state="live" />
            <div className="caps-sm font-semibold text-ink-2">Live lead stream</div>
            <span className="ml-auto font-mono text-2xs text-ink-3">{contacts.length} · streaming</span>
          </div>
          <div className="min-h-0 flex-1 overflow-auto">
            {contacts.length === 0 && (
              <div className="p-[18px] text-xs text-ink-3">
                No leads yet. Deploy an agent to start streaming.
              </div>
            )}
            {contacts.map((c, i) => {
              const name = [c.firstName, c.lastName].filter(Boolean).join(' ') || c.email || 'Lead';
              const score = c.score ?? 0;
              return (
                <Link
                  key={c.id}
                  href={c.masterAgentId ? `/agents/${c.masterAgentId}/contacts/${c.id}` : '/agents'}
                  className={cn(
                    'grid grid-cols-[28px_1fr_auto] items-center gap-2.5 border-b border-line px-3.5 py-2.5',
                    i === 0 ? 'bg-accent-weak' : 'bg-transparent',
                  )}
                  style={i === 0 ? { animation: 'slide-in 0.4s ease-out' } : undefined}
                >
                  <div
                    className="avatar h-7 w-7 text-2xs"
                    style={{ background: `oklch(0.65 0.10 ${(name.charCodeAt(0) * 7) % 360})` }}
                  >
                    {initials(c)}
                  </div>
                  <div className="min-w-0">
                    <div className="truncate text-[12.5px] font-medium">{name}</div>
                    <div className="truncate text-[10.5px] text-ink-3">
                      {c.title ?? '—'} · {c.companyName ?? '—'}
                    </div>
                  </div>
                  <div className="flex flex-col items-end gap-0.5">
                    <div className={cn('mono text-xs font-semibold', score >= 85 ? 'text-up' : score >= 65 ? 'text-ink' : 'text-ink-3')}>
                      {score || '—'}
                    </div>
                  </div>
                </Link>
              );
            })}
          </div>
        </div>

        {/* CENTER: funnel + agents */}
        <div className="flex min-w-0 flex-col">
          <div className="border-b border-line px-[22px] py-[18px]">
            <div className="mb-3 flex items-baseline gap-3">
              <h3 className="caps-sm m-0 font-semibold text-ink-2">Pipeline funnel</h3>
              <span className="font-mono text-xs text-ink-3">n={total.toLocaleString()}</span>
              <span className="ml-auto text-xs text-ink-3">
                conv rate <span className="mono text-ink">{overallConv}</span>
              </span>
            </div>
            {funnel.map((s, i) => (
              <FunnelRow key={s.label} label={s.label} value={s.v} pct={s.pct} index={i} />
            ))}
          </div>

          <div className="flex-1 px-[22px] py-3.5">
            <div className="mb-2.5 flex items-baseline gap-2.5">
              <h3 className="caps-sm m-0 font-semibold text-ink-2">Your fleet</h3>
              <span className="text-xs text-ink-3">
                Seven agents operate the pipeline: discovery, enrichment, scoring, outreach, reply,
                action, and the master.
              </span>
            </div>
            <div className="grid grid-cols-2 gap-3">
              {(agents ?? []).slice(0, 6).map((a) => (
                <AgentTile key={a.id} agent={a} />
              ))}
              {(agents ?? []).length === 0 && (
                <div className="col-span-2 rounded-[3px] border border-dashed border-line bg-bg-sub p-[18px] text-center text-xs text-ink-3">
                  No agents deployed yet.{' '}
                  <Link href="/agents/new" className="text-accent-fg">
                    Deploy your first agent →
                  </Link>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* RIGHT: Live agent console */}
        <div className="hairline-l flex min-w-0 flex-col bg-bg-sub">
          <div className="flex items-center gap-2 border-b border-line px-3.5 py-3">
            <Icon name="radio" size={13} className="text-accent" />
            <div className="caps-sm font-semibold text-ink-2">Agent console</div>
            <span className="ml-auto font-mono text-2xs text-ink-3">tail -f</span>
          </div>
          <div className="flex-1 overflow-auto">
            {feed.length === 0 && eventFeed.length === 0 && (
              <div className="p-[18px] text-xs text-ink-3">
                Waiting for agents to come online…
              </div>
            )}
            {feed.map((m) => {
              const ts = new Date(m.createdAt);
              const t =
                String(ts.getHours()).padStart(2, '0') +
                ':' +
                String(ts.getMinutes()).padStart(2, '0') +
                ':' +
                String(ts.getSeconds()).padStart(2, '0');
              const text =
                typeof m.content === 'object' && m.content
                  ? String(
                      (m.content as Record<string, unknown>).text ??
                        (m.content as Record<string, unknown>).message ??
                        JSON.stringify(m.content).slice(0, 120),
                    )
                  : String(m.content);
              return (
                <StreamRow
                  key={m.id}
                  ts={t}
                  agent={m.fromAgent}
                  tag={m.messageType?.toUpperCase().slice(0, 6)}
                  message={text}
                />
              );
            })}
            {feed.length === 0 &&
              eventFeed.slice(0, 20).map((e, i) => {
                const d = new Date(e.timestamp);
                const t =
                  String(d.getHours()).padStart(2, '0') +
                  ':' +
                  String(d.getMinutes()).padStart(2, '0') +
                  ':' +
                  String(d.getSeconds()).padStart(2, '0');
                return (
                  <StreamRow
                    key={i}
                    ts={t}
                    agent={e.agentType ?? 'system'}
                    tag={e.event.split(':').pop()?.toUpperCase().slice(0, 6)}
                    message={JSON.stringify(e.data).slice(0, 120)}
                  />
                );
              })}
          </div>
        </div>
      </div>
    </div>
  );
}
