'use client';

import * as React from 'react';
import Link from 'next/link';
import { useSearchParams, useRouter } from 'next/navigation';
import { Rocket, Plus, Building2, Search, X } from 'lucide-react';
import { useProspects } from '@/hooks/use-prospect';
import type { ProspectListRow } from '@/lib/api/prospects';
import { ExportButton } from '@/components/shared/export-button';
import { LeadCard, LeadCardSkeleton, type LeadTag } from '@/components/leads/lead-card';
import { Users } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
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


function fullName(p: ProspectListRow) {
  return [p.firstName, p.lastName].filter(Boolean).join(' ') || p.email || 'Unnamed lead';
}
function initials(p: ProspectListRow) {
  const a = (p.firstName ?? '').charAt(0);
  const b = (p.lastName ?? '').charAt(0);
  return (a + b || (p.email ?? p.companyName ?? '?').charAt(0)).toUpperCase();
}

const AVATAR_TONES = ['bg-accent', 'bg-ink-2', 'bg-up', 'bg-info'];

/** Round avatar with a deterministic tone from the name. */
function Avatar({ text, hueSeed, size = 40 }: { text: string; hueSeed: string; size?: number }) {
  const tone = AVATAR_TONES[(hueSeed.charCodeAt(0) || 0) % AVATAR_TONES.length];
  return (
    <span
      className={`grid shrink-0 place-items-center rounded-full font-semibold text-white ${tone}`}
      style={{ width: size, height: size, fontSize: size * 0.36 }}
    >
      {text}
    </span>
  );
}

function FilterSelect({ value, onChange, options }: { value: string; onChange: (v: string) => void; options: { value: string; label: string }[] }) {
  return (
    <Select value={value} onChange={(e) => onChange(e.target.value)} className="font-medium">
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </Select>
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
    <div className="flex flex-col gap-4 p-5">
      {/* ── Toolbar ────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-2.5">
        <label className="flex h-9 w-full cursor-text items-center gap-2 rounded-lg border border-line bg-bg-panel px-3 text-body text-ink-3 transition-colors focus-within:border-accent-mid focus-within:ring-2 focus-within:ring-accent-weak hover:border-line-strong sm:w-[280px]">
          <Search size={14} className="shrink-0" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search name, company, title…"
            className="min-w-0 flex-1 border-0 bg-transparent text-body text-ink outline-none placeholder:text-ink-4"
          />
        </label>

        <FilterSelect
          value={stage}
          onChange={(v) => setParam('stage', v)}
          options={STAGES.map((s) => ({ value: s.value, label: s.value ? `Stage: ${s.label}` : s.label }))}
        />
        <FilterSelect
          value={sourceType}
          onChange={(v) => setParam('sourceType', v)}
          options={SOURCE_TYPES.map((s) => ({ value: s.value, label: s.value ? `Source: ${s.label}` : s.label }))}
        />

        {tag && (
          <span className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-accent-mid bg-accent-weak pl-3 pr-1.5 text-body font-medium text-accent-fg">
            Tag: {tag}
            <button
              type="button"
              onClick={() => setParam('tag', '')}
              className="grid size-6 place-items-center rounded-md border-0 bg-transparent text-inherit hover:bg-black/10"
              aria-label="Clear tag filter"
            >
              <X size={13} />
            </button>
          </span>
        )}

        <FilterSelect
          value={sort}
          onChange={(v) => setSort(v as 'score' | 'recent')}
          options={[
            { value: 'score', label: 'Sort: Fit score' },
            { value: 'recent', label: 'Sort: Most recent' },
          ]}
        />

        <div className="ml-auto flex items-center gap-2">
          <Button asChild variant="panel" size="dense" className="h-9 rounded-lg px-3.5 text-body font-medium">
            <Link href="/prospects/new">
              <Plus size={14} className="mr-1.5" /> Add prospect
            </Link>
          </Button>
          <ExportButton />
          <Button asChild variant="brand" size="dense" className="h-9 rounded-lg px-3.5 text-body font-semibold">
            <Link href="/agents/new">
              <Rocket size={14} className="mr-1.5" /> Deploy agent
            </Link>
          </Button>
        </div>
      </div>

      {/* ── Summary ────────────────────────────────────────────── */}
      <div className="flex items-center gap-2 px-1 text-2xs font-medium uppercase tracking-[0.09em] text-ink-4">
        <span>Prospects</span>
        <span className="normal-case tracking-normal text-ink-3">
          {debouncedSearch ? (
            <>
              {count} matching “<span className="font-medium text-ink-2">{debouncedSearch}</span>”
            </>
          ) : (
            <>
              {count} shown{hasMore ? ' · more available' : ''} · surfaced and captured by your agents
            </>
          )}
        </span>
        {live && (
          <span className="inline-flex items-center gap-1.5 normal-case tracking-normal text-up">
            <span className="size-1.5 animate-pulse rounded-full bg-current" /> Updating
          </span>
        )}
      </div>

      {/* ── Grid ───────────────────────────────────────────────── */}
      {isLoading ? (
        <div className="leads-grid">
          {Array.from({ length: 6 }).map((_, i) => (
            <LeadCardSkeleton key={i} />
          ))}
        </div>
      ) : count === 0 ? (
        <section className="rounded-2xl border border-line bg-bg-panel p-7 shadow-sm">
          <span className="grid size-9 place-items-center rounded-full bg-accent-weak text-accent">
            <Users size={16} />
          </span>
          <h2 className="mb-0 mt-4 font-display text-[26px] font-normal leading-tight tracking-[-0.01em] text-ink">No prospects match</h2>
          <p className="mb-5 mt-2 max-w-[460px] text-body leading-relaxed text-ink-3">Try clearing the filters, or add a prospect manually.</p>
          <Button asChild variant="brand" size="dense" className="h-9 rounded-lg px-5 text-body font-semibold">
            <Link href="/prospects/new">
              <Plus size={14} className="mr-1.5" /> Add prospect
            </Link>
          </Button>
        </section>
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
                    <span className="rounded-tag bg-warn/15 px-2 py-1 text-2xs font-semibold text-warn-fg">DNC</span>
                  ) : undefined
                }
                contactGlyph={
                  <span className="grid size-10 place-items-center rounded-lg bg-bg-soft text-ink-4">
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
    </div>
  );
}
