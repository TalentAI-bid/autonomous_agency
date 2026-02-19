'use client';

import { useState } from 'react';
import { ContactTable } from '@/components/contacts/contact-table';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Search, Filter, Download } from 'lucide-react';
import type { ContactFilters } from '@/types';

const STATUS_OPTIONS = ['discovered', 'enriched', 'scored', 'contacted', 'replied', 'rejected', 'archived'];

export default function ContactsPage() {
  const [search, setSearch] = useState('');
  const [activeStatus, setActiveStatus] = useState<string | undefined>();
  const [minScore, setMinScore] = useState<number | undefined>();

  const filters: ContactFilters = {
    search: search || undefined,
    status: activeStatus as ContactFilters['status'],
    minScore,
    limit: 50,
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Contacts</h1>
          <p className="text-muted-foreground text-sm mt-1">All discovered and enriched candidates</p>
        </div>
        <Button variant="outline" size="sm">
          <Download className="w-4 h-4 mr-2" />
          Export
        </Button>
      </div>

      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            placeholder="Search by name, email, company..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>
        <div className="flex gap-2 flex-wrap">
          <Button
            variant={activeStatus === undefined ? 'default' : 'outline'}
            size="sm"
            onClick={() => setActiveStatus(undefined)}
          >
            All
          </Button>
          {STATUS_OPTIONS.map((s) => (
            <Button
              key={s}
              variant={activeStatus === s ? 'default' : 'outline'}
              size="sm"
              onClick={() => setActiveStatus(activeStatus === s ? undefined : s)}
            >
              {s}
            </Button>
          ))}
        </div>
        {minScore !== undefined && (
          <Badge variant="outline" className="cursor-pointer" onClick={() => setMinScore(undefined)}>
            Score ≥ {minScore} ×
          </Badge>
        )}
      </div>

      <ContactTable filters={filters} />
    </div>
  );
}
