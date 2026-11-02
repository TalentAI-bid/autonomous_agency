import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/** Card with a title strip, used by the list-style agent tabs. */
export function ListPanel({
  title,
  count,
  empty,
  isEmpty,
  scroll,
  children,
}: {
  title: string;
  count?: number;
  empty: ReactNode;
  isEmpty: boolean;
  scroll?: boolean;
  children: ReactNode;
}) {
  return (
    <section className="overflow-hidden rounded-2xl border border-line bg-bg-panel shadow-sm">
      <header className="flex items-center gap-2 border-b border-line px-5 py-3.5">
        <h2 className="m-0 text-body font-semibold text-ink">{title}</h2>
        {count !== undefined && <span className="rounded-tag bg-bg-soft px-1.5 font-mono text-2xs leading-[18px] text-ink-3">{count}</span>}
      </header>
      {isEmpty ? (
        <p className="m-0 px-5 py-10 text-center text-body text-ink-3">{empty}</p>
      ) : (
        <ul className={cn('m-0 list-none divide-y divide-line p-0', scroll && 'scroll-thin max-h-[520px] overflow-y-auto')}>{children}</ul>
      )}
    </section>
  );
}

export function ListRow({ title, sub, aside, className }: { title: ReactNode; sub?: ReactNode; aside?: ReactNode; className?: string }) {
  return (
    <div className={cn('flex items-center justify-between gap-4 px-5 py-3 transition-colors hover:bg-bg-soft', className)}>
      <div className="min-w-0">
        <div className="truncate text-body font-medium text-ink">{title}</div>
        {sub && <div className="truncate text-xs text-ink-3">{sub}</div>}
      </div>
      {aside && <div className="flex shrink-0 items-center gap-2">{aside}</div>}
    </div>
  );
}
