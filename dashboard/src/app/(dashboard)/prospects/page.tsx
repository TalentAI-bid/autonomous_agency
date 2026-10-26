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

import { Button } from '@/components/ui/button';
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
      className="rounded-full grid place-items-center font-semibold text-white shrink-0" style={{ width: size, height: size, fontSize: size * 0.36, background: `oklch(0.62 0.11 ${hue})` }}
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
    <div className="page py-5 px-6 flex flex-col gap-[18px]">
      {/* ── Header ─────────────────────────────────────────────── */}
      <div className="flex items-start gap-4 flex-wrap">
        <div className="min-w-0">
          <h1
            className="flex items-center gap-3 m-0 text-[26px] font-semibold tracking-[-0.02em] text-ink"
          >
            <span className="display italic">
              Prospects
            </span>
            <span className="text-ink-3 font-normal">—</span>
            <span className="mono text-stat">
              {count}
            </span>
            {live && <span className="dot is-live w-2 h-2 rounded-full"  />}
          </h1>
          <p className="mt-1.5 mx-0 mb-0 text-[12.5px] text-ink-3 flex items-center gap-2">
            {debouncedSearch ? (
              <>
                Searching: <span className="text-ink-2 font-medium">{debouncedSearch}</span>
              </>
            ) : (
              'Everyone your agents have surfaced and captured'
            )}
            {live && (
              <span
                className="pill is-accent text-2xs py-px px-2 bg-accent-weak text-accent-fg"
              >
                Live
              </span>
            )}
          </p>
        </div>

        <div className="ml-auto flex items-center gap-2">
          <Button asChild variant="panel" size="dense"><Link href="/prospects/new">
            <Plus size={14} /> Add prospect
          </Link></Button>
          <ExportButton />
          <Button asChild variant="brand" size="dense"><Link href="/agents/new">
            <Rocket size={14} /> Deploy agent
          </Link></Button>
        </div>
      </div>

      {/* ── Filter pills ───────────────────────────────────────── */}
      <div className="flex items-center gap-2.5 flex-wrap">
        <label className="filter-pill cursor-text">
          <Search size={14} className="text-ink-3"/>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search name, company, title…"
            className="border-0 bg-transparent text-inherit w-[200px]" style={{ font: 'inherit' }}
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
          <ChevronDown size={13} className="text-ink-3"/>
        </span>

        <span className="filter-pill">
          <select value={sourceType} onChange={(e) => setParam('sourceType', e.target.value)}>
            {SOURCE_TYPES.map((s) => (
              <option key={s.value} value={s.value}>
                {s.value ? `Source: ${s.label}` : s.label}
              </option>
            ))}
          </select>
          <ChevronDown size={13} className="text-ink-3"/>
        </span>

        {tag && (
          <span className="filter-pill border-transparent bg-accent-weak text-accent-fg">
            Tag: {tag}
            <button
              type="button"
              onClick={() => setParam('tag', '')}
              className="border-0 bg-transparent cursor-pointer text-inherit text-[14px] leading-[1]"
              aria-label="Clear tag filter"
            >
              ×
            </button>
          </span>
        )}

        <span className="filter-pill ml-auto">
          Sort by:
          <select value={sort} onChange={(e) => setSort(e.target.value as 'score' | 'recent')}>
            <option value="score">Fit score</option>
            <option value="recent">Most recent</option>
          </select>
          <ChevronDown size={13} className="text-ink-3"/>
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
            <Button asChild variant="brand" size="dense"><Link href="/prospects/new">
              <Plus size={14} /> Add prospect
            </Link></Button>
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
                    <span className="pill is-warn text-2xs">
                      DNC
                    </span>
                  ) : undefined
                }
                contactGlyph={
                  <span className="grid h-10 w-10 place-items-center rounded-lg border border-line bg-bg-soft text-ink-3">
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
        className="flex items-center justify-between pt-2 border-t border-line text-label text-ink-3"
      >
        <span>
          <span className="mono text-ink-2">
            {count}
          </span>{' '}
          {count === 1 ? 'prospect' : 'prospects'} shown{hasMore ? ' · more available' : ''}
        </span>
        {live && (
          <span className="flex items-center gap-1.5">
            <span className="pulse-dot w-1.5 h-1.5 rounded-full bg-accent"  />
            Auto-updating…
          </span>
        )}
      </div>
    </div>
  );
}
