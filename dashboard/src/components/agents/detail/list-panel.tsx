import type { ReactNode } from 'react';
import { CardSection } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
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
    <CardSection
      layout="bare"
      title={
        <span className="flex items-center gap-2">
          {title}
          {count !== undefined && <Badge variant="muted" size="sm" className="font-mono">{count}</Badge>}
        </span>
      }
    >
      {isEmpty ? (
        <p className="m-0 px-5 py-10 text-center text-body text-ink-3">{empty}</p>
      ) : (
        <ul className={cn('m-0 list-none divide-y divide-line p-0', scroll && 'scroll-thin max-h-[520px] overflow-y-auto')}>{children}</ul>
      )}
    </CardSection>
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
