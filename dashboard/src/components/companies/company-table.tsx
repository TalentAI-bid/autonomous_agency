'use client';

import { useCompanies } from '@/hooks/use-companies';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { formatDate } from '@/lib/utils';
import type { CompanyFilters } from '@/types';
import Link from 'next/link';
import { ExternalLink, Building2 } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface CompanyTableProps {
  filters?: CompanyFilters;
}

export function CompanyTable({ filters }: CompanyTableProps) {
  const { data: res, isLoading } = useCompanies(filters);
  const companies = res?.data ?? [];
  const meta = res?.pagination;

  if (isLoading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-12" />)}
      </div>
    );
  }

  if (companies.length === 0) {
    return (
      <div className="text-center py-16 text-muted-foreground">
        <Building2 className="w-8 h-8 mx-auto mb-3" />
        <p className="font-medium">No companies found</p>
        <p className="text-sm mt-1">Companies will appear here once agents discover them</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {meta && (
        <p className="text-xs text-muted-foreground">
          Showing {companies.length} companies
        </p>
      )}
      <div className="rounded-lg border overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Domain</TableHead>
              <TableHead>Industry</TableHead>
              <TableHead>Size</TableHead>
              <TableHead>Tech Stack</TableHead>
              <TableHead>Funding</TableHead>
              <TableHead>Created</TableHead>
              <TableHead className="w-10"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {companies.map((company) => (
              <TableRow key={company.id} className="hover:bg-muted/30">
                <TableCell className="font-medium">
                  <div>
                    <p>{company.name}</p>
                    {company.linkedinUrl && (
                      <a
                        href={company.linkedinUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs text-blue-400 hover:underline"
                      >
                        LinkedIn
                      </a>
                    )}
                  </div>
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">{company.domain || '—'}</TableCell>
                <TableCell className="text-sm">{company.industry || '—'}</TableCell>
                <TableCell className="text-sm text-muted-foreground">{company.size || '—'}</TableCell>
                <TableCell>
                  <div className="flex flex-wrap gap-1 max-w-[200px]">
                    {(company.techStack ?? []).slice(0, 4).map((tech) => (
                      <Badge key={tech} variant="secondary" className="text-xs">
                        {tech}
                      </Badge>
                    ))}
                    {(company.techStack ?? []).length > 4 && (
                      <Badge variant="outline" className="text-xs">
                        +{(company.techStack ?? []).length - 4}
                      </Badge>
                    )}
                  </div>
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">{company.funding || '—'}</TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {formatDate(company.createdAt)}
                </TableCell>
                <TableCell>
                  <Link href={`/companies/${company.id}`}>
                    <Button variant="ghost" size="icon" className="h-7 w-7">
                      <ExternalLink className="w-3.5 h-3.5" />
                    </Button>
                  </Link>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
