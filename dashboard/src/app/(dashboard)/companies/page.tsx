'use client';

import { useEffect, useMemo, useState } from 'react';
import { Input } from '@/components/ui/input';
import { Building2, Search } from 'lucide-react';
import { useCompanies } from '@/hooks/use-companies';
import { useAgents } from '@/hooks/use-agents';
import { CompanyTable } from '@/components/companies/company-table';
import type { MasterAgent } from '@/types';

const PAGE_SIZE = 25;

export default function CompaniesPage() {
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [cursorStack, setCursorStack] = useState<Array<string | null>>([null]);

  // Debounce the search input so we don't refetch on every keystroke.
  useEffect(() => {
    const t = setTimeout(() => {
      setSearch(searchInput.trim());
      setCursorStack([null]);
    }, 250);
    return () => clearTimeout(t);
  }, [searchInput]);

  const currentCursor = cursorStack[cursorStack.length - 1] ?? undefined;

  const { data: res, isLoading } = useCompanies({
    search: search || undefined,
    sortBy: 'fit_score',
    cursor: currentCursor,
    limit: PAGE_SIZE,
    includeIncomplete: true,
  });
  const { data: agents } = useAgents();

  const companies = res?.data ?? [];
  const pagination = res?.pagination;

  const agentsById = useMemo(() => {
    const map = new Map<string, MasterAgent>();
    for (const agent of agents ?? []) map.set(agent.id, agent);
    return map;
  }, [agents]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Building2 className="w-6 h-6 text-muted-foreground" />
            Companies
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            All companies discovered by agents in this workspace.
          </p>
        </div>
        <div className="relative w-full sm:w-80">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
          <Input
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Search by company name…"
            className="pl-9"
            type="search"
          />
        </div>
      </div>

      {!isLoading && pagination && (
        <p className="text-xs text-muted-foreground">
          Showing {companies.length} companies
          {search ? ` matching "${search}"` : ''}
        </p>
      )}

      <CompanyTable
        companies={companies}
        agentsById={agentsById}
        isLoading={isLoading}
      />

      {(cursorStack.length > 1 || pagination?.hasMore) && (
        <div className="flex items-center justify-between pt-2">
          <button
            type="button"
            disabled={cursorStack.length <= 1}
            onClick={() => setCursorStack((s) => s.slice(0, -1))}
            className="text-xs px-3 py-1.5 rounded border bg-background hover:bg-muted/50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            ← Previous
          </button>
          <span className="text-xs text-muted-foreground">
            Page {cursorStack.length}
          </span>
          <button
            type="button"
            disabled={!pagination?.hasMore || !pagination?.nextCursor}
            onClick={() => {
              if (pagination?.nextCursor) {
                setCursorStack((s) => [...s, pagination.nextCursor!]);
              }
            }}
            className="text-xs px-3 py-1.5 rounded border bg-background hover:bg-muted/50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            Next →
          </button>
        </div>
      )}
    </div>
  );
}
