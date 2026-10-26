'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Building2, Search, ChevronDown, Rocket, Users } from 'lucide-react';
import { useCompanies } from '@/hooks/use-companies';
import { ExportButton } from '@/components/shared/export-button';
import { EmptyState } from '@/components/shared/empty-state';
import { LeadCard, DiscoveringCard, type LeadTag } from '@/components/leads/lead-card';
import type { Company } from '@/types';

import { Button } from '@/components/ui/button';
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
      className="rounded-[6px] grid place-items-center font-bold text-ink bg-bg-soft border border-line shrink-0" style={{ width: size, height: size, fontSize: size * 0.42 }}
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
    <div className="page !py-5 !px-6 !flex !flex-col !gap-[18px]">
      {/* ── Header ─────────────────────────────────────────────── */}
      <div className="flex items-start gap-4 flex-wrap">
        <div className="min-w-0">
          <h1
            className="!flex !items-center !gap-3 !m-0 !text-[26px] !font-semibold !tracking-[-0.02em] !text-ink"
          >
            <span className="display !italic">
              Companies
            </span>
            <span className="text-ink-3 font-normal">—</span>
            <span className="mono !text-[22px]">
              {count}
            </span>
            {live && <span className="dot is-live !w-2 !h-2 !rounded-full"  />}
          </h1>
          <p className="!mt-1.5 !mx-0 !mb-0 !text-[12.5px] !text-ink-3 !flex !items-center !gap-2">
            {search ? (
              <>
                Searching: <span className="text-ink-2 font-medium">{search}</span>
              </>
            ) : (
              'Every company your agents have discovered and scored'
            )}
            {live && (
              <span
                className="pill is-accent !text-[10px] !py-px !px-2 !bg-accent-weak !text-accent-fg"
              >
                Live
              </span>
            )}
          </p>
        </div>

        <div className="ml-auto flex items-center gap-2">
          <ExportButton />
          <Button asChild variant="brand" size="dense"><Link href="/agents/new">
            <Rocket size={14} /> Deploy agent
          </Link></Button>
        </div>
      </div>

      {/* ── Filter pills ───────────────────────────────────────── */}
      <div className="flex items-center gap-2.5 flex-wrap">
        <label className="filter-pill !cursor-text">
          <Search size={14} className="text-ink-3"/>
          <input
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Search by company name…"
            className="border-0 bg-transparent text-inherit w-[200px]" style={{ font: 'inherit' }}
          />
        </label>

        <button
          type="button"
          className="filter-pill"
          onClick={() => setScoredOnly((v) => !v)}
          style={
            scoredOnly
              ? { background: 'var(--accent-weak)', borderColor: 'transparent', color: 'var(--accent-fg)' }
              : undefined
          }
        >
          Scored only
        </button>

        <span className="filter-pill !ml-auto">
          Sort by:
          <select value={sortBy} onChange={(e) => setSortBy(e.target.value as 'fit_score' | 'createdAt')}>
            <option value="fit_score">Fit score</option>
            <option value="createdAt">Newest</option>
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
          icon={Building2}
          title="No companies yet"
          description={
            search
              ? 'No companies match your search. Try a different name.'
              : 'Deploy an agent — discovered companies will show up here as they’re scored.'
          }
          action={
            <Button asChild variant="brand" size="dense"><Link href="/agents/new">
              <Rocket size={14} /> Deploy agent
            </Link></Button>
          }
        />
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
                  <span
                    className="pill !inline-flex !items-center !gap-[5px] !text-[10.5px] !text-ink-3"
                  >
                    <Users size={11} /> {c.size}
                  </span>
                ) : undefined
              }
              contactGlyph={
                c.hasPerson ? (
                  <PersonAvatar name={c.contactName} size={40} />
                ) : (
                  <span className="grid h-10 w-10 place-items-center rounded-lg border border-line bg-bg-soft text-ink-4">
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

      {/* ── Footer / pagination ────────────────────────────────── */}
      <div
        className="flex items-center justify-between pt-2 border-t border-line text-[12px] text-ink-3"
      >
        <span>
          <span className="mono !text-ink-2">
            {count}
          </span>{' '}
          {count === 1 ? 'company' : 'companies'} shown
        </span>

        {(cursorStack.length > 1 || pagination?.hasMore) && (
          <div className="flex items-center gap-2.5">
            <Button
              type="button"
              variant="panel" size="xs"
              disabled={cursorStack.length <= 1}
              onClick={() => setCursorStack((s) => s.slice(0, -1))}
            >
              ← Prev
            </Button>
            <span className="mono !text-[11px]">
              Page {cursorStack.length}
            </span>
            <Button
              type="button"
              variant="panel" size="xs"
              disabled={!pagination?.hasMore || !pagination?.nextCursor}
              onClick={() => {
                if (pagination?.nextCursor) setCursorStack((s) => [...s, pagination.nextCursor!]);
              }}
            >
              Next →
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
