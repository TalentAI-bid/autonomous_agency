import Link from 'next/link';
import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardSection } from '@/components/ui/card';

/** Titled card whose body is a list of rows. Thin wrapper over CardSection. */
export function HomeSection({
  title,
  meta,
  children,
  className,
}: {
  title: ReactNode;
  meta?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <CardSection title={title} meta={meta} layout="rows" className={className}>
      {children}
    </CardSection>
  );
}

export function HomeAction({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Button size="sm" asChild variant="panel" className="shrink-0">
      <Link href={href}>{children}</Link>
    </Button>
  );
}

/** Round leading icon used by every row. */
export function RowIcon({ tone = 'accent', children }: { tone?: 'accent' | 'warn' | 'muted'; children: ReactNode }) {
  return (
    <span
      className={cn(
        'grid size-8 shrink-0 place-items-center rounded-full',
        tone === 'accent' && 'bg-accent-weak text-accent',
        tone === 'warn' && 'bg-warn/15 text-warn-fg',
        tone === 'muted' && 'bg-bg-soft text-ink-3',
      )}
    >
      {children}
    </span>
  );
}

export function StatusPill({
  tone,
  children,
}: {
  tone: 'warn' | 'muted' | 'up' | 'down';
  children: ReactNode;
}) {
  return (
    <Badge variant={tone} dot className="shrink-0">
      {children}
    </Badge>
  );
}

/** Small stat card: caps label, big value (with a lighter "of N" tail), detail line. */
export function StatCard({
  label,
  value,
  tail,
  detail,
  muted,
}: {
  label: string;
  value: ReactNode;
  tail?: ReactNode;
  detail?: ReactNode;
  muted?: boolean;
}) {
  return (
    <Card className="p-4">
      <div className="text-2xs font-medium uppercase tracking-[0.09em] text-ink-4">{label}</div>
      <div className={cn('mt-2 flex items-baseline gap-1.5 text-[18px] font-semibold leading-none', muted ? 'text-ink-4' : 'text-ink')}>
        <span>{value}</span>
        {tail && <span className={cn('text-[18px] font-semibold', muted ? 'text-ink-4' : 'text-ink')}>{tail}</span>}
      </div>
      {detail && <div className="mt-2.5 text-xs text-ink-3">{detail}</div>}
    </Card>
  );
}

/** Small rounded label used for tags, skills and categories. Thin wrapper over Badge. */
export function Chip({
  children,
  tone = 'soft',
  title,
  className,
}: {
  children: ReactNode;
  tone?: 'soft' | 'accent' | 'down' | 'warn' | 'up';
  title?: string;
  className?: string;
}) {
  return (
    <Badge variant={tone} title={title} className={className}>
      {children}
    </Badge>
  );
}

/** Icon + text title for a HomeSection header. */
export function SectionTitle({ icon: Icon, children }: { icon: LucideIcon; children: ReactNode }) {
  return (
    <span className="flex items-center gap-2">
      <Icon size={14} className="text-ink-3" /> {children}
    </span>
  );
}
