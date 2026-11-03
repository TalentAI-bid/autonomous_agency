'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { Linkedin, ArrowRight, Briefcase } from 'lucide-react';
import { FitGauge } from './fit-gauge';

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

const tagClass: Record<NonNullable<LeadTag['tone']>, string> = {
  default: 'bg-bg-soft text-ink-2',
  up: 'bg-accent-weak text-accent-fg',
  warn: 'bg-warn/15 text-warn-fg',
};

function TagChip({ tag }: { tag: LeadTag }) {
  return (
    <span className={cn('inline-flex items-center whitespace-nowrap rounded-tag px-2 py-1 text-xs font-medium', tagClass[tag.tone ?? 'default'])}>
      {tag.label}
    </span>
  );
}

const CARD_BASE =
  'flex min-h-[240px] min-w-0 flex-col gap-3 overflow-hidden rounded-2xl border border-line bg-bg-panel p-[18px] shadow-sm';

/** Discovering placeholder — a live agent is still enriching this lead. */
export function DiscoveringCard() {
  const bar = (w: number) => (
    <span className="block h-2 rounded-tag bg-bg-soft" style={{ width: w }} />
  );
  return (
    <div
      className={cn(CARD_BASE, "border-dashed border-accent-mid bg-accent-weak shadow-none")}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="w-5 h-5 rounded-tag bg-bg-soft"/>
          {bar(70)}
        </div>
        <span
          className="pill is-accent text-2xs bg-accent-weak text-accent-fg"
        >
          New
        </span>
      </div>
      <div className="flex items-center gap-2.5">
        <span className="w-10 h-10 rounded-full bg-bg-soft"/>
        <div className="flex flex-col gap-1.5">
          <span className="text-label text-ink-3">Discovering lead…</span>
          {bar(48)}
        </div>
        <span
          className="ml-auto w-14 h-14 rounded-full border-[3px] border-dashed border-accent-line"
        />
      </div>
      <div className="flex gap-1.5">
        {bar(64)}
        {bar(80)}
      </div>
      <div className="mt-auto flex items-center gap-1.5 text-accent-fg">
        <span
          className="pulse-dot w-1.5 h-1.5 rounded-full bg-accent"
        />
        <span className="text-xs">Adding to results…</span>
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
        <Link
          href={href}
          className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line bg-bg-panel px-3 text-xs font-medium text-ink no-underline transition-colors hover:border-accent-mid hover:bg-accent-weak hover:text-accent-fg"
        >
          View profile <ArrowRight size={13} />
        </Link>
      </div>
    </div>
  );
}
