'use client';

import Link from 'next/link';
import { Card } from '@/components/ui/card';
import { CheckCircle2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { numberWord, useGetStarted } from '@/hooks/use-get-started';

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * Empty-state Home, shown until the first agent exists. It only points at the
 * Get started page — the checklist itself lives there.
 */
export function OnboardingView() {
  const gs = useGetStarted();
  const minutes = Math.max(1, Math.round(gs.remaining * 2.5));

  if (gs.isLoading) {
    return (
      <div className="mx-auto max-w-[1100px] p-6">
        <Skeleton className="h-[240px] rounded-2xl" />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-[1100px] p-6">
      <Card as="section" className="p-8">
        <span className="grid size-10 place-items-center rounded-full bg-accent-weak text-accent">
          <CheckCircle2 size={18} />
        </span>
        <h1 className="mb-0 mt-5 font-display text-[30px] font-normal leading-tight tracking-[-0.01em] text-ink">
          Nothing is running yet
        </h1>
        <p className="mb-6 mt-3 max-w-[560px] text-body leading-relaxed text-ink-3">
          {cap(numberWord(gs.doneCount))} of {numberWord(gs.total)} setup steps {gs.doneCount === 1 ? 'is' : 'are'} done. Finish the other{' '}
          {numberWord(gs.remaining)} and your first drafts are waiting here the next morning — nothing sends until you approve them.
        </p>
        <div className="flex items-center gap-4">
          <Button size="lg" asChild variant="brand">
            <Link href="/get-started">Finish setting up</Link>
          </Button>
          <span className="text-xs text-ink-3">About {minutes} minutes</span>
        </div>
      </Card>
    </div>
  );
}
