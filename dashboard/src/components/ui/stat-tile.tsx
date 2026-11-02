import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

type Tone = 'default' | 'up' | 'warn';

/** Small bordered tile: caps label, big value, one-line caption. */
export function StatTile({ label, value, sub, tone = 'default' }: { label: string; value: ReactNode; sub?: ReactNode; tone?: Tone }) {
  return (
    <div className="min-w-0 rounded-row border border-line bg-bg-panel px-4 py-3.5">
      <div className="text-3xs font-medium uppercase tracking-[0.09em] text-ink-4">{label}</div>
      <div className={cn('mt-1.5 text-title font-semibold', tone === 'up' && 'text-up', tone === 'warn' && 'text-warn-fg', tone === 'default' && 'text-ink')}>
        {value}
      </div>
      {sub != null && <div className="mt-0.5 truncate text-xs text-ink-3">{sub}</div>}
    </div>
  );
}
