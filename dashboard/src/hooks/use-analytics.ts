'use client';

import { useQuery } from '@tanstack/react-query';
import { apiGet } from '@/lib/api';

interface DashboardAnalytics {
  contacts: {
    total: number;
    byStatus: Record<string, number>;
  };
  campaigns: {
    total: number;
    active: number;
  };
  masterAgents: {
    total: number;
    running: number;
  };
  emails: {
    sent: number;
    opened: number;
    replied: number;
  };
  interviews: {
    scheduled: number;
  };
  avgScore: number | null;
}

export function useDashboardAnalytics() {
  return useQuery({
    queryKey: ['analytics', 'dashboard'],
    queryFn: () => apiGet<DashboardAnalytics>('/analytics/dashboard'),
    staleTime: 30000,
  });
}
