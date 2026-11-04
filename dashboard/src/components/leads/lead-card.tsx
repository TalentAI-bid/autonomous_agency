'use client';

import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { Linkedin, ArrowRight, Briefcase } from 'lucide-react';
import { FitGauge } from './fit-gauge';
import { Skeleton } from '@/components/ui/skeleton';

export interface LeadTag {
  label: string;
  tone?: 'default' | 'up' | 'warn';
}

export interface LeadCardProps {
  /** Where "View profile" and the card click go. */
  href: string;
  /** Top-left glyph — an avatar or company logo. */
  glyph: ReactNode;
  /** Headline (company or person name). */
  title: string;
  /** Optional top-right badge (company size, pipeline stage…). */
  badge?: ReactNode;
  /** Secondary entity avatar (e.g. key person on a company card). */
  contactGlyph?: ReactNode;
  /** Secondary line primary text (key-person name, or company on a contact card). */
  contactName?: string | null;
  /** Secondary line muted text (title · location). */
  contactSub?: string | null;
  score?: number | null;
  /** Job role(s) / titles, shown as subtle chips. */
  roles?: string[];
  /** Short free-text description (headline / company blurb), clamped to 3 lines. */
  description?: string | null;
  tags?: LeadTag[];
  linkedinUrl?: string | null;
  /** Dashed "discovering…" placeholder card variant. */
  discovering?: boolean;
  isNew?: boolean;
}

const TAG_VARIANT: Record<NonNullable<LeadTag['tone']>, 'soft' | 'accent' | 'warn'> = {
  default: 'soft',
  up: 'accent',
  warn: 'warn',
};

function TagChip({ tag }: { tag: LeadTag }) {
  return <Badge variant={TAG_VARIANT[tag.tone ?? 'default']}>{tag.label}</Badge>;
}

const CARD_BASE =
  'flex min-h-[240px] min-w-0 flex-col gap-3 overflow-hidden rounded-2xl border border-line bg-bg-panel p-[18px] shadow-sm';

/** Loading placeholder that mirrors the LeadCard layout, so nothing jumps when data arrives. */
export function LeadCardSkeleton() {
  return (
    <div className={cn(CARD_BASE)} aria-hidden>
      {/* Header: glyph + title + badge */}
      <div className="flex items-center gap-2">
        <Skeleton className="size-7 shrink-0 rounded-full" />
        <Skeleton className="h-3.5 w-32" />
        <Skeleton className="ml-auto h-5 w-12 rounded-tag" />
      </div>

      {/* Body: secondary entity + gauge */}
      <div className="flex items-center gap-2.5">
        <Skeleton className="size-10 shrink-0 rounded-lg" />
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <Skeleton className="h-3.5 w-3/5" />
          <Skeleton className="h-3 w-2/5" />
        </div>
        <Skeleton className="size-14 shrink-0 rounded-full" />
      </div>

      {/* Role chip */}
      <Skeleton className="h-6 w-36 rounded-tag" />

      {/* Description */}
      <div className="flex flex-col gap-2">
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-11/12" />
        <Skeleton className="h-3 w-2/3" />
      </div>

      {/* Tags */}
      <div className="flex gap-1.5">
        <Skeleton className="h-6 w-16 rounded-tag" />
        <Skeleton className="h-6 w-20 rounded-tag" />
      </div>

      {/* Footer */}
      <div className="mt-auto flex items-center justify-between border-t border-line pt-3">
        <Skeleton className="size-7 rounded-lg" />
        <Skeleton className="h-8 w-28 rounded-lg" />
      </div>
    </div>
  );
}

export function LeadCard({
  href,
  glyph,
  title,
  badge,
  contactGlyph,
  contactName,
  contactSub,
  score,
  roles = [],
  description,
  tags = [],
  linkedinUrl,
  isNew,
}: LeadCardProps) {
  return (
    <div
      className={cn(
        'lead-card transition-[border-color,box-shadow] duration-150 hover:shadow-md',
        CARD_BASE,
        isNew && 'border-accent-mid',
      )}
    >
      {/* Header: glyph + title + badge */}
      <div className="flex items-center gap-2">
        <span className="shrink-0 grid place-items-center">{glyph}</span>
        <span
          className="text-[14px] font-semibold text-ink whitespace-nowrap overflow-hidden text-ellipsis min-w-0"
          title={title}
        >
          {title}
        </span>
        {badge != null && <span className="ml-auto shrink-0">{badge}</span>}
      </div>

      {/* Body: secondary entity + gauge */}
      <div className="flex items-center gap-2.5">
        {contactGlyph && <span className="shrink-0">{contactGlyph}</span>}
        <div className="min-w-0 flex-1">
          {contactName && (
            <div
              className="text-body font-medium text-ink whitespace-nowrap overflow-hidden text-ellipsis"
            >
              {contactName}
            </div>
          )}
          {contactSub && (
            <div
              className="text-[11.5px] text-ink-3 whitespace-nowrap overflow-hidden text-ellipsis"
            >
              {contactSub}
            </div>
          )}
        </div>
        <span className="ml-auto shrink-0">
          <FitGauge score={score} />
        </span>
      </div>

      {/* Roles */}
      {roles.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {roles.map((role, i) => (
            <span
              key={`${role}-${i}`}
              className="inline-flex max-w-full items-center gap-1 overflow-hidden text-ellipsis whitespace-nowrap rounded-tag bg-bg-soft px-2 py-1 text-xs font-medium text-ink-2"
            >
              <Briefcase size={11} className="text-ink-3 shrink-0"/>
              {role}
            </span>
          ))}
        </div>
      )}

      {/* Description */}
      {description && (
        <p
          className="m-0 text-label leading-[1.5] text-ink-3 overflow-hidden" style={{ display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical' }}
        >
          {description}
        </p>
      )}

      {/* Tags */}
      {tags.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {tags.map((t, i) => (
            <TagChip key={`${t.label}-${i}`} tag={t} />
          ))}
        </div>
      )}

      {/* Footer: linkedin + view profile */}
      <div
        className="mt-auto flex items-center justify-between border-t border-line pt-3"
      >
        {linkedinUrl ? (
          <a
            href={linkedinUrl}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            aria-label="Open LinkedIn profile"
            className="grid size-7 place-items-center rounded-lg bg-[color:#0a66c2] text-white"
          >
            <Linkedin size={14} />
          </a>
        ) : (
          <span />
        )}
        <Button asChild variant="panel" size="sm">
          <Link href={href} className="no-underline">
            View profile <ArrowRight size={13} />
          </Link>
        </Button>
      </div>
    </div>
  );
}
