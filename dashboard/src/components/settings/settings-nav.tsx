'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';

interface SettingsNavItem {
  label: string;
  /** Omitted for sections that have no page yet. */
  href?: string;
  /** Extra path prefixes that belong to this section. */
  also?: string[];
}

const SETTINGS_NAV: SettingsNavItem[] = [
  { label: 'Company', href: '/settings/company' },
  { label: 'Products', href: '/settings/products' },
  { label: 'Messaging', href: '/settings/messaging' },
  { label: 'Email & replies', href: '/settings/email' },
  { label: 'Browser extension', href: '/settings/extension' },
  { label: 'Team', href: '/settings/team' },
  { label: 'Plan' },
  { label: 'Security' },
  { label: 'API', href: '/settings/api' },
];

function isActive(item: SettingsNavItem, pathname: string) {
  if (!item.href) return false;
  return [item.href, ...(item.also ?? [])].some((p) => pathname === p || pathname.startsWith(p + '/'));
}

/** Name of the settings section for a path, used as the top-bar subtitle. */
export function settingsSectionFor(pathname: string) {
  return SETTINGS_NAV.find((i) => isActive(i, pathname))?.label ?? '';
}

export function SettingsNav() {
  const pathname = usePathname();
  return (
    <nav aria-label="Settings" className="flex shrink-0 gap-1 overflow-x-auto md:w-[150px] md:flex-col md:overflow-visible">
      {SETTINGS_NAV.map((item) => {
        // Same shape as the sidebar items so the two menus read as one system.
        const base = 'flex h-8 items-center whitespace-nowrap rounded-card border px-2.5 text-body';
        if (!item.href) {
          return (
            <span
              key={item.label}
              title="Coming soon"
              aria-disabled="true"
              className={cn(base, 'cursor-default border-transparent text-ink-4')}
            >
              {item.label}
            </span>
          );
        }
        const active = isActive(item, pathname);
        return (
          <Link
            key={item.label}
            href={item.href}
            aria-current={active ? 'page' : undefined}
            className={cn(
              base,
              'transition-colors',
              active
                ? 'border-accent-mid bg-accent-weak font-medium text-accent-fg'
                : 'border-transparent text-ink-2 hover:bg-bg-soft hover:text-ink',
            )}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
