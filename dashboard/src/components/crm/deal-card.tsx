'use client';

import { Card, CardContent } from '@/components/ui/card';
import { StageBadge } from './stage-badge';
import { cn } from '@/lib/utils';
import type { DealWithContact } from '@/types';

interface DealCardProps {
  deal: DealWithContact;
  className?: string;
  onClick?: () => void;
}

export function DealCard({ deal, className, onClick }: DealCardProps) {
  const contact = deal.contact;
  const contactName = contact
    ? [contact.firstName, contact.lastName].filter(Boolean).join(' ') || contact.email || 'Unknown'
    : 'Unknown';

  const formattedValue =
    deal.value != null && deal.value !== ''
      ? new Intl.NumberFormat('en-US', {
          style: 'currency',
          currency: deal.currency ?? 'USD',
          maximumFractionDigits: 0,
        }).format(Number(deal.value))
      : null;

  return (
    <Card
      className={cn(
        'cursor-pointer select-none transition-shadow hover:shadow-md active:shadow-sm',
        className,
      )}
      onClick={onClick}
    >
      <CardContent className="p-3 space-y-2">
        {/* Contact name */}
        <p className="text-sm font-semibold text-foreground leading-snug truncate">
          {contactName}
        </p>

        {/* Deal title */}
        <p className="text-xs text-muted-foreground truncate">{deal.title}</p>

        {/* Company */}
        {contact?.companyName && (
          <p className="text-xs text-muted-foreground truncate">{contact.companyName}</p>
        )}

        {/* Footer: value + stage badge */}
        <div className="flex items-center justify-between gap-2 pt-1">
          {formattedValue ? (
            <span className="text-xs font-medium text-emerald-400">{formattedValue}</span>
          ) : (
            <span />
          )}

          {deal.stage && <StageBadge stage={deal.stage} />}
        </div>
      </CardContent>
    </Card>
  );
}
