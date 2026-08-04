'use client';

import * as React from 'react';
import Link from 'next/link';
import { useSearchParams, useRouter } from 'next/navigation';
import { Rocket, Plus, Building2, Search, ChevronDown } from 'lucide-react';
import { useProspects } from '@/hooks/use-prospect';
import type { ProspectListRow } from '@/lib/api/prospects';
import { ExportButton } from '@/components/shared/export-button';
import { EmptyState } from '@/components/shared/empty-state';
import { LeadCard, DiscoveringCard, type LeadTag } from '@/components/leads/lead-card';
import { Users } from 'lucide-react';

const STAGES = [
  { value: '', label: 'All stages' },
  { value: 'new', label: 'New' },
  { value: 'first_touch_sent', label: 'First touch sent' },
  { value: 'awaiting_response', label: 'Awaiting response' },
  { value: 'engaged', label: 'Engaged' },
  { value: 'qualified', label: 'Qualified' },
  { value: 'meeting_scheduled', label: 'Meeting scheduled' },
  { value: 'in_evaluation', label: 'In evaluation' },
  { value: 'closed_won', label: 'Closed won' },
  { value: 'closed_lost', label: 'Closed lost' },
  { value: 'cold', label: 'Cold' },
  { value: 'dnc', label: 'DNC' },
];

const SOURCE_TYPES = [
  { value: '', label: 'All sources' },
  { value: 'ai_discovery', label: 'AI Discovery' },
  { value: 'manual_linkedin', label: 'LinkedIn (manual)' },
  { value: 'extension_capture', label: 'Extension' },
  { value: 'referral', label: 'Referral' },
  { value: 'imported_csv', label: 'CSV import' },
];

const AVATAR_HUES = [255, 210, 160, 95, 35, 320, 285];

function fullName(p: ProspectListRow) {
  return [p.firstName, p.lastName].filter(Boolean).join(' ') || p.email || 'Unnamed lead';
}
function initials(p: ProspectListRow) {
  const a = (p.firstName ?? '').charAt(0);
  const b = (p.lastName ?? '').charAt(0);
  return (a + b || (p.email ?? p.companyName ?? '?').charAt(0)).toUpperCase();
}

/** Round avatar with deterministic hue from the name. */
function Avatar({ text, hueSeed, size = 40 }: { text: string; hueSeed: string; size?: number }) {
  const hue = AVATAR_HUES[(hueSeed.charCodeAt(0) || 0) % AVATAR_HUES.length];
  return (
    <span
      style={{
        width: size,
        height: size,
        borderRadius: 999,
        display: 'grid',
        placeItems: 'center',
        fontSize: size * 0.36,
        fontWeight: 600,
        color: '#fff',
        background: `oklch(0.62 0.11 ${hue})`,
        flexShrink: 0,
      }}
    >
      {text}
    </span>
  );
}

const STAGE_LABEL: Record<string, string> = Object.fromEntries(STAGES.map((s) => [s.value, s.label]));

function stageTone(stage: string | null): LeadTag['tone'] {
  if (!stage) return 'default';
  if (['engaged', 'qualified', 'closed_won', 'meeting_scheduled'].includes(stage)) return 'up';
  if (['cold', 'closed_lost', 'dnc'].includes(stage)) return 'warn';
  return 'default';
}

export default function ProspectsPage() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [search, setSearch] = React.useState(searchParams.get('search') ?? '');
  const [sort, setSort] = React.useState<'score' | 'recent'>('score');
  const stage = searchParams.get('stage') ?? '';
  const sourceType = searchParams.get('sourceType') ?? '';
  const tag = searchParams.get('tag') ?? '';

  // Debounce the free-text search so typing doesn't refire the query per keystroke.
  const [debouncedSearch, setDebouncedSearch] = React.useState(search);
  React.useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  const filters = React.useMemo(
    () => ({
      search: debouncedSearch || undefined,
      stage: stage || undefined,
      sourceType: sourceType || undefined,
      tag: tag || undefined,
      limit: 60,
    }),
    [debouncedSearch, stage, sourceType, tag],
  );

  const { data, isLoading, isFetching } = useProspects(filters);

  function setParam(key: string, value: string) {
    const params = new URLSearchParams(searchParams.toString());
    if (value) params.set(key, value);
    else params.delete(key);
    router.push(`/prospects?${params.toString()}`);
  }

  const rows = React.useMemo(() => {
    const list = [...(data?.data ?? [])];
    if (sort === 'score') list.sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
    else list.sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt));
    return list;
  }, [data, sort]);

  const count = data?.data.length ?? 0;
  const hasMore = data?.pagination.hasMore ?? false;
  const live = isFetching && !isLoading;

  return (
    <div className="page" style={{ padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 18 }}>
      {/* ── Header ─────────────────────────────────────────────── */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap' }}>
        <div style={{ minWidth: 0 }}>
          <h1
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              margin: 0,
              fontSize: 26,
              fontWeight: 600,
              letterSpacing: '-0.02em',
              color: 'var(--ink)',
            }}
          >
            <span className="display" style={{ fontStyle: 'italic' }}>
              Prospects
            </span>
            <span style={{ color: 'var(--ink-3)', fontWeight: 400 }}>—</span>
            <span className="mono" style={{ fontSize: 22 }}>
              {count}
            </span>
            {live && <span className="dot is-live" style={{ width: 8, height: 8, borderRadius: 999 }} />}
          </h1>
          <p style={{ margin: '6px 0 0', fontSize: 12.5, color: 'var(--ink-3)', display: 'flex', alignItems: 'center', gap: 8 }}>
            {debouncedSearch ? (
              <>
                Searching: <span style={{ color: 'var(--ink-2)', fontWeight: 500 }}>{debouncedSearch}</span>
              </>
            ) : (
              'Everyone your agents have surfaced and captured'
            )}
            {live && (
              <span
                className="pill is-accent"
                style={{ fontSize: 10, padding: '1px 8px', background: 'var(--accent-weak)', color: 'var(--accent-fg)' }}
              >
                Live
              </span>
            )}
          </p>
        </div>

        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
          <Link href="/prospects/new" className="btn">
            <Plus size={14} /> Add prospect
          </Link>
          <ExportButton />
          <Link href="/agents/new" className="btn is-accent">
            <Rocket size={14} /> Deploy agent
          </Link>
        </div>
      </div>

      {/* ── Filter pills ───────────────────────────────────────── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <label className="filter-pill" style={{ cursor: 'text' }}>
          <Search size={14} style={{ color: 'var(--ink-3)' }} />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search name, company, title…"
            style={{ border: 'none', background: 'transparent', outline: 'none', font: 'inherit', color: 'inherit', width: 200 }}
          />
        </label>

        <span className="filter-pill">
          <select value={stage} onChange={(e) => setParam('stage', e.target.value)}>
            {STAGES.map((s) => (
              <option key={s.value} value={s.value}>
                {s.value ? `Stage: ${s.label}` : s.label}
              </option>
            ))}
          </select>
          <ChevronDown size={13} style={{ color: 'var(--ink-3)' }} />
        </span>

        <span className="filter-pill">
          <select value={sourceType} onChange={(e) => setParam('sourceType', e.target.value)}>
            {SOURCE_TYPES.map((s) => (
              <option key={s.value} value={s.value}>
                {s.value ? `Source: ${s.label}` : s.label}
              </option>
            ))}
          </select>
          <ChevronDown size={13} style={{ color: 'var(--ink-3)' }} />
        </span>

        {tag && (
          <span className="filter-pill" style={{ background: 'var(--accent-weak)', borderColor: 'transparent', color: 'var(--accent-fg)' }}>
            Tag: {tag}
            <button
              type="button"
              onClick={() => setParam('tag', '')}
              style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: 'inherit', fontSize: 14, lineHeight: 1 }}
              aria-label="Clear tag filter"
            >
              ×
            </button>
          </span>
        )}

        <span className="filter-pill" style={{ marginLeft: 'auto' }}>
          Sort by:
          <select value={sort} onChange={(e) => setSort(e.target.value as 'score' | 'recent')}>
            <option value="score">Fit score</option>
            <option value="recent">Most recent</option>
          </select>
          <ChevronDown size={13} style={{ color: 'var(--ink-3)' }} />
        </span>
      </div>

      {/* ── Grid ───────────────────────────────────────────────── */}
      {isLoading ? (
        <div className="leads-grid">
          {Array.from({ length: 8 }).map((_, i) => (
            <DiscoveringCard key={i} />
          ))}
        </div>
      ) : count === 0 ? (
        <EmptyState
          icon={Users}
          title="No prospects match these filters"
          description="Try clearing the filters, or add a prospect manually."
          action={
            <Link href="/prospects/new" className="btn is-accent">
              <Plus size={14} /> Add prospect
            </Link>
          }
        />
      ) : (
        <div className="leads-grid">
          {rows.map((p) => {
            const name = fullName(p);
            const tags: LeadTag[] = [
              ...(p.currentStage ? [{ label: STAGE_LABEL[p.currentStage] ?? p.currentStage.replace(/_/g, ' '), tone: stageTone(p.currentStage) }] : []),
              ...(p.customTags ?? []).slice(0, 3).map((t) => ({ label: t, tone: 'default' as const })),
            ];
            const roles = p.title ? [p.title] : [];
            const description = p.headline?.trim() || p.about?.trim() || null;
            return (
              <LeadCard
                key={p.id}
                href={`/prospects/${p.id}`}
                glyph={<Avatar text={initials(p)} hueSeed={name} size={28} />}
                title={name}
                badge={
                  p.doNotContact ? (
                    <span className="pill is-warn" style={{ fontSize: 10 }}>
                      DNC
                    </span>
                  ) : undefined
                }
                contactGlyph={
                  <span
                    style={{
                      width: 40,
                      height: 40,
                      borderRadius: 8,
                      display: 'grid',
                      placeItems: 'center',
                      background: 'var(--bg-soft)',
                      border: '1px solid var(--line)',
                      color: 'var(--ink-3)',
                    }}
                  >
                    <Building2 size={18} />
                  </span>
                }
                contactName={p.companyName ?? '—'}
                contactSub={p.location ?? null}
                score={p.score ?? null}
                roles={roles}
                description={description}
                tags={tags}
                linkedinUrl={p.linkedinUrl}
              />
            );
          })}
        </div>
      )}

      {/* ── Footer ─────────────────────────────────────────────── */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          paddingTop: 8,
          borderTop: '1px solid var(--line)',
          fontSize: 12,
          color: 'var(--ink-3)',
        }}
      >
        <span>
          <span className="mono" style={{ color: 'var(--ink-2)' }}>
            {count}
          </span>{' '}
          {count === 1 ? 'prospect' : 'prospects'} shown{hasMore ? ' · more available' : ''}
        </span>
        {live && (
          <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span className="pulse-dot" style={{ width: 6, height: 6, borderRadius: 999, background: 'var(--accent)' }} />
            Auto-updating…
          </span>
        )}
      </div>
    </div>
  );
}
