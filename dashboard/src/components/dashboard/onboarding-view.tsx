'use client';

import Link from 'next/link';
import type { CSSProperties } from 'react';
import {
  Rocket,
  Check,
  Lock,
  Mail,
  Puzzle,
  ChevronRight,
  Users,
  Sparkles,
  MessageSquare,
  CalendarCheck,
  Filter,
} from 'lucide-react';
import { useSetupStatus, type SetupSteps } from '@/hooks/use-setup-status';
import { useDashboardAnalytics } from '@/hooks/use-analytics';

/* ── Top-strip stat card ──────────────────────────────────────────────── */
function StatCard({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: string | number;
}) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '10px 14px',
        background: 'var(--bg-panel)',
        border: '1px solid var(--line)',
        borderRadius: 'var(--radius)',
        minWidth: 150,
      }}
    >
      <span style={{ color: 'var(--ink-3)', display: 'grid', placeItems: 'center' }}>{icon}</span>
      <div style={{ minWidth: 0 }}>
        <div className="caps-sm" style={{ color: 'var(--ink-3)' }}>
          {label}
        </div>
        <div className="mono" style={{ fontSize: 16, fontWeight: 600, color: 'var(--ink)', lineHeight: 1.1 }}>
          {value}
        </div>
      </div>
    </div>
  );
}

/* ── Get-set-up checklist row ─────────────────────────────────────────── */
type RowKind = 'done' | 'active' | 'warn' | 'locked';

function ChecklistRow({
  index,
  title,
  kind,
  sub,
  icon,
  action,
}: {
  index: number;
  title: string;
  kind: RowKind;
  sub?: { text: string; tone: 'muted' | 'up' | 'warn' };
  icon: React.ReactNode;
  action?: React.ReactNode;
}) {
  const circle: Record<RowKind, CSSProperties> = {
    done: { background: 'var(--accent)', color: '#fff', border: '1px solid var(--accent)' },
    active: { background: 'var(--bg-panel)', color: 'var(--ink-2)', border: '1px solid var(--line-strong)' },
    warn: {
      background: 'var(--warn-weak)',
      color: 'var(--warn)',
      border: '1px solid color-mix(in oklch, var(--warn) 40%, transparent)',
    },
    locked: { background: 'var(--bg-soft)', color: 'var(--ink-4)', border: '1px solid var(--line)' },
  };
  const subColor =
    sub?.tone === 'up' ? 'var(--accent-fg)' : sub?.tone === 'warn' ? 'var(--warn)' : 'var(--ink-3)';

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '14px 16px',
        borderTop: index === 0 ? 'none' : '1px solid var(--line)',
        background: kind === 'warn' ? 'color-mix(in oklch, var(--warn) 5%, transparent)' : 'transparent',
      }}
    >
      <span
        style={{
          width: 26,
          height: 26,
          borderRadius: 999,
          display: 'grid',
          placeItems: 'center',
          flexShrink: 0,
          fontSize: 12,
          fontWeight: 600,
          fontFamily: 'var(--ff-mono)',
          ...circle[kind],
        }}
      >
        {kind === 'done' ? <Check size={14} strokeWidth={3} /> : kind === 'locked' ? <Lock size={13} /> : index + 1}
      </span>
      <span style={{ color: kind === 'locked' ? 'var(--ink-4)' : 'var(--ink-3)', display: 'grid', placeItems: 'center' }}>
        {icon}
      </span>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div
          style={{
            fontSize: 13.5,
            fontWeight: 500,
            color: kind === 'locked' ? 'var(--ink-3)' : 'var(--ink)',
          }}
        >
          {title}
          {sub && (
            <span style={{ marginLeft: 8, fontSize: 12, fontWeight: 500, color: subColor }}>— {sub.text}</span>
          )}
        </div>
      </div>
      {action}
    </div>
  );
}

/* ── Pipeline-funnel stat cell ────────────────────────────────────────── */
const FUNNEL_STAGES = ['Discovered', 'Enriched', 'Scored', 'Contacted', 'Replied', 'Meetings'];

function FunnelCell({ label, last }: { label: string; last: boolean }) {
  return (
    <>
      <div style={{ textAlign: 'center', minWidth: 0 }}>
        <div className="caps-sm" style={{ color: 'var(--ink-3)', marginBottom: 6 }}>
          {label}
        </div>
        <div className="mono" style={{ fontSize: 22, fontWeight: 600, color: 'var(--ink-2)', lineHeight: 1 }}>
          0
        </div>
        <div className="mono" style={{ fontSize: 11, color: 'var(--ink-4)', marginTop: 4 }}>
          0%
        </div>
      </div>
      {!last && (
        <ChevronRight size={16} style={{ color: 'var(--ink-5)', flexShrink: 0, alignSelf: 'start', marginTop: 22 }} />
      )}
    </>
  );
}

/* ── Main onboarding view ─────────────────────────────────────────────── */
export function OnboardingView() {
  const { steps, completedCount } = useSetupStatus();
  const { data: analytics } = useDashboardAnalytics();

  const runningAgents = analytics?.masterAgents.running ?? 0;
  const leads = analytics?.contacts.total ?? 0;
  const sent = analytics?.emails.sent ?? 0;
  const replied = analytics?.emails.replied ?? 0;
  const meetings = analytics?.interviews.scheduled ?? 0;
  const replyRate = sent > 0 ? ((replied / sent) * 100).toFixed(0) + '%' : '—';
  const dash = (n: number) => (n > 0 ? n.toLocaleString() : '—');

  // Deploying is never gated on setup completeness — an agent can always be
  // created. Whether it actually RUNS is decided later by the single execution
  // gate (a connected LinkedIn extension). The checklist below stays purely
  // informational.
  const canDeploy = true;
  const progressPct = (completedCount / 4) * 100;

  // Per-step presentation, derived from the real setup state.
  const rowFor = (key: keyof SetupSteps): RowKind => {
    if (steps[key]) return 'done';
    if (key === 'extension') return 'warn';
    if (key === 'agent') return canDeploy ? 'active' : 'locked';
    return 'active';
  };

  return (
    <div className="page" style={{ padding: '20px 24px', maxWidth: 1120, margin: '0 auto' }}>
      {/* Top strip: status pill · stat cards · deploy CTA */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 28 }}>
        <span
          className="pill"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 7,
            background: 'var(--warn-weak)',
            color: 'var(--warn)',
            borderColor: 'color-mix(in oklch, var(--warn) 30%, transparent)',
          }}
        >
          <Sparkles size={12} />
          Setup in progress
        </span>

        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <StatCard icon={<Users size={16} />} label="Active agents" value={runningAgents} />
          <StatCard icon={<Sparkles size={16} />} label="Leads" value={dash(leads)} />
          <StatCard icon={<MessageSquare size={16} />} label="Reply rate" value={replyRate} />
          <StatCard icon={<CalendarCheck size={16} />} label="Meetings" value={dash(meetings)} />
        </div>

        <div style={{ marginLeft: 'auto' }}>
          {canDeploy ? (
            <Link href="/agents/new" className="btn is-accent">
              <Rocket size={14} /> Deploy agent
            </Link>
          ) : (
            <button className="btn" type="button" disabled title="Finish setup to deploy">
              <Rocket size={14} /> Deploy agent
            </button>
          )}
        </div>
      </div>

      {/* Hero */}
      <h1
        className="display"
        style={{ fontSize: 34, fontWeight: 400, letterSpacing: '-0.02em', margin: '0 0 24px' }}
      >
        Let&apos;s get your first agent live
      </h1>

      {/* Get set up */}
      <div className="panel" style={{ marginBottom: 20 }}>
        <div style={{ padding: '16px 16px 14px' }}>
          <div style={{ display: 'flex', alignItems: 'baseline', marginBottom: 12 }}>
            <h2 style={{ margin: 0, fontSize: 15, fontWeight: 600, color: 'var(--ink)' }}>Get set up</h2>
            <span className="mono" style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--ink-3)' }}>
              {completedCount} of 4 complete
            </span>
          </div>
          <div
            style={{
              height: 6,
              borderRadius: 999,
              background: 'var(--bg-soft)',
              border: '1px solid var(--line)',
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                height: '100%',
                width: `${progressPct}%`,
                background: 'var(--accent)',
                transition: 'width 300ms ease',
              }}
            />
          </div>
        </div>

        <div style={{ borderTop: '1px solid var(--line)' }}>
          <ChecklistRow
            index={0}
            title="Company profile"
            icon={<Sparkles size={16} />}
            kind={rowFor('company')}
            sub={steps.company ? { text: 'Done', tone: 'up' } : undefined}
            action={
              !steps.company && (
                <Link href="/settings/company" className="btn is-sm">
                  Set up
                </Link>
              )
            }
          />
          <ChecklistRow
            index={1}
            title="Connect a mailbox"
            icon={<Mail size={16} />}
            kind={rowFor('mailbox')}
            sub={steps.mailbox ? { text: 'Done', tone: 'up' } : undefined}
            action={
              steps.mailbox ? undefined : (
                <Link href="/settings/email" className="btn is-accent is-sm">
                  Connect
                </Link>
              )
            }
          />
          <ChecklistRow
            index={2}
            title="Install the LinkedIn extension"
            icon={<Puzzle size={16} />}
            kind={rowFor('extension')}
            sub={
              steps.extension
                ? { text: 'Done', tone: 'up' }
                : { text: 'Required to run agents', tone: 'warn' }
            }
            action={
              steps.extension ? undefined : (
                <Link
                  href="/linkedin-extension"
                  className="btn is-sm"
                  style={{ paddingRight: 6 }}
                  aria-label="Install the LinkedIn extension"
                >
                  Install <ChevronRight size={14} />
                </Link>
              )
            }
          />
          <ChecklistRow
            index={3}
            title="Deploy your first agent"
            icon={<Rocket size={16} />}
            kind={rowFor('agent')}
            action={
              canDeploy ? (
                <Link href="/agents/new" className="btn is-accent is-sm">
                  Deploy
                </Link>
              ) : (
                <span style={{ color: 'var(--ink-4)', display: 'grid', placeItems: 'center' }}>
                  <Lock size={14} />
                </span>
              )
            }
          />
        </div>
      </div>

      {/* Pipeline funnel */}
      <div className="panel">
        <div className="panel-head">
          <h3>Pipeline funnel</h3>
        </div>
        <div style={{ padding: '20px 22px 6px' }}>
          <div style={{ display: 'flex', alignItems: 'start', justifyContent: 'space-between', gap: 8 }}>
            {FUNNEL_STAGES.map((s, i) => (
              <FunnelCell key={s} label={s} last={i === FUNNEL_STAGES.length - 1} />
            ))}
          </div>
        </div>
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 6,
            padding: '18px 0 28px',
            color: 'var(--ink-4)',
          }}
        >
          <Filter size={26} strokeWidth={1.5} style={{ opacity: 0.5 }} />
          <span style={{ fontSize: 12.5, color: 'var(--ink-3)' }}>Your funnel fills as agents run</span>
        </div>
      </div>
    </div>
  );
}
