'use client';

import { useEffect, useMemo, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import Link from 'next/link';
import { Building2, Search, Rocket, Users } from 'lucide-react';
import { useCompanies } from '@/hooks/use-companies';
import { ExportButton } from '@/components/shared/export-button';
import { LeadCard, LeadCardSkeleton, type LeadTag } from '@/components/leads/lead-card';
import type { Company } from '@/types';

import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { cn } from '@/lib/utils';
const PAGE_SIZE = 24;
const AVATAR_HUES = [255, 210, 160, 95, 35, 320, 285];
const TH = 55; // component-score threshold for surfacing a qualifier tag

function fitScoreOf(c: Company): number | null {
  const s = c.rawData?.fitScore?.buyer_fit_score;
  if (typeof s === 'number') return Math.round(s);
  const legacy = c.rawData?.triage?.fit_score;
  if (typeof legacy === 'number') return Math.round(legacy);
  return null;
}

/** Qualifier tags derived ONLY from real fit-score components/signals. */
function fitTags(c: Company): LeadTag[] {
  const fs = c.rawData?.fitScore;
  if (!fs) return [];
  const cs = fs.component_scores;
  const tags: LeadTag[] = [];
  if ((cs?.is_real_business?.score ?? 0) >= TH) tags.push({ label: 'Real business' });
  if ((cs?.icp_match?.score ?? 0) >= TH) tags.push({ label: 'ICP match' });
  if ((fs.signals?.hiring_signals?.length ?? 0) > 0) tags.push({ label: 'Hiring signal' });
  else if ((cs?.buyer_signal_strength?.score ?? 0) >= TH) tags.push({ label: 'Buyer signals' });
  const dm = cs?.decision_maker_reachable?.score;
  if (dm != null && dm >= TH) tags.push({ label: 'Decision-maker reachable' });
  return tags;
}

function monogram(name: string) {
  return (name.trim().charAt(0) || '?').toUpperCase();
}
function personInitials(name: string) {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase() || '?';
}

function CompanyGlyph({ name, size = 28 }: { name: string; size?: number }) {
  return (
    <span
      className="grid shrink-0 place-items-center rounded-lg bg-accent-weak font-semibold text-accent-fg"
      style={{ width: size, height: size, fontSize: size * 0.42 }}
    >
      {monogram(name)}
    </span>
  );
}

function PersonAvatar({ name, size = 40 }: { name: string; size?: number }) {
  const hue = AVATAR_HUES[(name.charCodeAt(0) || 0) % AVATAR_HUES.length];
  return (
    <span
      className="rounded-full grid place-items-center font-semibold text-white shrink-0" style={{ width: size, height: size, fontSize: size * 0.36, background: `oklch(0.62 0.11 ${hue})` }}
    >
      {personInitials(name)}
    </span>
  );
}

export default function CompaniesPage() {
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [sortBy, setSortBy] = useState<'fit_score' | 'createdAt'>('fit_score');
  const [scoredOnly, setScoredOnly] = useState(false);
  const [cursorStack, setCursorStack] = useState<Array<string | null>>([null]);

  // Debounce search; reset pagination when the query or filters change.
  useEffect(() => {
    const t = setTimeout(() => {
      setSearch(searchInput.trim());
      setCursorStack([null]);
    }, 250);
    return () => clearTimeout(t);
  }, [searchInput]);
  useEffect(() => {
    setCursorStack([null]);
  }, [sortBy, scoredOnly]);

  const currentCursor = cursorStack[cursorStack.length - 1] ?? undefined;

  const { data: res, isLoading, isFetching } = useCompanies({
    search: search || undefined,
    sortBy,
    cursor: currentCursor,
    limit: PAGE_SIZE,
    includeIncomplete: !scoredOnly,
  });

  const companies = res?.data ?? [];
  const pagination = res?.pagination;
  const live = isFetching && !isLoading;
  const count = companies.length;

  const cards = useMemo(
    () =>
      companies.map((c) => {
        const kp = c.rawData?.fitScore?.key_person ?? null;
        const contactName = kp?.name ?? c.industry ?? 'No decision-maker yet';
        const contactSub = c.domain ?? c.industry ?? null;
        const description = c.description?.trim() || c.rawData?.fitScore?.fit_summary?.trim() || null;
        return {
          id: c.id,
          href: c.masterAgentId ? `/agents/${c.masterAgentId}/companies/${c.id}` : '/companies',
          name: c.name,
          size: c.size,
          hasPerson: !!kp,
          contactName,
          contactSub,
          roles: kp?.title ? [kp.title] : [],
          description,
          score: fitScoreOf(c),
          tags: fitTags(c),
          linkedinUrl: kp?.linkedinUrl ?? c.linkedinUrl ?? null,
        };
      }),
    [companies],
  );

  return (
    <div className="flex flex-col gap-4 p-5">
      {/* ── Toolbar ────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-2.5">
        <label className="flex h-9 w-full cursor-text items-center gap-2 rounded-lg border border-line bg-bg-panel px-3 text-body text-ink-3 transition-colors focus-within:border-accent-mid focus-within:ring-2 focus-within:ring-accent-weak hover:border-line-strong sm:w-[280px]">
          <Search size={14} className="shrink-0" />
          <input
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Search by company name…"
            className="min-w-0 flex-1 border-0 bg-transparent text-body text-ink outline-none placeholder:text-ink-4"
          />
        </label>

        <button
          type="button"
          aria-pressed={scoredOnly}
          onClick={() => setScoredOnly((v) => !v)}
          className={cn(
            'h-9 rounded-lg border px-3.5 text-body font-medium transition-colors',
            scoredOnly
              ? 'border-accent-mid bg-accent-weak text-accent-fg'
              : 'border-line bg-bg-panel text-ink-2 hover:border-line-strong hover:bg-hover',
          )}
        >
          Scored only
        </button>

        <Select
          value={sortBy}
          onChange={(e) => setSortBy(e.target.value as 'fit_score' | 'createdAt')}
          aria-label="Sort companies"
          className="font-medium"
        >
          <option value="fit_score">Sort: Fit score</option>
          <option value="createdAt">Sort: Newest</option>
        </Select>

        <div className="ml-auto flex items-center gap-2">
          <ExportButton />
          <Button asChild variant="brand">
            <Link href="/agents/new">
              <Rocket size={14} className="mr-1.5" /> Deploy agent
            </Link>
          </Button>
        </div>
      </div>

      {/* ── Summary ────────────────────────────────────────────── */}
      <div className="flex items-center gap-2 px-1 text-2xs font-medium uppercase tracking-[0.09em] text-ink-4">
        <span>Companies</span>
        <span className="normal-case tracking-normal text-ink-3">
          {search ? (
            <>
              {count} matching “<span className="font-medium text-ink-2">{search}</span>”
            </>
          ) : (
            <>{count} shown · discovered and scored by your agents</>
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
            <Building2 size={16} />
          </span>
          <h2 className="mb-0 mt-4 font-display text-[26px] font-normal leading-tight tracking-[-0.01em] text-ink">No companies yet</h2>
          <p className="mb-5 mt-2 max-w-[460px] text-body leading-relaxed text-ink-3">
            {search
              ? 'No companies match your search. Try a different name.'
              : 'Deploy an agent and the companies it discovers will show up here as they are scored.'}
          </p>
          {!search && (
            <Button asChild variant="brand">
              <Link href="/agents/new">Deploy agent</Link>
            </Button>
          )}
        </section>
      ) : (
        <div className="leads-grid">
          {cards.map((c) => (
            <LeadCard
              key={c.id}
              href={c.href}
              glyph={<CompanyGlyph name={c.name} size={28} />}
              title={c.name}
              badge={
                c.size ? (
                  <Badge variant="muted" size="sm">
                    <Users size={11} /> {c.size}
                  </Badge>
                ) : undefined
              }
              contactGlyph={
                c.hasPerson ? (
                  <PersonAvatar name={c.contactName} size={40} />
                ) : (
                  <span className="grid size-10 place-items-center rounded-lg bg-bg-soft text-ink-4">
                    <Building2 size={18} />
                  </span>
                )
              }
              contactName={c.contactName}
              contactSub={c.contactSub}
              score={c.score}
              roles={c.roles}
              description={c.description}
              tags={c.tags}
              linkedinUrl={c.linkedinUrl}
            />
          ))}
        </div>
      )}

      {/* ── Pagination ─────────────────────────────────────────── */}
      {(cursorStack.length > 1 || pagination?.hasMore) && (
        <div className="flex items-center justify-between rounded-2xl border border-line bg-bg-panel px-4 py-2.5 shadow-sm">
          <span className="text-xs text-ink-3">
            <span className="font-mono text-ink-2">{count}</span> {count === 1 ? 'company' : 'companies'} on this page
          </span>
          <div className="flex items-center gap-2.5">
            <Button size="sm"
              type="button"
              variant="panel"
              disabled={cursorStack.length <= 1}
              onClick={() => setCursorStack((s) => s.slice(0, -1))}
            >
              ← Previous
            </Button>
            <span className="font-mono text-xs text-ink-3">Page {cursorStack.length}</span>
            <Button size="sm"
              type="button"
              variant="panel"
              disabled={!pagination?.hasMore || !pagination?.nextCursor}
              onClick={() => {
                if (pagination?.nextCursor) setCursorStack((s) => [...s, pagination.nextCursor!]);
              }}
            >
              Next →
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
