'use client';

import { useQueries } from '@tanstack/react-query';
import { apiGet } from '@/lib/api';
import { useAgents } from '@/hooks/use-agents';

/** Top-bar subtitle for /agents, e.g. "3 agents · all paused · 304 leads between them". */
export function AgentsSubtitle() {
  const { data: agents } = useAgents();
  const list = agents ?? [];
  const stats = useQueries({
    queries: list.map((a) => ({
      queryKey: ['agents', a.id, 'stats'],
      queryFn: () => apiGet<{ totalContacts: number; byStatus: Record<string, number>; avgScore: number | null }>(`/master-agents/${a.id}/stats`),
      staleTime: 15000,
    })),
  });

  if (!agents) return <>Your outbound agents.</>;
  if (list.length === 0) return <>No agents yet</>;

  const running = list.filter((a) => (a.status as string) === 'running').length;
  const state = running === 0 ? 'all paused' : running === list.length ? 'all running' : `${running} running`;
  const leads = stats.reduce((n, q) => n + (q.data?.totalContacts ?? 0), 0);
  const loaded = stats.every((q) => q.data);

  return (
    <>
      {list.length} agent{list.length === 1 ? '' : 's'} · {state}
      {loaded && list.length > 1 ? ` · ${leads} leads between them` : loaded ? ` · ${leads} leads` : ''}
    </>
  );
}
