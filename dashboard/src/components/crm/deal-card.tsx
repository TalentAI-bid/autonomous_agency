'use client';

import { cn } from '@/lib/utils';
import type { DealWithContact } from '@/types';

interface DealCardProps {
  deal: DealWithContact;
  className?: string;
  onClick?: () => void;
}

const AVATAR_TONES = ['bg-accent', 'bg-ink-2', 'bg-up', 'bg-info'];

function initials(name: string): string {
  const parts = name.replace(/[@._-]+/g, ' ').trim().split(/\s+/);
  return ((parts[0]?.[0] ?? '?') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}

function tone(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return AVATAR_TONES[h % AVATAR_TONES.length];
}

export function DealCard({ deal, className, onClick }: DealCardProps) {
  const contact = deal.contact;
  const contactName = contact
    ? [contact.firstName, contact.lastName].filter(Boolean).join(' ') || contact.email || 'Unknown'
    : 'Unknown';

  const formattedValue =
    deal.value != null && deal.value !== ''
      ? new Intl.NumberFormat('en-US', {
          style: 'currency',
          currency: deal.currency ?? 'USD',
          maximumFractionDigits: 0,
        }).format(Number(deal.value))
      : null;

  return (
    <div
      className={cn(
        'cursor-pointer select-none rounded-xl border border-line bg-bg-panel p-3 shadow-sm transition-all hover:border-line-strong hover:shadow-md active:shadow-sm',
        className,
      )}
      onClick={onClick}
    >
      <div className="flex items-center gap-2.5">
        <span className={cn('grid size-7 shrink-0 place-items-center rounded-full text-2xs font-semibold text-white', tone(contactName))}>
          {initials(contactName)}
        </span>
        <div className="min-w-0 flex-1">
          <p className="m-0 truncate text-body font-semibold leading-snug text-ink">{contactName}</p>
          {contact?.companyName && <p className="m-0 truncate text-xs text-ink-3">{contact.companyName}</p>}
        </div>
      </div>

      <p className="mb-0 mt-2.5 line-clamp-2 text-xs leading-relaxed text-ink-2">{deal.title}</p>

      {formattedValue && (
        <div className="mt-2.5 border-t border-line pt-2">
          <span className="font-mono text-xs font-semibold tabular-nums text-ink">{formattedValue}</span>
        </div>
      )}
    </div>
  );
}
