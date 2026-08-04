'use client';

import { useQuery } from '@tanstack/react-query';
import { apiGet } from '@/lib/api';
import { useCompanyProfile } from '@/hooks/use-company-profile';
import { useEmailAccounts } from '@/hooks/use-email-settings';
import { useAgents } from '@/hooks/use-agents';

export interface SetupSteps {
  company: boolean;
  mailbox: boolean;
  extension: boolean;
  agent: boolean;
}

export interface SetupStatus {
  steps: SetupSteps;
  /** How many of the 4 setup steps are complete. */
  completedCount: number;
  /**
   * True while the workspace is still being set up (no agent deployed yet).
   * Deploying the first agent graduates the dashboard from the onboarding
   * view to the real-time live-ops dashboard.
   */
  showOnboarding: boolean;
  /** Any underlying query still loading — used to avoid a flash of onboarding. */
  isLoading: boolean;
}

/**
 * Aggregate the four first-run setup signals into a single object consumed by
 * the dashboard onboarding view and the layout chrome gate. Each signal reuses
 * the same query/endpoint the dedicated settings pages already use, so state
 * stays consistent as the user completes steps elsewhere.
 */
export function useSetupStatus(): SetupStatus {
  const profileQ = useCompanyProfile();
  const emailQ = useEmailAccounts();
  const agentsQ = useAgents();
  const extensionQ = useQuery({
    queryKey: ['ext-status'],
    queryFn: () => apiGet<{ connected: boolean; pendingTaskCount?: number }>('/extension/status'),
    staleTime: 30000,
  });

  const steps: SetupSteps = {
    company: !!profileQ.data?.companyName?.trim(),
    mailbox: (emailQ.data ?? []).length > 0,
    extension: !!extensionQ.data?.connected,
    agent: (agentsQ.data ?? []).length > 0,
  };

  const completedCount = Object.values(steps).filter(Boolean).length;
  const isLoading = agentsQ.isLoading;

  return {
    steps,
    completedCount,
    // Gate strictly on agents so the onboarding view disappears the moment the
    // first agent is deployed, regardless of the other steps' cache state.
    showOnboarding: !isLoading && !steps.agent,
    isLoading,
  };
}
