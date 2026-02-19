'use client';

import { useAgents, useDeleteAgent, useStartAgent, useStopAgent } from '@/hooks/use-agents';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { formatDate } from '@/lib/utils';
import { Bot, Play, Square, Trash2, Settings, Plus, ExternalLink } from 'lucide-react';
import Link from 'next/link';
import { useToast } from '@/hooks/use-toast';

export default function AgentsPage() {
  const { data: res, isLoading } = useAgents();
  const deleteAgent = useDeleteAgent();
  const startAgent = useStartAgent();
  const stopAgent = useStopAgent();
  const { toast } = useToast();

  const agents = res ?? [];

  async function handleStart(id: string, name: string) {
    try {
      await startAgent.mutateAsync(id);
      toast({ title: `Agent "${name}" started`, description: 'The agent is now processing...' });
    } catch {
      toast({ title: 'Failed to start agent', variant: 'destructive' });
    }
  }

  async function handleStop(id: string, name: string) {
    try {
      await stopAgent.mutateAsync(id);
      toast({ title: `Agent "${name}" stopped` });
    } catch {
      toast({ title: 'Failed to stop agent', variant: 'destructive' });
    }
  }

  async function handleDelete(id: string, name: string) {
    if (!confirm(`Delete agent "${name}"? This cannot be undone.`)) return;
    try {
      await deleteAgent.mutateAsync(id);
      toast({ title: `Agent "${name}" deleted` });
    } catch {
      toast({ title: 'Failed to delete agent', variant: 'destructive' });
    }
  }

  function statusVariant(status: string) {
    if (status === 'running') return 'success';
    if (status === 'error') return 'error';
    if (status === 'completed') return 'blue';
    return 'secondary';
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Agents</h1>
          <p className="text-muted-foreground text-sm mt-1">Manage your AI recruiting agents</p>
        </div>
        <Link href="/agents/new">
          <Button size="sm">
            <Plus className="w-4 h-4 mr-2" />
            New Agent
          </Button>
        </Link>
      </div>

      {isLoading ? (
        <div className="grid gap-4">
          {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-32" />)}
        </div>
      ) : agents.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-16 gap-4">
            <div className="p-4 rounded-full bg-muted">
              <Bot className="w-8 h-8 text-muted-foreground" />
            </div>
            <div className="text-center">
              <h3 className="font-semibold">No agents yet</h3>
              <p className="text-sm text-muted-foreground mt-1">Create your first AI recruiting agent to get started</p>
            </div>
            <Link href="/agents/new">
              <Button>
                <Plus className="w-4 h-4 mr-2" />
                Create Agent
              </Button>
            </Link>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4">
          {agents.map((agent) => (
            <Card key={agent.id} className="group hover:border-border/80 transition-colors">
              <CardContent className="p-5">
                <div className="flex items-start gap-4">
                  <div className="p-2.5 rounded-lg bg-blue-500/10 shrink-0">
                    <Bot className="w-5 h-5 text-blue-400" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <Link href={`/agents/${agent.id}`} className="font-semibold hover:underline">
                        {agent.name}
                      </Link>
                      <Badge variant={statusVariant(agent.status) as 'success' | 'secondary' | 'error' | 'blue'}>
                        {agent.status}
                      </Badge>
                    </div>
                    <p className="text-sm text-muted-foreground mt-0.5 truncate">{agent.useCase}</p>
                    {agent.mission && (
                      <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{agent.mission}</p>
                    )}
                    <div className="flex items-center gap-4 mt-2 text-xs text-muted-foreground">
                      <span>Created {formatDate(agent.createdAt)}</span>
                      <span>Updated {formatDate(agent.updatedAt)}</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {agent.status === 'running' ? (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleStop(agent.id, agent.name)}
                        disabled={stopAgent.isPending}
                      >
                        <Square className="w-3.5 h-3.5 mr-1.5" />
                        Stop
                      </Button>
                    ) : (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleStart(agent.id, agent.name)}
                        disabled={startAgent.isPending}
                      >
                        <Play className="w-3.5 h-3.5 mr-1.5" />
                        Run
                      </Button>
                    )}
                    <Link href={`/agents/${agent.id}`}>
                      <Button variant="ghost" size="icon" className="h-8 w-8">
                        <ExternalLink className="w-3.5 h-3.5" />
                      </Button>
                    </Link>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-destructive hover:text-destructive"
                      onClick={() => handleDelete(agent.id, agent.name)}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
