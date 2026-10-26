'use client';

import Link from 'next/link';
import type { CSSProperties, ReactNode } from 'react';
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

const tagStyle: Record<NonNullable<LeadTag['tone']>, CSSProperties> = {
  default: { background: 'var(--bg-soft)', color: 'var(--ink-2)', border: '1px solid var(--line)' },
  up: {
    background: 'var(--accent-weak)',
    color: 'var(--accent-fg)',
    border: '1px solid color-mix(in oklch, var(--accent) 22%, transparent)',
  },
  warn: {
    background: 'var(--warn-weak)',
    color: 'var(--warn)',
    border: '1px solid color-mix(in oklch, var(--warn) 30%, transparent)',
  },
};

function TagChip({ tag }: { tag: LeadTag }) {
  return (
    <span
      className="inline-flex items-center py-[3px] px-2 rounded-full text-[11px] font-medium whitespace-nowrap" style={{ ...tagStyle[tag.tone ?? 'default'] }}
    >
      {tag.label}
    </span>
  );
}

const CARD_BASE =
  'flex aspect-square min-h-[240px] min-w-0 flex-col gap-3 overflow-hidden rounded-[10px] border border-line bg-bg-panel p-[18px]';

/** Discovering placeholder — a live agent is still enriching this lead. */
export function DiscoveringCard() {
  const bar = (w: number) => (
    <span className="block h-2 rounded-[4px] bg-bg-soft" style={{ width: w }} />
  );
  return (
    <div
      className={cn(CARD_BASE, "border-dashed border-[color:color-mix(in_oklch,_var(--accent)_45%,_var(--line))] bg-[color:color-mix(in_oklch,_var(--accent)_4%,_var(--bg-panel))]")}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="w-5 h-5 rounded-[4px] bg-bg-soft"/>
          {bar(70)}
        </div>
        <span
          className="pill is-accent !text-[10px] !bg-accent-weak !text-accent-fg"
        >
          New
        </span>
      </div>
      <div className="flex items-center gap-2.5">
        <span className="w-10 h-10 rounded-full bg-bg-soft"/>
        <div className="flex flex-col gap-1.5">
          <span className="text-[12px] text-ink-3">Discovering lead…</span>
          {bar(48)}
        </div>
        <span
          className="ml-auto w-14 h-14 rounded-full border-[3px] border-dashed border-[color:color-mix(in_oklch,_var(--accent)_40%,_var(--line))]"
        />
      </div>
      <div className="flex gap-1.5">
        {bar(64)}
        {bar(80)}
      </div>
      <div className="mt-auto flex items-center gap-1.5 text-accent-fg">
        <span
          className="pulse-dot !w-1.5 !h-1.5 !rounded-full !bg-accent"
        />
        <span className="text-[11px]">Adding to results…</span>
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
        'lead-card transition-[border-color,box-shadow] duration-[120ms]',
        CARD_BASE,
        isNew && 'border-[color:color-mix(in_oklch,_var(--accent)_45%,_var(--line))]',
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
              className="text-[13px] font-medium text-ink whitespace-nowrap overflow-hidden text-ellipsis"
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
              className="inline-flex items-center gap-1 py-0.5 px-2 rounded-[6px] text-[11px] font-medium text-ink-2 bg-bg-soft border border-line whitespace-nowrap max-w-full overflow-hidden text-ellipsis"
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
          className="!m-0 !text-[12px] !leading-[1.5] !text-ink-3 !overflow-hidden" style={{ display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical' }}
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
        className="mt-auto pt-3 border-t border-line flex items-center justify-between"
      >
        {linkedinUrl ? (
          <a
            href={linkedinUrl}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            aria-label="Open LinkedIn profile"
            className="grid place-items-center w-[26px] h-[26px] rounded-[5px] bg-[color:#0a66c2] text-white"
          >
            <Linkedin size={14} />
          </a>
        ) : (
          <span />
        )}
        <Link
          href={href}
          className="inline-flex items-center gap-[5px] text-[12.5px] font-medium text-accent-fg"
        >
          View profile <ArrowRight size={14} />
        </Link>
      </div>
    </div>
  );
}
