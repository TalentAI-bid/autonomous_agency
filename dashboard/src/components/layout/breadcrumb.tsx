'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ChevronRight, Home } from 'lucide-react';
import { cn } from '@/lib/utils';

const labels: Record<string, string> = {
  dashboard: 'Dashboard',
  agents: 'Agents',
  new: 'New Agent',
  contacts: 'Contacts',
  campaigns: 'Campaigns',
  documents: 'Documents',
  analytics: 'Analytics',
  settings: 'Settings',
  config: 'Configuration',
  chat: 'Chat',
};

export function Breadcrumb() {
  const pathname = usePathname();
  const segments = pathname.split('/').filter(Boolean);

  const crumbs = segments.map((seg, i) => {
    const href = '/' + segments.slice(0, i + 1).join('/');
    const label = labels[seg] ?? (seg.length === 36 ? '…' : seg);
    const isLast = i === segments.length - 1;
    return { href, label, isLast };
  });

  return (
    <nav className="flex items-center gap-1 text-sm">
      <Link href="/dashboard" className="text-muted-foreground hover:text-foreground">
        <Home className="w-3.5 h-3.5" />
      </Link>
      {crumbs.map(({ href, label, isLast }) => (
        <span key={href} className="flex items-center gap-1">
          <ChevronRight className="w-3.5 h-3.5 text-muted-foreground" />
          {isLast ? (
            <span className="font-medium">{label}</span>
          ) : (
            <Link href={href} className={cn('text-muted-foreground hover:text-foreground')}>
              {label}
            </Link>
          )}
        </span>
      ))}
    </nav>
  );
}
