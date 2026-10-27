import Link from 'next/link';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';

/** White rounded card with a titled header and optional right-hand meta. */
export function HomeSection({
  title,
  meta,
  children,
  className,
}: {
  title: ReactNode;
  meta?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn('overflow-hidden rounded-xl border border-line bg-bg-panel shadow-sm', className)}>
      <header className="flex h-11 items-center justify-between gap-3 px-4">
        <h2 className="m-0 text-body font-semibold text-ink">{title}</h2>
        {meta && <div className="text-xs text-ink-3">{meta}</div>}
      </header>
      <div>{children}</div>
    </section>
  );
}

export function HomeAction({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Button asChild variant="panel" size="dense" className="h-8 shrink-0 rounded-lg px-3.5 text-body font-medium">
      <Link href={href}>{children}</Link>
    </Button>
  );
}

/** Round leading icon used by every row. */
export function RowIcon({ tone = 'accent', children }: { tone?: 'accent' | 'warn' | 'muted'; children: ReactNode }) {
  return (
    <span
      className={cn(
        'grid size-8 shrink-0 place-items-center rounded-full',
        tone === 'accent' && 'bg-accent-weak text-accent',
        tone === 'warn' && 'bg-warn/15 text-warn-fg',
        tone === 'muted' && 'bg-bg-soft text-ink-3',
      )}
    >
      {children}
    </span>
  );
}

export function StatusPill({
  tone,
  children,
}: {
  tone: 'warn' | 'muted' | 'up' | 'down';
  children: ReactNode;
}) {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-2 py-0.5 text-xs font-medium',
        tone === 'warn' && 'bg-warn/15 text-warn-fg',
        tone === 'muted' && 'bg-bg-soft text-ink-3',
        tone === 'up' && 'bg-up/10 text-up',
        tone === 'down' && 'bg-down/10 text-down',
      )}
    >
      <span
        className={cn(
          'size-1.5 rounded-full',
          tone === 'warn' && 'bg-warn',
          tone === 'muted' && 'bg-ink-4',
          tone === 'up' && 'bg-up',
          tone === 'down' && 'bg-down',
        )}
      />
      {children}
    </span>
  );
}

/** Small stat card: caps label, big value (with a lighter "of N" tail), detail line. */
export function StatCard({
  label,
  value,
  tail,
  detail,
  muted,
}: {
  label: string;
  value: ReactNode;
  tail?: ReactNode;
  detail?: ReactNode;
  muted?: boolean;
}) {
  return (
    <div className="rounded-xl border border-line bg-bg-panel p-4 shadow-sm">
      <div className="text-2xs font-medium uppercase tracking-[0.09em] text-ink-4">{label}</div>
      <div className={cn('mt-2 flex items-baseline gap-1.5 text-[18px] font-semibold leading-none', muted ? 'text-ink-4' : 'text-ink')}>
        <span>{value}</span>
        {tail && <span className={cn('text-[18px] font-semibold', muted ? 'text-ink-4' : 'text-ink')}>{tail}</span>}
      </div>
      {detail && <div className="mt-2.5 text-xs text-ink-3">{detail}</div>}
    </div>
  );
}
