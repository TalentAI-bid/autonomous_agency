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
import { Panel, PanelBody, PanelHead } from '@/components/ui/panel';
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
    <Panel style={{ cursor: 'pointer' }} onClick={() => router.push(`/agents/${agent.id}`)}>
      <PanelHead>
        <Dot state={agent.status === 'running' ? 'live' : agent.status === 'error' ? 'warn' : 'paused'} />
        <h3
          style={{
            textTransform: 'none',
            letterSpacing: '-0.005em',
            fontSize: 12.5,
            fontWeight: 500,
            color: 'var(--ink)',
            margin: 0,
          }}
        >
          {agent.name}
        </h3>
        <span className="meta">{agent.useCase}</span>
      </PanelHead>
      <PanelBody style={{ padding: 12 }}>
        <div style={{ display: 'flex', alignItems: 'end', gap: 14, marginBottom: 10 }}>
          <div>
            <div
              style={{
                fontSize: 10,
                color: 'var(--ink-3)',
                textTransform: 'uppercase',
                letterSpacing: '0.08em',
                marginBottom: 2,
              }}
            >
              Status
            </div>
            <div className="mono" style={{ fontSize: 14, fontWeight: 500, lineHeight: 1 }}>
              {agent.status}
            </div>
          </div>
          <div style={{ marginLeft: 'auto' }}>
            <Spark
              data={[2, 3, 4, 5, 4, 6, 7, 6, 8, 9, 10, 11]}
              width={100}
              height={30}
              color="var(--accent)"
              fill
            />
          </div>
        </div>

        <div style={{ display: 'flex', gap: 4 }}>
          {LANES.map((lane) => {
            const on = activeLanes.includes(lane);
            return (
              <div
                key={lane}
                title={lane}
                style={{
                  flex: 1,
                  height: 6,
                  borderRadius: 1,
                  background: on ? `var(--a-${lane})` : 'var(--bg-soft)',
                  opacity: on ? 1 : 0.6,
                  border: '1px solid ' + (on ? 'transparent' : 'var(--line)'),
                }}
              />
            );
          })}
        </div>
        <div style={{ display: 'flex', gap: 4, marginTop: 3 }}>
          {LANES.map((lane) => (
            <div
              key={lane}
              style={{
                flex: 1,
                fontSize: 9,
                textAlign: 'center',
                color: 'var(--ink-3)',
                textTransform: 'uppercase',
                letterSpacing: '0.04em',
              }}
            >
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

  return (
    <div className="page">
      <div className="page-head" style={{ paddingBottom: 18 }}>
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
          <button className="btn" type="button">
            <Icon name="filter" /> Filters
          </button>
          <button className="btn" type="button">
            <Icon name="calendar" /> Today
          </button>
          <Link href="/agents/new" className="btn is-primary">
            <Icon name="plus" /> Deploy agent
          </Link>
        </div>
      </div>

      {/* KPI row */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(5, 1fr)',
          borderBottom: '1px solid var(--line)',
        }}
      >
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
      <div style={{ display: 'grid', gridTemplateColumns: '320px 1fr 360px', minHeight: 560 }}>
        {/* LEFT: Live lead stream */}
        <div
          className="hairline-r"
          style={{ display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0 }}
        >
          <div
            style={{
              padding: '12px 14px',
              borderBottom: '1px solid var(--line)',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              background: 'var(--bg-sub)',
            }}
          >
            <Dot state="live" />
            <div className="caps-sm" style={{ color: 'var(--ink-2)', fontWeight: 600 }}>
              Live lead stream
            </div>
            <span
              style={{
                marginLeft: 'auto',
                fontFamily: 'var(--ff-mono)',
                fontSize: 10,
                color: 'var(--ink-3)',
              }}
            >
              {contacts.length} · streaming
            </span>
          </div>
          <div style={{ overflow: 'auto', minHeight: 0, flex: 1 }}>
            {contacts.length === 0 && (
              <div style={{ padding: '18px', fontSize: 12, color: 'var(--ink-3)' }}>
                No leads yet. Deploy an agent to start streaming.
              </div>
            )}
            {contacts.map((c, i) => {
              const name = [c.firstName, c.lastName].filter(Boolean).join(' ') || c.email || 'Lead';
              const score = c.score ?? 0;
              return (
                <Link
                  key={c.id}
                  href={`/contacts/${c.id}`}
                  style={{
                    padding: '10px 14px',
                    borderBottom: '1px solid var(--line)',
                    display: 'grid',
                    gridTemplateColumns: '28px 1fr auto',
                    gap: 10,
                    alignItems: 'center',
                    animation: i === 0 ? 'slide-in 0.4s ease-out' : undefined,
                    background: i === 0 ? 'var(--accent-weak)' : 'transparent',
                    textDecoration: 'none',
                    color: 'inherit',
                  }}
                >
                  <div
                    className="avatar"
                    style={{
                      background: `oklch(0.65 0.10 ${(name.charCodeAt(0) * 7) % 360})`,
                      width: 28,
                      height: 28,
                      fontSize: 10,
                    }}
                  >
                    {initials(c)}
                  </div>
                  <div style={{ minWidth: 0 }}>
                    <div
                      style={{
                        fontSize: 12.5,
                        fontWeight: 500,
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                      }}
                    >
                      {name}
                    </div>
                    <div
                      style={{
                        fontSize: 10.5,
                        color: 'var(--ink-3)',
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                      }}
                    >
                      {c.title ?? '—'} · {c.companyName ?? '—'}
                    </div>
                  </div>
                  <div
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'flex-end',
                      gap: 2,
                    }}
                  >
                    <div
                      className="mono"
                      style={{
                        fontSize: 11,
                        fontWeight: 600,
                        color:
                          score >= 85 ? 'var(--up)' : score >= 65 ? 'var(--ink)' : 'var(--ink-3)',
                      }}
                    >
                      {score || '—'}
                    </div>
                  </div>
                </Link>
              );
            })}
          </div>
        </div>

        {/* CENTER: funnel + agents */}
        <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column' }}>
          <div style={{ padding: '18px 22px', borderBottom: '1px solid var(--line)' }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 12 }}>
              <h3
                className="caps-sm"
                style={{ margin: 0, color: 'var(--ink-2)', fontWeight: 600 }}
              >
                Pipeline funnel
              </h3>
              <span style={{ fontSize: 11, color: 'var(--ink-3)', fontFamily: 'var(--ff-mono)' }}>
                n={total.toLocaleString()}
              </span>
              <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--ink-3)' }}>
                conv rate <span className="mono" style={{ color: 'var(--ink)' }}>{overallConv}</span>
              </span>
            </div>
            {funnel.map((s, i) => (
              <FunnelRow key={s.label} label={s.label} value={s.v} pct={s.pct} index={i} />
            ))}
          </div>

          <div style={{ padding: '14px 22px', flex: 1 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 10 }}>
              <h3
                className="caps-sm"
                style={{ margin: 0, color: 'var(--ink-2)', fontWeight: 600 }}
              >
                Your fleet
              </h3>
              <span style={{ fontSize: 11, color: 'var(--ink-3)' }}>
                Seven agents operate the pipeline: discovery, enrichment, scoring, outreach, reply,
                action, and the master.
              </span>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              {(agents ?? []).slice(0, 6).map((a) => (
                <AgentTile key={a.id} agent={a} />
              ))}
              {(agents ?? []).length === 0 && (
                <div
                  style={{
                    gridColumn: 'span 2',
                    padding: 18,
                    border: '1px dashed var(--line)',
                    borderRadius: 3,
                    background: 'var(--bg-sub)',
                    color: 'var(--ink-3)',
                    fontSize: 12,
                    textAlign: 'center',
                  }}
                >
                  No agents deployed yet.{' '}
                  <Link href="/agents/new" style={{ color: 'var(--accent-fg)' }}>
                    Deploy your first agent →
                  </Link>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* RIGHT: Live agent console */}
        <div
          className="hairline-l"
          style={{
            display: 'flex',
            flexDirection: 'column',
            minWidth: 0,
            background: 'var(--bg-sub)',
          }}
        >
          <div
            style={{
              padding: '12px 14px',
              borderBottom: '1px solid var(--line)',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
            }}
          >
            <Icon name="radio" size={13} style={{ color: 'var(--accent)' }} />
            <div className="caps-sm" style={{ color: 'var(--ink-2)', fontWeight: 600 }}>
              Agent console
            </div>
            <span
              style={{
                marginLeft: 'auto',
                fontFamily: 'var(--ff-mono)',
                fontSize: 10,
                color: 'var(--ink-3)',
              }}
            >
              tail -f
            </span>
          </div>
          <div style={{ overflow: 'auto', flex: 1 }}>
            {feed.length === 0 && eventFeed.length === 0 && (
              <div style={{ padding: 18, fontSize: 12, color: 'var(--ink-3)' }}>
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
