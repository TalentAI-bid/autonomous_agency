'use client';

import { useState } from 'react';
import { CompanyTable } from '@/components/companies/company-table';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Search } from 'lucide-react';
import type { CompanyFilters } from '@/types';

const INDUSTRY_OPTIONS = ['Technology', 'Finance', 'Healthcare', 'SaaS', 'E-commerce', 'AI/ML'];

export default function CompaniesPage() {
  const [search, setSearch] = useState('');
  const [activeIndustry, setActiveIndustry] = useState<string | undefined>();

  const filters: CompanyFilters = {
    search: search || undefined,
    industry: activeIndustry,
    limit: 50,
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Companies</h1>
        <p className="text-muted-foreground text-sm mt-1">All discovered and enriched companies</p>
      </div>

      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            placeholder="Search by name, domain..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>
        <div className="flex gap-2 flex-wrap">
          <Button
            variant={activeIndustry === undefined ? 'default' : 'outline'}
            size="sm"
            onClick={() => setActiveIndustry(undefined)}
          >
            All
          </Button>
          {INDUSTRY_OPTIONS.map((ind) => (
            <Button
              key={ind}
              variant={activeIndustry === ind ? 'default' : 'outline'}
              size="sm"
              onClick={() => setActiveIndustry(activeIndustry === ind ? undefined : ind)}
            >
              {ind}
            </Button>
          ))}
        </div>
      </div>

      <CompanyTable filters={filters} />
    </div>
  );
}
