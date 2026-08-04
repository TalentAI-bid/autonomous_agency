'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Building2, Search, ChevronDown, Rocket, Users } from 'lucide-react';
import { useCompanies } from '@/hooks/use-companies';
import { ExportButton } from '@/components/shared/export-button';
import { EmptyState } from '@/components/shared/empty-state';
import { LeadCard, DiscoveringCard, type LeadTag } from '@/components/leads/lead-card';
import type { Company } from '@/types';

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
      style={{
        width: size,
        height: size,
        borderRadius: 6,
        display: 'grid',
        placeItems: 'center',
        fontSize: size * 0.42,
        fontWeight: 700,
        color: 'var(--ink)',
        background: 'var(--bg-soft)',
        border: '1px solid var(--line)',
        flexShrink: 0,
      }}
    >
      {monogram(name)}
    </span>
  );
}

function PersonAvatar({ name, size = 40 }: { name: string; size?: number }) {
  const hue = AVATAR_HUES[(name.charCodeAt(0) || 0) % AVATAR_HUES.length];
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
              Companies
            </span>
            <span style={{ color: 'var(--ink-3)', fontWeight: 400 }}>—</span>
            <span className="mono" style={{ fontSize: 22 }}>
              {count}
            </span>
            {live && <span className="dot is-live" style={{ width: 8, height: 8, borderRadius: 999 }} />}
          </h1>
          <p style={{ margin: '6px 0 0', fontSize: 12.5, color: 'var(--ink-3)', display: 'flex', alignItems: 'center', gap: 8 }}>
            {search ? (
              <>
                Searching: <span style={{ color: 'var(--ink-2)', fontWeight: 500 }}>{search}</span>
              </>
            ) : (
              'Every company your agents have discovered and scored'
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
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Search by company name…"
            style={{ border: 'none', background: 'transparent', outline: 'none', font: 'inherit', color: 'inherit', width: 200 }}
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

        <span className="filter-pill" style={{ marginLeft: 'auto' }}>
          Sort by:
          <select value={sortBy} onChange={(e) => setSortBy(e.target.value as 'fit_score' | 'createdAt')}>
            <option value="fit_score">Fit score</option>
            <option value="createdAt">Newest</option>
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
          icon={Building2}
          title="No companies yet"
          description={
            search
              ? 'No companies match your search. Try a different name.'
              : 'Deploy an agent — discovered companies will show up here as they’re scored.'
          }
          action={
            <Link href="/agents/new" className="btn is-accent">
              <Rocket size={14} /> Deploy agent
            </Link>
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
                    className="pill"
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 10.5, color: 'var(--ink-3)' }}
                  >
                    <Users size={11} /> {c.size}
                  </span>
                ) : undefined
              }
              contactGlyph={
                c.hasPerson ? (
                  <PersonAvatar name={c.contactName} size={40} />
                ) : (
                  <span
                    style={{
                      width: 40,
                      height: 40,
                      borderRadius: 8,
                      display: 'grid',
                      placeItems: 'center',
                      background: 'var(--bg-soft)',
                      border: '1px solid var(--line)',
                      color: 'var(--ink-4)',
                    }}
                  >
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
          {count === 1 ? 'company' : 'companies'} shown
        </span>

        {(cursorStack.length > 1 || pagination?.hasMore) && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <button
              type="button"
              className="btn is-sm"
              disabled={cursorStack.length <= 1}
              onClick={() => setCursorStack((s) => s.slice(0, -1))}
            >
              ← Prev
            </button>
            <span className="mono" style={{ fontSize: 11 }}>
              Page {cursorStack.length}
            </span>
            <button
              type="button"
              className="btn is-sm"
              disabled={!pagination?.hasMore || !pagination?.nextCursor}
              onClick={() => {
                if (pagination?.nextCursor) setCursorStack((s) => [...s, pagination.nextCursor!]);
              }}
            >
              Next →
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
