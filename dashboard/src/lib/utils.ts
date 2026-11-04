import { type ClassValue, clsx } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';
import { format, formatDistanceToNow, parseISO } from 'date-fns';
import type { ContactStatus } from '@/types';

// Teach tailwind-merge the custom font-size steps (tailwind.config.ts), otherwise
// it reads text-label / text-2xs as colors and drops the real color class.
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      'font-size': [{ text: ['3xs', '2xs', 'xs', 'label', 'body', 'title', 'stat', 'hero'] }],
      rounded: [{ rounded: ['tag', 'chip', 'row', 'card', 'panel'] }],
    },
  },
});

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

export function formatDate(date: string | Date, pattern = 'MMM d, yyyy'): string {
  const d = typeof date === 'string' ? parseISO(date) : date;
  return format(d, pattern);
}

export function formatRelative(date: string | Date): string {
  const d = typeof date === 'string' ? parseISO(date) : date;
  return formatDistanceToNow(d, { addSuffix: true });
}

/** Display text of a research item that may be a string or a {value, citation} object. */
export function citedText(item: unknown): string {
  if (item == null) return '';
  if (typeof item === 'string') return item;
  if (typeof item === 'object') {
    const o = item as { value?: unknown; claim?: unknown; name?: unknown };
    return String(o.value ?? o.claim ?? o.name ?? '');
  }
  return String(item);
}

export function formatNumber(n: number): string {
  return new Intl.NumberFormat().format(n);
}

export function getStatusColor(status: ContactStatus | string): string {
  const map: Record<string, string> = {
    discovered: 'text-ink-3 bg-bg-soft',
    enriched: 'text-info bg-info/10',
    scored: 'text-a-master bg-a-master/10',
    contacted: 'text-warn-fg bg-warn/10',
    replied: 'text-up bg-up/10',
    qualified: 'text-up bg-up/10',
    interview_scheduled: 'text-up bg-up/15',
    rejected: 'text-down bg-down/10',
    archived: 'text-ink-3 bg-bg-soft',
    idle: 'text-ink-3 bg-bg-soft',
    running: 'text-up bg-up/10',
    paused: 'text-warn-fg bg-warn/10',
    error: 'text-down bg-down/10',
    active: 'text-up bg-up/10',
    completed: 'text-info bg-info/10',
    failed: 'text-down bg-down/10',
  };
  return map[status] ?? 'text-ink-3 bg-bg-soft';
}

