'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Check } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { numberWord, useGetStarted, type GetStartedStep } from '@/hooks/use-get-started';

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** "It still says [TOKEN]. …" → text with the token as a code chip. */
function PendingText({ step }: { step: GetStartedStep }) {
  if (!step.token || !step.pending.includes(step.token)) return <>{step.pending}</>;
  const [before, after] = step.pending.split(step.token);
  return (
    <>
      {before}
      <code className="rounded-tag bg-bg-soft px-1.5 py-0.5 font-mono text-xs text-ink-2">{step.token}</code>
      {after}
    </>
  );
}

function Marker({ index, done, current }: { index: number; done: boolean; current: boolean }) {
  return (
    <span
      className={cn(
        'relative z-10 grid size-7 shrink-0 place-items-center rounded-full border text-xs font-medium',
        done && 'border-up/30 bg-up/10 text-up',
        current && 'border-accent-mid bg-accent-weak text-accent-fg',
        !done && !current && 'border-line bg-bg-panel text-ink-4',
      )}
    >
      {done ? <Check size={14} strokeWidth={2.5} /> : index + 1}
    </span>
  );
}

export default function GetStartedPage() {
  const router = useRouter();
  const gs = useGetStarted();

  // The page disappears once every step is done.
  useEffect(() => {
    if (!gs.isLoading && gs.allDone) router.replace('/dashboard');
  }, [gs.isLoading, gs.allDone, router]);

  if (gs.isLoading) {
    return (
      <div className="mx-auto max-w-[1100px] p-6">
        <Skeleton className="h-[520px] rounded-2xl" />
      </div>
    );
  }

  const left = gs.remaining;

  return (
    <div className="mx-auto max-w-[1100px] p-6">
      <section className="rounded-2xl border border-line bg-bg-panel px-9 py-9 shadow-sm">
        <h1 className="m-0 font-display text-[34px] font-normal leading-[1.1] tracking-[-0.01em] text-ink">
          {left === 1 ? 'One step left' : `${cap(numberWord(left))} steps left`} before your first message
        </h1>
        <p className="mb-8 mt-3 max-w-[560px] text-body leading-relaxed text-ink-3">
          Keenpipe sends nothing on its own. When step six is done, the first drafts appear in Approvals and wait for you.
        </p>

        <ol className="m-0 list-none p-0">
          {gs.steps.map((s, i) => {
            const current = i === gs.currentIndex;
            const last = i === gs.steps.length - 1;
            return (
              <li key={s.key} className={cn('relative flex gap-4', !last && 'pb-7')}>
                {!last && <span className="absolute left-[13px] top-7 h-[calc(100%-1.75rem)] w-px bg-line" aria-hidden="true" />}
                <Marker index={i} done={s.done} current={current} />
                <div className="min-w-0 flex-1 pt-0.5">
                  <div className="flex items-baseline justify-between gap-4">
                    <div
                      className={cn(
                        'text-body font-medium',
                        s.done ? 'text-ink-3' : current ? 'text-ink' : 'text-ink-3',
                      )}
                    >
                      {s.title}
                    </div>
                    <span
                      className={cn(
                        'shrink-0 text-2xs font-medium uppercase tracking-[0.09em]',
                        s.done ? 'text-ink-4' : current ? 'text-accent' : 'invisible',
                      )}
                    >
                      {s.done ? 'Done' : 'Now'}
                    </span>
                  </div>
                  <div className={cn('mt-1 text-body', current ? 'text-ink-2' : 'text-ink-3')}>
                    {s.done ? s.doneText : <PendingText step={s} />}
                  </div>
                  {current && (
                    <Button asChild variant="brand" size="dense" className="mt-4 h-9 rounded-lg px-4 text-body font-semibold">
                      <Link href={s.href}>{s.cta}</Link>
                    </Button>
                  )}
                </div>
              </li>
            );
          })}
        </ol>

        <div className="mt-8 flex items-center justify-between border-t border-line pt-5">
          <span className="font-mono text-xs text-ink-3">
            {cap(numberWord(gs.doneCount))} of {numberWord(gs.total)} done
          </span>
          <Link href="/dashboard" className="rounded-md px-2 py-1 text-body font-medium text-ink hover:bg-bg-soft">
            Skip for now
          </Link>
        </div>
      </section>
    </div>
  );
}
