'use client';

import { OnboardingView } from '@/components/dashboard/onboarding-view';
import { HomeView } from '@/components/home/home-view';
import { useSetupStatus } from '@/hooks/use-setup-status';

/**
 * Home — what needs you today. First run (no agent deployed yet) shows the
 * onboarding checklist instead; once an agent exists this falls through to the
 * action-first overview.
 */
export default function DashboardPage() {
  const { showOnboarding } = useSetupStatus();
  if (showOnboarding) return <OnboardingView />;
  return <HomeView />;
}
