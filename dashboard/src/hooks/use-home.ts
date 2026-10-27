'use client';

import { useMemo } from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import { apiGet } from '@/lib/api';
import { useAgents } from '@/hooks/use-agents';
import { useDashboardAnalytics } from '@/hooks/use-analytics';
import { useEmailAccounts, useEmailListeners } from '@/hooks/use-email-settings';
import { useMailboxDigest, useMailboxThreads } from '@/hooks/use-mailbox';
import { useQueue } from '@/hooks/use-queue';
import type { MasterAgent, QuotaStatus } from '@/types';

/* ─── Not-yet-available inputs ─────────────────────────────────────────
   The Home design needs a few things the backend does not expose yet. The UI is
   built against these shapes so it only needs the data swapped in:

   - SCORE_BAR     per-workspace "a lead clears the bar at N" threshold (today an
                   internal gate in the enrichment agent, not a setting).
   - WINDOW_DAYS   the stats window. GET /analytics/dashboard is all-time, so the
                   stat cards fall back to all-time numbers and say so.
   - search        the top-bar search has no endpoint.
*/
export const SCORE_BAR: number | null = null;
export const WINDOW_DAYS = 30;
const STATS_ARE_WINDOWED = false;

const PLACEHOLDER_TOKEN = /\[[A-Z][A-Z _]{2,}\]/;

export function ago(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '';
  const ms = Math.max(0, now - new Date(iso).getTime());
  const min = Math.round(ms / 60000);
  if (min < 60) return `${Math.max(1, min)} minute${min === 1 ? '' : 's'}`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h} hour${h === 1 ? '' : 's'}`;
  const d = Math.round(h / 24);
  return `${d} day${d === 1 ? '' : 's'}`;
}

function utcClock(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')} UTC`;
}

export interface NeedItem {
  key: 'approvals' | 'replies' | 'placeholder';
  title: string;
  subtitle: string;
  href: string;
  actionLabel: string;
  tone: 'accent' | 'warn';
  /** epoch ms, used for "newest first"; null sorts last */
  at: number | null;
}

export type ConnState = 'on' | 'warn' | 'off';
export interface ConnectionInfo {
  key: 'reply' | 'linkedin';
  label: string;
  state: ConnState;
  pill: string;
  detail: string;
  actionLabel: string;
  href: string;
}

export interface AgentRowInfo {
  id: string;
  name: string;
  tone: 'warn' | 'muted' | 'up' | 'down';
  statusLabel: string;
  leads: number | null;
  contacted: number | null;
  replies: number | null;
}

function agentStatus(a: MasterAgent): Pick<AgentRowInfo, 'tone' | 'statusLabel'> {
  const status = a.status as string;
  const reason = (a.config as Record<string, unknown> | undefined)?.pauseReason;
  if (status === 'running') return { tone: 'up', statusLabel: 'Running' };
  if (status === 'paused_quota') return { tone: 'warn', statusLabel: 'Paused — daily quota reached, resets 00:00 UTC' };
  if (status === 'paused' && reason === 'extension_required') return { tone: 'warn', statusLabel: 'Paused — connect the LinkedIn extension' };
  if (status === 'paused') return { tone: 'muted', statusLabel: 'Paused by you' };
  if (status === 'error') return { tone: 'down', statusLabel: 'Needs attention' };
  if (status === 'awaiting_action_plan') return { tone: 'muted', statusLabel: 'Waiting for your plan approval' };
  return { tone: 'muted', statusLabel: 'Idle' };
}

export function useHomeData() {
  const queue = useQueue();
  const digest = useMailboxDigest();
  const threads = useMailboxThreads({ status: 'needs_action', limit: 3 });
  const accounts = useEmailAccounts();
  const listeners = useEmailListeners();
  const analytics = useDashboardAnalytics();
  const agents = useAgents();
  const ext = useQuery({
    queryKey: ['ext-status'],
    queryFn: () => apiGet<{ connected: boolean; lastSeenAt?: string | null; hasKey?: boolean }>('/extension/status'),
    staleTime: 30000,
  });

  const accountList = accounts.data ?? [];
  const quotas = useQueries({
    queries: accountList.map((a) => ({
      queryKey: ['email-accounts', a.id, 'quota'],
      queryFn: () => apiGet<QuotaStatus>(`/email-accounts/${a.id}/quota-status`),
      staleTime: 30000,
    })),
  });

  const agentList = agents.data ?? [];
  const agentStats = useQueries({
    queries: agentList.slice(0, 6).map((a) => ({
      queryKey: ['agents', a.id, 'stats'],
      queryFn: () => apiGet<{ totalContacts: number; byStatus: Record<string, number>; avgScore: number | null }>(`/master-agents/${a.id}/stats`),
      staleTime: 15000,
    })),
  });

  return useMemo(() => {
    const now = Date.now();
    const q = queue.data;
    const needsAction = digest.data?.needsAction ?? 0;
    const pendingThreads = threads.data?.data ?? [];

    // ── Needs you today ────────────────────────────────────────────────
    const actions = (q?.buckets ?? []).flatMap((b) => b.actions.map((r) => r.action));
    const generated = actions.map((a) => new Date(a.generatedAt).getTime()).filter(Number.isFinite);
    const earliest = generated.length ? Math.min(...generated) : null;
    const latestDraft = generated.length ? Math.max(...generated) : null;

    const placeholderInDrafts = actions
      .map((a) => (a.draftBody ?? '').match(PLACEHOLDER_TOKEN)?.[0])
      .find(Boolean);
    const senderNamed = accountList.some((a) => (a.fromName ?? '').trim().length > 0);
    const placeholderToken = placeholderInDrafts ?? (accountList.length > 0 && !senderNamed ? '[YOUR FIRST NAME]' : null);

    const needs: NeedItem[] = [];
    if ((q?.count ?? 0) > 0) {
      const n = q!.count;
      needs.push({
        key: 'approvals',
        title: `${n} message${n === 1 ? '' : 's'} waiting for your approval`,
        subtitle: `About ${q!.etaMinutes} minutes${earliest ? ` · drafted at ${utcClock(new Date(earliest).toISOString())}` : ''}`,
        href: '/queue',
        actionLabel: 'Review',
        tone: 'accent',
        at: latestDraft,
      });
    }
    if (needsAction > 0) {
      const who = pendingThreads
        .slice(0, 2)
        .map((t) => {
          const name = t.contactName ?? t.contactEmail ?? 'Someone';
          const ask = (t.summary ?? t.nextAction ?? '').trim();
          return ask ? `${name}: ${ask}` : name;
        })
        .join(' · ');
      const last = pendingThreads[0]?.lastMessageAt;
      needs.push({
        key: 'replies',
        title: `${needsAction} repl${needsAction === 1 ? 'y needs' : 'ies need'} an answer`,
        subtitle: who || 'Open the inbox to read them.',
        href: '/mailbox',
        actionLabel: 'Open inbox',
        tone: 'accent',
        at: last ? new Date(last).getTime() : null,
      });
    }
    if (placeholderToken) {
      needs.push({
        key: 'placeholder',
        title: 'Sender name is still a placeholder',
        subtitle: `Every draft carries ${placeholderToken} until you change it. Nothing sends before that.`,
        href: '/settings/email',
        actionLabel: 'Fix it',
        tone: 'warn',
        at: null,
      });
    }
    needs.sort((a, b) => (b.at ?? -1) - (a.at ?? -1));

    // ── Connections ────────────────────────────────────────────────────
    const quotaData = quotas.map((x) => x.data).filter(Boolean) as QuotaStatus[];
    const dailyUsed = quotaData.reduce((s, x) => s + x.dailyUsed, 0);
    const dailyLimit = quotaData.reduce((s, x) => s + x.dailyLimit, 0);
    const activeAccounts = accountList.filter((a) => a.isActive);
    const sending = {
      state: (activeAccounts.length === 0 ? 'off' : quotaData.some((x) => !x.available) ? 'warn' : 'on') as ConnState,
      text:
        activeAccounts.length === 0
          ? 'No mailbox connected'
          : `${quotaData.some((x) => !x.available) ? 'Sending is at its limit' : 'Sending is healthy'} · ${dailyUsed} of ${dailyLimit} today`,
    };

    const watched = new Set((listeners.data ?? []).filter((l) => l.isActive).map((l) => l.emailAccountId));
    const unwatched = activeAccounts.filter((a) => !watched.has(a.id));
    const replyConn: ConnectionInfo = {
      key: 'reply',
      label: 'Reply detection',
      state: activeAccounts.length === 0 || unwatched.length > 0 ? 'warn' : 'on',
      pill: activeAccounts.length === 0 || unwatched.length > 0 ? 'Not connected' : 'Connected',
      detail:
        activeAccounts.length === 0
          ? 'Connect a mailbox first, then something can watch it for replies.'
          : unwatched.length > 0
            ? `Nothing is watching ${unwatched[0]!.fromEmail}, so replies cannot reach your Inbox.`
            : 'Replies are being picked up and sent to your Inbox.',
      actionLabel: 'Connect',
      href: '/settings/email',
    };

    const seen = ext.data?.lastSeenAt ?? null;
    const staleMs = seen ? now - new Date(seen).getTime() : Infinity;
    const linkedinOn = !!ext.data?.connected && staleMs < 36 * 3600 * 1000;
    const linkedin: ConnectionInfo = {
      key: 'linkedin',
      label: 'LinkedIn',
      state: linkedinOn ? 'on' : 'warn',
      pill: linkedinOn ? 'Connected' : seen ? `Extension not seen for ${ago(seen)}` : 'Extension not installed',
      detail: linkedinOn
        ? 'Connection requests and messages are going out.'
        : seen
          ? 'Chrome may have turned it off. Connection requests will not send until it is back.'
          : 'Install the Chrome extension so agents can send connection requests.',
      actionLabel: 'Open extension page',
      href: '/linkedin-extension',
    };

    // ── Stats ──────────────────────────────────────────────────────────
    const byStatus = analytics.data?.contacts.byStatus ?? {};
    const totalLeads = analytics.data?.contacts.total ?? 0;
    const discovered = byStatus.discovered ?? 0;
    const scored = totalLeads - discovered - (byStatus.enriched ?? 0);
    const sent = analytics.data?.emails.sent ?? 0;
    const replied = analytics.data?.emails.replied ?? 0;
    const meetings = analytics.data?.interviews.scheduled ?? 0;
    const stats = {
      windowed: STATS_ARE_WINDOWED,
      windowDays: WINDOW_DAYS,
      approvedSent: sent,
      reviewed: null as number | null, // needs the date-ranged endpoint
      skipped: null as number | null,
      replies: replied,
      replyRate: sent > 0 ? (replied / sent) * 100 : null,
      stillWaiting: needsAction,
      meetings,
      scored: Math.max(0, scored),
      discovered: totalLeads,
      cleared: null as number | null, // needs SCORE_BAR + the endpoint
      bar: SCORE_BAR,
    };

    // ── Agents ─────────────────────────────────────────────────────────
    const agentRows: AgentRowInfo[] = agentList.slice(0, 6).map((a, i) => {
      const s = agentStats[i]?.data;
      return {
        id: a.id,
        name: a.name,
        ...agentStatus(a),
        leads: s ? s.totalContacts : null,
        contacted: s ? (s.byStatus.contacted ?? 0) + (s.byStatus.replied ?? 0) + (s.byStatus.qualified ?? 0) + (s.byStatus.interview_scheduled ?? 0) : null,
        replies: s ? (s.byStatus.replied ?? 0) + (s.byStatus.qualified ?? 0) + (s.byStatus.interview_scheduled ?? 0) : null,
      };
    });

    return {
      isLoading: queue.isLoading || digest.isLoading || analytics.isLoading || agents.isLoading,
      needs,
      sending,
      connections: [replyConn, linkedin],
      stats,
      agents: agentRows,
      agentCount: agentList.length,
    };
  }, [queue.data, queue.isLoading, digest.data, digest.isLoading, threads.data, accountList, quotas, listeners.data, ext.data, analytics.data, analytics.isLoading, agentList, agentStats, agents.isLoading]);
}
