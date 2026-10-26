'use client';

import Link from 'next/link';
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

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
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
    <div className="flex min-w-[150px] items-center gap-2.5 rounded-lg border border-line bg-bg-panel px-3.5 py-2.5">
      <span className="grid place-items-center text-ink-3">{icon}</span>
      <div className="min-w-0">
        <div className="caps-sm text-ink-3">{label}</div>
        <div className="mono text-base font-semibold leading-[1.1] text-ink">{value}</div>
      </div>
    </div>
  );
}

/* ── Get-set-up checklist row ─────────────────────────────────────────── */
type RowKind = 'done' | 'active' | 'warn' | 'locked';

const CIRCLE: Record<RowKind, string> = {
  done: 'border-accent bg-accent text-white',
  active: 'border-line-strong bg-bg-panel text-ink-2',
  warn: 'border-warn/40 bg-warn-weak text-warn',
  locked: 'border-line bg-bg-soft text-ink-4',
};

const SUB_TONE = { up: 'text-accent-fg', warn: 'text-warn', muted: 'text-ink-3' } as const;

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
  return (
    <div
      className={cn(
        'flex items-center gap-3 px-4 py-3.5',
        index !== 0 && 'border-t border-line',
        kind === 'warn' && 'bg-warn/5',
      )}
    >
      <span
        className={cn(
          'grid h-[26px] w-[26px] shrink-0 place-items-center rounded-full border font-mono text-xs font-semibold',
          CIRCLE[kind],
        )}
      >
        {kind === 'done' ? <Check size={14} strokeWidth={3} /> : kind === 'locked' ? <Lock size={13} /> : index + 1}
      </span>
      <span className={cn('grid place-items-center', kind === 'locked' ? 'text-ink-4' : 'text-ink-3')}>{icon}</span>
      <div className="min-w-0 flex-1">
        <div className={cn('text-[13.5px] font-medium', kind === 'locked' ? 'text-ink-3' : 'text-ink')}>
          {title}
          {sub && <span className={cn('ml-2 text-xs font-medium', SUB_TONE[sub.tone])}>— {sub.text}</span>}
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
      <div className="min-w-0 text-center">
        <div className="caps-sm mb-1.5 text-ink-3">{label}</div>
        <div className="mono text-stat font-semibold leading-none text-ink-2">0</div>
        <div className="mono mt-1 text-xs text-ink-4">0%</div>
      </div>
      {!last && <ChevronRight size={16} className="mt-[22px] shrink-0 self-start text-ink-5"/>}
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
    <div className="page mx-auto max-w-[1120px] px-6 py-5">
      {/* Top strip: status pill · stat cards · deploy CTA */}
      <div className="mb-7 flex flex-wrap items-center gap-3">
        <span className="pill inline-flex items-center gap-[7px] border-warn/30 bg-warn-weak text-warn">
          <Sparkles size={12} />
          Setup in progress
        </span>

        <div className="flex flex-wrap gap-2.5">
          <StatCard icon={<Users size={16} />} label="Active agents" value={runningAgents} />
          <StatCard icon={<Sparkles size={16} />} label="Leads" value={dash(leads)} />
          <StatCard icon={<MessageSquare size={16} />} label="Reply rate" value={replyRate} />
          <StatCard icon={<CalendarCheck size={16} />} label="Meetings" value={dash(meetings)} />
        </div>

        <div className="ml-auto">
          {canDeploy ? (
            <Button asChild variant="brand" size="dense"><Link href="/agents/new">
              <Rocket size={14} /> Deploy agent
            </Link></Button>
          ) : (
            <Button variant="panel" size="dense" type="button" disabled title="Finish setup to deploy">
              <Rocket size={14} /> Deploy agent
            </Button>
          )}
        </div>
      </div>

      {/* Hero */}
      <h1 className="display mb-6 mt-0 text-hero font-normal tracking-[-0.02em]">
        Let&apos;s get your first agent live
      </h1>

      {/* Get set up */}
      <div className="panel mb-5">
        <div className="px-4 pb-3.5 pt-4">
          <div className="mb-3 flex items-baseline">
            <h2 className="m-0 text-title font-semibold text-ink">Get set up</h2>
            <span className="mono ml-auto text-xs text-ink-3">{completedCount} of 4 complete</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full border border-line bg-bg-soft">
            <div
              className="h-full bg-accent transition-[width] duration-300 ease-in-out"
              style={{ width: `${progressPct}%` }}
            />
          </div>
        </div>

        <div className="border-t border-line">
          <ChecklistRow
            index={0}
            title="Company profile"
            icon={<Sparkles size={16} />}
            kind={rowFor('company')}
            sub={steps.company ? { text: 'Done', tone: 'up' } : undefined}
            action={
              !steps.company && (
                <Button asChild variant="panel" size="xs"><Link href="/settings/company">
                  Set up
                </Link></Button>
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
                <Button asChild variant="brand" size="xs"><Link href="/settings/email">
                  Connect
                </Link></Button>
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
                <Button asChild variant="panel" size="xs"><Link href="/linkedin-extension" className="pr-1.5" aria-label="Install the LinkedIn extension">
                  Install <ChevronRight size={14} />
                </Link></Button>
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
                <Button asChild variant="brand" size="xs"><Link href="/agents/new">
                  Deploy
                </Link></Button>
              ) : (
                <span className="grid place-items-center text-ink-4">
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
        <div className="px-[22px] pb-1.5 pt-5">
          <div className="flex items-start justify-between gap-2">
            {FUNNEL_STAGES.map((s, i) => (
              <FunnelCell key={s} label={s} last={i === FUNNEL_STAGES.length - 1} />
            ))}
          </div>
        </div>
        <div className="flex flex-col items-center gap-1.5 pb-7 pt-[18px] text-ink-4">
          <Filter size={26} strokeWidth={1.5} className="opacity-50"/>
          <span className="text-[12.5px] text-ink-3">Your funnel fills as agents run</span>
        </div>
      </div>
    </div>
  );
}
