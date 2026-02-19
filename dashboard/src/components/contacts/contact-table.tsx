'use client';

import { useContacts } from '@/hooks/use-contacts';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { formatDate } from '@/lib/utils';
import type { ContactFilters } from '@/types';
import Link from 'next/link';
import { ExternalLink, Mail } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface ContactTableProps {
  filters?: ContactFilters;
}

function scoreColor(score: number) {
  if (score >= 80) return 'text-emerald-500';
  if (score >= 60) return 'text-amber-500';
  if (score > 0) return 'text-rose-500';
  return 'text-muted-foreground';
}

function statusVariant(status: string): 'default' | 'secondary' | 'success' | 'warning' | 'error' | 'outline' {
  const map: Record<string, 'default' | 'secondary' | 'success' | 'warning' | 'error' | 'outline'> = {
    discovered: 'secondary',
    enriched: 'outline',
    scored: 'warning',
    contacted: 'success',
    replied: 'success',
    rejected: 'error',
    archived: 'secondary',
  };
  return map[status] ?? 'secondary';
}

export function ContactTable({ filters }: ContactTableProps) {
  const { data: res, isLoading } = useContacts(filters);
  const contacts = res?.data ?? [];
  const meta = res?.pagination;

  if (isLoading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-12" />)}
      </div>
    );
  }

  if (contacts.length === 0) {
    return (
      <div className="text-center py-16 text-muted-foreground">
        <Mail className="w-8 h-8 mx-auto mb-3" />
        <p className="font-medium">No contacts found</p>
        <p className="text-sm mt-1">Contacts will appear here once agents discover candidates</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {meta && (
        <p className="text-xs text-muted-foreground">
          Showing {contacts.length} of {meta.total} contacts
        </p>
      )}
      <div className="rounded-lg border overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Title</TableHead>
              <TableHead>Company</TableHead>
              <TableHead>Location</TableHead>
              <TableHead>Score</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Discovered</TableHead>
              <TableHead className="w-10"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {contacts.map((contact) => (
              <TableRow key={contact.id} className="hover:bg-muted/30">
                <TableCell className="font-medium">
                  <div>
                    <p>{[contact.firstName, contact.lastName].filter(Boolean).join(' ') || '—'}</p>
                    {contact.email && (
                      <p className="text-xs text-muted-foreground">{contact.email}</p>
                    )}
                  </div>
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">{contact.title || '—'}</TableCell>
                <TableCell className="text-sm">{contact.companyName || '—'}</TableCell>
                <TableCell className="text-sm text-muted-foreground">{contact.location || '—'}</TableCell>
                <TableCell>
                  {(contact.score ?? 0) > 0 ? (
                    <span className={`font-semibold tabular-nums ${scoreColor(contact.score ?? 0)}`}>
                      {contact.score}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </TableCell>
                <TableCell>
                  <Badge variant={statusVariant(contact.status)}>
                    {contact.status}
                  </Badge>
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {formatDate(contact.createdAt)}
                </TableCell>
                <TableCell>
                  <Link href={`/contacts/${contact.id}`}>
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
