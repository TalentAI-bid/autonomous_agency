'use client';

import Link from 'next/link';
import { useRouter, usePathname } from 'next/navigation';
import { ChevronRight, Home, ArrowLeft } from 'lucide-react';
import { cn } from '@/lib/utils';

const labels: Record<string, string> = {
  dashboard: 'Dashboard',
  agents: 'Agents',
  new: 'New Agent',
  contacts: 'Contacts',
  companies: 'Companies',
  campaigns: 'Campaigns',
  documents: 'Documents',
  analytics: 'Analytics',
  settings: 'Settings',
  config: 'Configuration',
  chat: 'Chat',
  crm: 'Pipeline',
  deals: 'Deals',
  mailbox: 'Inbox',
  schedule: 'Meetings',
  email: 'Email Accounts',
  team: 'Team',
  company: 'Company Profile',
  products: 'Products',
  extension: 'Extension',
  'linkedin-extension': 'LinkedIn Extension',
  opportunities: 'Opportunities',
  strategy: 'Strategy',
  room: 'Agent Room',
};

export interface BreadcrumbItem {
  /** If omitted, the item is rendered as the current page (last, non-clickable). */
  href?: string;
  label: string;
}

interface BreadcrumbProps {
  /**
   * Explicit items override URL-based parsing. Use this on detail pages
   * (e.g. contact/[id]) so the last segment shows the entity name instead
   * of its UUID.
   */
  items?: BreadcrumbItem[];
  /**
   * Show a "← Back" button at the start that uses router.back() with the
   * given fallback URL. Defaults to false.
   */
  showBack?: boolean;
  /** Where to navigate if there's no browser history. */
  backFallback?: string;
  className?: string;
}

export function Breadcrumb({ items, showBack = false, backFallback = '/dashboard', className }: BreadcrumbProps) {
  const router = useRouter();
  const pathname = usePathname();

  const crumbs: BreadcrumbItem[] = items ?? (() => {
    const segments = pathname.split('/').filter(Boolean);
    return segments.map((seg, i) => {
      const href = '/' + segments.slice(0, i + 1).join('/');
      // UUID v4 segments collapse to '…'; explicit `items` is the fix.
      const label = labels[seg] ?? (seg.length === 36 ? '…' : seg);
      const isLast = i === segments.length - 1;
      return { href: isLast ? undefined : href, label };
    });
  })();

  function handleBack() {
    if (typeof window !== 'undefined' && window.history.length > 1) {
      router.back();
    } else {
      router.push(backFallback);
    }
  }

  return (
    <nav className={cn('flex items-center gap-1 text-sm flex-wrap', className)}>
      {showBack && (
        <button
          type="button"
          onClick={handleBack}
          className="mr-2 inline-flex items-center gap-1 rounded-md border border-input px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground"
          aria-label="Back"
        >
          <ArrowLeft className="w-3.5 h-3.5" />
          Back
        </button>
      )}
      <Link href="/dashboard" className="text-muted-foreground hover:text-foreground" aria-label="Dashboard">
        <Home className="w-3.5 h-3.5" />
      </Link>
      {crumbs.map((c, i) => (
        <span key={`${c.href ?? 'last'}-${i}`} className="flex items-center gap-1 min-w-0">
          <ChevronRight className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
          {c.href ? (
            <Link href={c.href} className="text-muted-foreground hover:text-foreground truncate">
              {c.label}
            </Link>
          ) : (
            <span className="font-medium truncate">{c.label}</span>
          )}
        </span>
      ))}
    </nav>
  );
}
