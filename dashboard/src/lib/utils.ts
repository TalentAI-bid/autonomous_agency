import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { format, formatDistanceToNow, parseISO } from 'date-fns';
import type { AgentType, ContactStatus } from '@/types';

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
    discovered: 'text-zinc-400 bg-zinc-800',
    enriched: 'text-blue-400 bg-blue-900/30',
    scored: 'text-purple-400 bg-purple-900/30',
    contacted: 'text-yellow-400 bg-yellow-900/30',
    replied: 'text-emerald-400 bg-emerald-900/30',
    qualified: 'text-green-400 bg-green-900/30',
    interview_scheduled: 'text-green-300 bg-green-900/40',
    rejected: 'text-red-400 bg-red-900/30',
    archived: 'text-zinc-500 bg-zinc-900',
    idle: 'text-zinc-400 bg-zinc-800',
    running: 'text-emerald-400 bg-emerald-900/30',
    paused: 'text-yellow-400 bg-yellow-900/30',
    error: 'text-red-400 bg-red-900/30',
    active: 'text-emerald-400 bg-emerald-900/30',
    completed: 'text-blue-400 bg-blue-900/30',
    failed: 'text-red-400 bg-red-900/30',
  };
  return map[status] ?? 'text-zinc-400 bg-zinc-800';
}

export function getAgentIcon(agentType: AgentType): string {
  const map: Record<AgentType, string> = {
    discovery: 'Search',
    document: 'FileText',
    enrichment: 'Database',
    scoring: 'Star',
    outreach: 'Mail',
    reply: 'MessageSquare',
    action: 'Calendar',
  };
  return map[agentType] ?? 'Bot';
}

export function getAgentLabel(agentType: AgentType): string {
  const map: Record<AgentType, string> = {
    discovery: 'Discovery',
    document: 'Document Parser',
    enrichment: 'Enrichment',
    scoring: 'Scoring',
    outreach: 'Outreach',
    reply: 'Reply Handler',
    action: 'Action Taker',
  };
  return map[agentType] ?? agentType;
}

export function getAgentDescription(agentType: AgentType): string {
  const map: Record<AgentType, string> = {
    discovery: 'Searches LinkedIn and web for matching profiles',
    document: 'Parses CVs and extracts structured data',
    enrichment: 'Finds emails, enriches company data',
    scoring: 'Scores candidates against requirements',
    outreach: 'Sends personalized emails via Claude AI',
    reply: 'Classifies replies and handles responses',
    action: 'Schedules interviews and creates reports',
  };
  return map[agentType] ?? '';
}

export function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen) + '…';
}

export function getScoreColor(score: number): string {
  if (score >= 80) return 'text-emerald-400';
  if (score >= 60) return 'text-yellow-400';
  if (score >= 40) return 'text-orange-400';
  return 'text-red-400';
}
