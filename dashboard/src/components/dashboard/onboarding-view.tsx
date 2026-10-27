'use client';

import Link from 'next/link';
import {
  Check,
  CheckSquare,
  ChevronRight,
  Inbox,
  Mail,
  Puzzle,
  Rocket,
  Search,
  Sparkles,
} from 'lucide-react';
import { useSetupStatus, type SetupSteps } from '@/hooks/use-setup-status';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { HomeSection, StatusPill } from '@/components/home/home-parts';

/* Empty-state Home: shown until the first agent is deployed. */

interface Step {
  key: keyof SetupSteps;
  title: string;
  desc: string;
  icon: React.ReactNode;
  href: string;
  cta: string;
  /** shown as a warning pill while not done */
  required?: string;
}

const STEPS: Step[] = [
  {
    key: 'company',
    title: 'Company profile',
    desc: 'Tell agents who you are and what you sell, so drafts sound like you.',
    icon: <Sparkles size={15} />,
    href: '/settings/company',
    cta: 'Set up',
  },
  {
    key: 'mailbox',
    title: 'Connect a mailbox',
    desc: 'Approved emails are sent from here, and replies come back to it.',
    icon: <Mail size={15} />,
    href: '/settings/email',
    cta: 'Connect',
  },
  {
    key: 'extension',
    title: 'Install the LinkedIn extension',
    desc: 'Lets agents find people and send connection requests from your Chrome.',
    icon: <Puzzle size={15} />,
    href: '/linkedin-extension',
    cta: 'Install',
    required: 'Required to run agents',
  },
  {
    key: 'agent',
    title: 'Deploy your first agent',
    desc: 'Describe who you want to reach and let it run. You approve before anything sends.',
    icon: <Rocket size={15} />,
    href: '/agents/new',
    cta: 'Deploy',
  },
];

const HOW_IT_WORKS = [
  { icon: <Search size={16} />, title: 'Agents find people', text: 'They search for leads that match what you describe, then check they are real and reachable.' },
  { icon: <CheckSquare size={16} />, title: 'You approve the drafts', text: 'Every message waits in your queue. Nothing sends until you say so.' },
  { icon: <Inbox size={16} />, title: 'Replies land in your Inbox', text: 'Answers are picked up for you, so you can reply and book the meeting.' },
];

function StepMarker({ index, done, warn }: { index: number; done: boolean; warn: boolean }) {
  return (
    <span
      className={cn(
        'grid size-7 shrink-0 place-items-center rounded-full border font-mono text-xs font-semibold',
        done
          ? 'border-accent bg-accent text-white'
          : warn
            ? 'border-warn/40 bg-warn/15 text-warn-fg'
            : 'border-line-strong bg-bg-panel text-ink-2',
      )}
    >
      {done ? <Check size={14} strokeWidth={3} /> : index + 1}
    </span>
  );
}

export function OnboardingView() {
  const { steps, completedCount } = useSetupStatus();
  const total = STEPS.length;
  const pct = (completedCount / total) * 100;

  return (
    <div className="mx-auto flex max-w-[940px] flex-col gap-4 p-5">
      {/* Hero */}
      <section className="rounded-xl border border-accent-line bg-accent-tint p-6 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-5">
          <div className="min-w-0 max-w-[560px]">
            <span className="inline-flex items-center gap-1.5 rounded-md bg-accent-weak px-2 py-0.5 text-xs font-medium text-accent-fg">
              <Sparkles size={12} />
              Setup in progress
            </span>
            <h1 className="mb-1.5 mt-3 text-[26px] font-semibold leading-tight tracking-[-0.02em] text-ink">
              Let&apos;s get your first agent live
            </h1>
            <p className="m-0 text-body text-ink-2">
              Four short steps and your agents start finding people to reach. Nothing is sent to anyone until you approve it.
            </p>
          </div>
          <Button asChild variant="brand" size="dense" className="h-9 rounded-lg px-4 text-body font-semibold">
            <Link href="/agents/new">
              <Rocket size={14} /> Deploy agent
            </Link>
          </Button>
        </div>

        <div className="mt-5 flex items-center gap-3">
          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-bg-panel">
            <div className="h-full rounded-full bg-accent transition-[width] duration-300 ease-in-out" style={{ width: `${pct}%` }} />
          </div>
          <span className="font-mono text-xs text-ink-2">
            {completedCount} of {total} done
          </span>
        </div>
      </section>

      {/* Checklist */}
      <HomeSection title="Get set up" meta={`${completedCount} of ${total} complete`}>
        {STEPS.map((s, i) => {
          const done = !!steps[s.key];
          const warn = !done && !!s.required;
          const primary = s.key === 'agent';
          return (
            <div key={s.key} className={cn('flex items-center gap-3 border-t border-line px-4 py-3.5', warn && 'bg-warn/5')}>
              <StepMarker index={i} done={done} warn={warn} />
              <span className="grid size-8 shrink-0 place-items-center rounded-full bg-bg-soft text-ink-3">{s.icon}</span>
              <div className="min-w-0 flex-1">
                <div className={cn('text-body font-medium', done ? 'text-ink-3' : 'text-ink')}>{s.title}</div>
                <div className="truncate text-xs text-ink-3">{s.desc}</div>
              </div>
              {done ? (
                <StatusPill tone="up">Done</StatusPill>
              ) : (
                <>
                  {warn && <StatusPill tone="warn">{s.required}</StatusPill>}
                  <Button
                    asChild
                    variant={primary ? 'brand' : 'panel'}
                    size="dense"
                    className="h-8 shrink-0 rounded-lg px-3.5 text-body font-medium"
                  >
                    <Link href={s.href} aria-label={s.title}>
                      {s.cta}
                      {!primary && <ChevronRight size={14} className="-mr-1" />}
                    </Link>
                  </Button>
                </>
              )}
            </div>
          );
        })}
      </HomeSection>

      {/* How it works */}
      <HomeSection title="How it works">
        <div className="grid gap-px border-t border-line bg-line sm:grid-cols-3">
          {HOW_IT_WORKS.map((h, i) => (
            <div key={h.title} className="bg-bg-panel p-4">
              <div className="mb-3 flex items-center gap-2">
                <span className="grid size-8 place-items-center rounded-full bg-accent-weak text-accent">{h.icon}</span>
                <span className="font-mono text-xs text-ink-4">0{i + 1}</span>
              </div>
              <div className="text-body font-semibold text-ink">{h.title}</div>
              <p className="m-0 mt-1 text-xs leading-relaxed text-ink-3">{h.text}</p>
            </div>
          ))}
        </div>
      </HomeSection>
    </div>
  );
}
