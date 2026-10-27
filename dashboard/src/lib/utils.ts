import { type ClassValue, clsx } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';
import { format, formatDistanceToNow, parseISO } from 'date-fns';
import type { AgentType, ContactStatus } from '@/types';

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

export function formatNumber(n: number): string {
  return new Intl.NumberFormat().format(n);
}

export function formatPercent(n: number, decimals = 1): string {
  return `${(n * 100).toFixed(decimals)}%`;
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

export function getAgentIcon(agentType: AgentType): string {
  const map: Partial<Record<AgentType, string>> = {
    discovery: 'Search',
    document: 'FileText',
    enrichment: 'Database',
    scoring: 'Star',
    outreach: 'Mail',
    reply: 'MessageSquare',
    action: 'Calendar',
    strategy: 'Brain',
    strategist: 'Target',
    'email-listen': 'Inbox',
    'email-send': 'Send',
    mailbox: 'Mail',
    'reddit-monitor': 'Radio',
  };
  return map[agentType] ?? 'Bot';
}

export function getAgentLabel(agentType: AgentType): string {
  const map: Partial<Record<AgentType, string>> = {
    discovery: 'Discovery',
    document: 'Document Parser',
    enrichment: 'Enrichment',
    scoring: 'Scoring',
    outreach: 'Outreach',
    reply: 'Reply Handler',
    action: 'Action Taker',
    strategy: 'Strategy',
    strategist: 'Strategist',
    'email-listen': 'Email Listener',
    'email-send': 'Email Sender',
    mailbox: 'Mailbox',
    'reddit-monitor': 'Reddit Monitor',
  };
  return map[agentType] ?? agentType;
}

export function getAgentDescription(agentType: AgentType): string {
  const map: Partial<Record<AgentType, string>> = {
    discovery: 'Searches LinkedIn and web for matching profiles',
    document: 'Parses CVs and extracts structured data',
    enrichment: 'Finds emails, enriches company data',
    scoring: 'Scores candidates against requirements',
    outreach: 'Sends personalized emails via Claude AI',
    reply: 'Classifies replies and handles responses',
    action: 'Schedules interviews and creates reports',
    strategy: 'Analyzes performance and adapts daily strategy',
    strategist: 'Creates initial sales strategy and optimizes pipeline',
    'email-listen': 'Monitors inbound email',
    'email-send': 'Sends queued emails',
    mailbox: 'Manages email threads',
    'reddit-monitor': 'Monitors Reddit for opportunities',
  };
  return map[agentType] ?? '';
}

export function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen) + '…';
}

export function getScoreColor(score: number): string {
  if (score >= 80) return 'text-up';
  if (score >= 60) return 'text-warn-fg';
  if (score >= 40) return 'text-warn-fg';
  return 'text-down';
}
