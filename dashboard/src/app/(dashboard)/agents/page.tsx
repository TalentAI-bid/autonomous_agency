'use client';

import Link from 'next/link';
import { Card } from '@/components/ui/card';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { Cpu, Info } from 'lucide-react';
import { useAgents, useDeleteAgent, useStartAgent, useStopAgent } from '@/hooks/use-agents';
import { SCORE_BAR } from '@/hooks/use-home';
import { useToast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { AgentCard } from '@/components/agents/agent-card';

export default function AgentsPage() {
  const confirm = useConfirm();
  const { data, isLoading } = useAgents();
  const deleteAgent = useDeleteAgent();
  const startAgent = useStartAgent();
  const stopAgent = useStopAgent();
  const { toast } = useToast();

  const agents = data ?? [];
  const busy = startAgent.isPending || stopAgent.isPending || deleteAgent.isPending;

  async function handleStart(id: string, name: string) {
    try {
      await startAgent.mutateAsync(id);
      toast({ title: `Agent "${name}" resumed`, description: 'The agent is now processing...' });
    } catch {
      toast({ title: 'Failed to start agent', variant: 'destructive' });
    }
  }

  async function handleStop(id: string, name: string) {
    try {
      await stopAgent.mutateAsync(id);
      toast({ title: `Agent "${name}" paused` });
    } catch {
      toast({ title: 'Failed to pause agent', variant: 'destructive' });
    }
  }

  async function handleDelete(id: string, name: string) {
    const ok = await confirm({
      title: `Delete agent "${name}"?`,
      description: 'Its settings and history are removed. This cannot be undone.',
      confirmLabel: 'Delete agent',
    });
    if (!ok) return;
    try {
      await deleteAgent.mutateAsync(id);
      toast({ title: `Agent "${name}" deleted` });
    } catch {
      toast({ title: 'Failed to delete agent', variant: 'destructive' });
    }
  }

  return (
    <div className="mx-auto max-w-[1180px] space-y-4 p-6">
      {isLoading ? (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-[280px] rounded-2xl" />
          ))}
        </div>
      ) : agents.length === 0 ? (
        <Card as="section" className="p-8">
          <span className="grid size-10 place-items-center rounded-full bg-accent-weak text-accent">
            <Cpu size={18} />
          </span>
          <h2 className="mb-0 mt-5 font-display text-[30px] font-normal leading-tight tracking-[-0.01em] text-ink">No agents yet</h2>
          <p className="mb-6 mt-3 max-w-[520px] text-body leading-relaxed text-ink-3">
            An agent finds leads, scores them and drafts messages. Nothing sends until you approve it in Approvals.
          </p>
          <Button size="lg" asChild variant="brand">
            <Link href="/agents/new">Create agent</Link>
          </Button>
        </Card>
      ) : (
        <>
          <p className="m-0 flex items-center gap-2 text-body text-ink-3">
            <Info size={13} className="shrink-0" />
            <span>
              An agent drafts and waits. Nothing sends until you approve it in Approvals.
              {SCORE_BAR != null && ` Every agent shares your bar of ${SCORE_BAR}.`}
            </span>
          </p>
          <div className="grid items-start gap-4 md:grid-cols-2 xl:grid-cols-3">
            {agents.map((agent) => (
              <AgentCard
                key={agent.id}
                agent={agent}
                busy={busy}
                onStart={() => handleStart(agent.id, agent.name)}
                onStop={() => handleStop(agent.id, agent.name)}
                onDelete={() => handleDelete(agent.id, agent.name)}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
