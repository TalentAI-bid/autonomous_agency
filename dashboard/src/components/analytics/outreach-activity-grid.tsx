'use client';

import { Skeleton } from '@/components/ui/skeleton';
import { Mail, MessageSquare, UserPlus, UserCheck, Reply, type LucideIcon } from 'lucide-react';
import { useOutreachActivity } from '@/hooks/use-analytics';
import { HomeSection, RowIcon } from '@/components/home/home-parts';

export function OutreachActivityGrid() {
  const { data, isLoading } = useOutreachActivity();

  if (isLoading) return <Skeleton className="h-64 rounded-xl" />;

  const rows: { label: string; sub: string; value: number; icon: LucideIcon }[] = [
    { label: 'Emails sent', sub: 'Outreach emails', value: data?.emailsSent ?? 0, icon: Mail },
    { label: 'LinkedIn messages', sub: 'DMs sent', value: data?.linkedinMessagesSent ?? 0, icon: MessageSquare },
    { label: 'Connection notes', sub: 'People added with a note', value: data?.personsAddedWithNote ?? 0, icon: UserPlus },
    { label: 'Connections', sub: 'Accepted requests', value: data?.connectionsAccepted ?? 0, icon: UserCheck },
    { label: 'Responses', sub: 'People who replied', value: data?.responses ?? 0, icon: Reply },
  ];
  const max = Math.max(...rows.map((r) => r.value), 1);

  return (
    <HomeSection title="Outreach activity" meta="Email and LinkedIn, all agents">
      {rows.map(({ label, sub, value, icon: Icon }) => (
        <div key={label} className="flex items-center gap-3 border-t border-line px-4 py-3">
          <RowIcon>
            <Icon size={15} />
          </RowIcon>
          <div className="w-[170px] shrink-0">
            <div className="text-body font-medium text-ink">{label}</div>
            <div className="truncate text-xs text-ink-3">{sub}</div>
          </div>
          <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-bg-soft">
            <div className="h-full rounded-full bg-accent transition-all duration-500" style={{ width: `${(value / max) * 100}%` }} />
          </div>
          <span className="w-12 shrink-0 text-right font-mono text-body font-medium tabular-nums text-ink">{value.toLocaleString()}</span>
        </div>
      ))}
    </HomeSection>
  );
}
