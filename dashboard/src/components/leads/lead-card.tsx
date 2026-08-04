'use client';

import Link from 'next/link';
import type { CSSProperties, ReactNode } from 'react';
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
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        padding: '3px 8px',
        borderRadius: 999,
        fontSize: 11,
        fontWeight: 500,
        whiteSpace: 'nowrap',
        ...tagStyle[tag.tone ?? 'default'],
      }}
    >
      {tag.label}
    </span>
  );
}

const cardBase: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  background: 'var(--bg-panel)',
  border: '1px solid var(--line)',
  borderRadius: 10,
  padding: 18,
  gap: 12,
  aspectRatio: '1 / 1',
  minHeight: 240,
  minWidth: 0,
  overflow: 'hidden',
};

/** Discovering placeholder — a live agent is still enriching this lead. */
export function DiscoveringCard() {
  const bar = (w: number) => (
    <span style={{ display: 'block', height: 8, width: w, borderRadius: 4, background: 'var(--bg-soft)' }} />
  );
  return (
    <div
      style={{
        ...cardBase,
        border: '1px dashed color-mix(in oklch, var(--accent) 45%, var(--line))',
        background: 'color-mix(in oklch, var(--accent) 4%, var(--bg-panel))',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ width: 20, height: 20, borderRadius: 4, background: 'var(--bg-soft)' }} />
          {bar(70)}
        </div>
        <span
          className="pill is-accent"
          style={{ fontSize: 10, background: 'var(--accent-weak)', color: 'var(--accent-fg)' }}
        >
          New
        </span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ width: 40, height: 40, borderRadius: 999, background: 'var(--bg-soft)' }} />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={{ fontSize: 12, color: 'var(--ink-3)' }}>Discovering lead…</span>
          {bar(48)}
        </div>
        <span
          style={{
            marginLeft: 'auto',
            width: 56,
            height: 56,
            borderRadius: 999,
            border: '3px dashed color-mix(in oklch, var(--accent) 40%, var(--line))',
          }}
        />
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        {bar(64)}
        {bar(80)}
      </div>
      <div style={{ marginTop: 'auto', display: 'flex', alignItems: 'center', gap: 6, color: 'var(--accent-fg)' }}>
        <span
          style={{ width: 6, height: 6, borderRadius: 999, background: 'var(--accent)' }}
          className="pulse-dot"
        />
        <span style={{ fontSize: 11 }}>Adding to results…</span>
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
      style={{
        ...cardBase,
        borderColor: isNew ? 'color-mix(in oklch, var(--accent) 45%, var(--line))' : 'var(--line)',
        transition: 'border-color 120ms, box-shadow 120ms',
      }}
      className="lead-card"
    >
      {/* Header: glyph + title + badge */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ flexShrink: 0, display: 'grid', placeItems: 'center' }}>{glyph}</span>
        <span
          style={{
            fontSize: 14,
            fontWeight: 600,
            color: 'var(--ink)',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            minWidth: 0,
          }}
          title={title}
        >
          {title}
        </span>
        {badge != null && <span style={{ marginLeft: 'auto', flexShrink: 0 }}>{badge}</span>}
      </div>

      {/* Body: secondary entity + gauge */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        {contactGlyph && <span style={{ flexShrink: 0 }}>{contactGlyph}</span>}
        <div style={{ minWidth: 0, flex: 1 }}>
          {contactName && (
            <div
              style={{
                fontSize: 13,
                fontWeight: 500,
                color: 'var(--ink)',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              {contactName}
            </div>
          )}
          {contactSub && (
            <div
              style={{
                fontSize: 11.5,
                color: 'var(--ink-3)',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              {contactSub}
            </div>
          )}
        </div>
        <span style={{ marginLeft: 'auto', flexShrink: 0 }}>
          <FitGauge score={score} />
        </span>
      </div>

      {/* Roles */}
      {roles.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {roles.map((role, i) => (
            <span
              key={`${role}-${i}`}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
                padding: '2px 8px',
                borderRadius: 6,
                fontSize: 11,
                fontWeight: 500,
                color: 'var(--ink-2)',
                background: 'var(--bg-soft)',
                border: '1px solid var(--line)',
                whiteSpace: 'nowrap',
                maxWidth: '100%',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              <Briefcase size={11} style={{ color: 'var(--ink-3)', flexShrink: 0 }} />
              {role}
            </span>
          ))}
        </div>
      )}

      {/* Description */}
      {description && (
        <p
          style={{
            margin: 0,
            fontSize: 12,
            lineHeight: 1.5,
            color: 'var(--ink-3)',
            display: '-webkit-box',
            WebkitLineClamp: 3,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
          }}
        >
          {description}
        </p>
      )}

      {/* Tags */}
      {tags.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {tags.map((t, i) => (
            <TagChip key={`${t.label}-${i}`} tag={t} />
          ))}
        </div>
      )}

      {/* Footer: linkedin + view profile */}
      <div
        style={{
          marginTop: 'auto',
          paddingTop: 12,
          borderTop: '1px solid var(--line)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        {linkedinUrl ? (
          <a
            href={linkedinUrl}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            aria-label="Open LinkedIn profile"
            style={{
              display: 'grid',
              placeItems: 'center',
              width: 26,
              height: 26,
              borderRadius: 5,
              background: '#0a66c2',
              color: '#fff',
            }}
          >
            <Linkedin size={14} />
          </a>
        ) : (
          <span />
        )}
        <Link
          href={href}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 5,
            fontSize: 12.5,
            fontWeight: 500,
            color: 'var(--accent-fg)',
          }}
        >
          View profile <ArrowRight size={14} />
        </Link>
      </div>
    </div>
  );
}
