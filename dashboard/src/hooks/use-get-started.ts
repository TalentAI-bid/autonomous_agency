'use client';

import { useMemo } from 'react';
import { useAgents } from '@/hooks/use-agents';
import { useCompanyProfile } from '@/hooks/use-company-profile';
import { useEmailAccounts, useEmailListeners } from '@/hooks/use-email-settings';
import { useMessagingConfig } from '@/hooks/use-studio';
import { useAuthStore } from '@/stores/auth.store';

export interface GetStartedStep {
  key: 'workspace' | 'profile' | 'sender' | 'mailbox' | 'replies' | 'agent';
  title: string;
  /** shown under the title while the step is not done */
  pending: string;
  /** shown under the title once the step is done */
  doneText: string;
  /** placeholder token to render as a code chip inside `pending`, if any */
  token?: string;
  href: string;
  cta: string;
  done: boolean;
}

const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six'];
export const numberWord = (n: number) => WORDS[n] ?? String(n);

function shortDate(iso?: string) {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

/**
 * The six first-run steps, in order. Each reuses the query its settings page
 * already uses, so progress updates as the user completes steps elsewhere.
 */
export function useGetStarted() {
  const tenant = useAuthStore((s) => s.tenant);
  const profile = useCompanyProfile();
  const messaging = useMessagingConfig();
  const accounts = useEmailAccounts();
  const listeners = useEmailListeners();
  const agents = useAgents();

  const isLoading = profile.isLoading || messaging.isLoading || accounts.isLoading || listeners.isLoading || agents.isLoading;

  return useMemo(() => {
    const accountList = accounts.data ?? [];
    const activeListeners = (listeners.data ?? []).filter((l) => l.isActive);
    const agentList = agents.data ?? [];

    const senderName =
      (messaging.data?.sender_name ?? '').trim() || (accountList.find((a) => (a.fromName ?? '').trim())?.fromName ?? '').trim();
    const website = profile.data?.website?.replace(/^https?:\/\//, '').replace(/\/.*$/, '');

    const steps: GetStartedStep[] = [
      {
        key: 'workspace',
        title: 'Create your workspace',
        pending: 'Name the workspace everything lives in.',
        doneText: `${tenant?.name ?? 'Workspace'}${tenant?.createdAt ? ` · created ${shortDate(tenant.createdAt)}` : ''}`,
        href: '/settings',
        cta: 'Set up',
        done: !!tenant,
      },
      {
        key: 'profile',
        title: 'Describe what you sell',
        pending: 'Tell agents who you are and what you sell, so drafts sound like you.',
        doneText: website ? `Read from ${website} · saved` : 'Company profile saved',
        href: '/settings/company',
        cta: 'Set up',
        done: !!profile.data?.companyName?.trim(),
      },
      {
        key: 'sender',
        title: 'Set who messages come from',
        pending: 'It still says [YOUR FIRST NAME]. Every draft carries it until you change it, and nothing sends before that.',
        token: '[YOUR FIRST NAME]',
        doneText: senderName ? `Messages come from ${senderName}` : 'Sender name set',
        href: '/settings/messaging',
        cta: 'Fix it',
        done: senderName.length > 0,
      },
      {
        key: 'mailbox',
        title: 'Connect a mailbox to send from',
        pending: 'Cold emails go out from an address you own. About two minutes.',
        doneText: accountList[0] ? `Sending from ${accountList[0].fromEmail}` : 'Mailbox connected',
        href: '/settings/email',
        cta: 'Connect',
        done: accountList.length > 0,
      },
      {
        key: 'replies',
        title: 'Connect reply detection',
        pending: 'Without it Keenpipe cannot see replies, and your reply rate stays blank.',
        doneText: 'Replies are picked up for your Inbox',
        href: '/settings/email',
        cta: 'Connect',
        done: activeListeners.length > 0,
      },
      {
        key: 'agent',
        title: 'Create your first agent',
        pending: 'Say who to look for. The first drafts are waiting the next morning.',
        doneText: `${agentList.length} agent${agentList.length === 1 ? '' : 's'} created`,
        href: '/agents/new',
        cta: 'Create agent',
        done: agentList.length > 0,
      },
    ];

    const doneCount = steps.filter((s) => s.done).length;
    return {
      isLoading,
      steps,
      doneCount,
      total: steps.length,
      remaining: steps.length - doneCount,
      allDone: doneCount === steps.length,
      currentIndex: steps.findIndex((s) => !s.done),
    };
  }, [isLoading, tenant, profile.data, messaging.data, accounts.data, listeners.data, agents.data]);
}
