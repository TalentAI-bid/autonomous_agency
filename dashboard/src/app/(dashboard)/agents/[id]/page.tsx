'use client';

import { useParams } from 'next/navigation';
import { useMasterAgent, useStartAgent, useStopAgent } from '@/hooks/use-agents';
import { useContacts } from '@/hooks/use-contacts';
import { useRealtimeStore } from '@/stores/realtime.store';
import { AgentMonitor } from '@/components/agents/agent-monitor';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { formatDate, getStatusColor } from '@/lib/utils';
import { Play, Square, Activity, Users, Bot } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';

export default function AgentDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { data: agentRes, isLoading } = useMasterAgent(id);
  const { data: contactsRes } = useContacts({ masterAgentId: id, limit: 20 });
  const startAgent = useStartAgent();
  const stopAgent = useStopAgent();
  const { toast } = useToast();
  const events = useRealtimeStore((s) => s.events.filter((e) => (e.data as Record<string, unknown>)?.masterAgentId === id));

  const agent = agentRes;
  const contacts = contactsRes?.data ?? [];
  const totalContacts = contactsRes?.pagination?.total ?? 0;

  async function handleStart() {
    try {
      await startAgent.mutateAsync(id);
      toast({ title: 'Agent started', description: 'Processing your mission...' });
    } catch {
      toast({ title: 'Failed to start agent', variant: 'destructive' });
    }
  }

  async function handleStop() {
    try {
      await stopAgent.mutateAsync(id);
      toast({ title: 'Agent stopped' });
    } catch {
      toast({ title: 'Failed to stop agent', variant: 'destructive' });
    }
  }

  if (isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-32" />
        <Skeleton className="h-64" />
      </div>
    );
  }

  if (!agent) {
    return (
      <div className="text-center py-16">
        <Bot className="w-10 h-10 text-muted-foreground mx-auto mb-3" />
        <p className="text-muted-foreground">Agent not found</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Agent Header */}
      <Card>
        <CardContent className="p-6">
          <div className="flex items-start gap-4">
            <div className="p-3 rounded-lg bg-blue-500/10">
              <Bot className="w-6 h-6 text-blue-400" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-3 flex-wrap">
                <h1 className="text-xl font-bold">{agent.name}</h1>
                <Badge variant={agent.status === 'running' ? 'success' : 'secondary'}>
                  {agent.status}
                </Badge>
              </div>
              <p className="text-sm text-muted-foreground mt-1">{agent.useCase}</p>
              {agent.mission && (
                <p className="text-sm mt-2 text-foreground/80">{agent.mission}</p>
              )}
              <div className="flex items-center gap-4 mt-3 text-xs text-muted-foreground">
                <span className="flex items-center gap-1">
                  <Users className="w-3.5 h-3.5" />
                  {totalContacts} contacts
                </span>
                <span>Created {formatDate(agent.createdAt)}</span>
                <span>Updated {formatDate(agent.updatedAt)}</span>
              </div>
            </div>
            <div className="flex gap-2 shrink-0">
              {agent.status === 'running' ? (
                <Button variant="outline" size="sm" onClick={handleStop} disabled={stopAgent.isPending}>
                  <Square className="w-3.5 h-3.5 mr-1.5" />
                  Stop
                </Button>
              ) : (
                <Button size="sm" onClick={handleStart} disabled={startAgent.isPending}>
                  <Play className="w-3.5 h-3.5 mr-1.5" />
                  Run
                </Button>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Agent Monitor */}
      <AgentMonitor masterAgentId={id} />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Recent Contacts */}
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Users className="w-4 h-4" />
              Recent Contacts ({totalContacts})
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {contacts.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-6">
                No contacts discovered yet. Run the agent to start finding candidates.
              </p>
            ) : (
              contacts.slice(0, 10).map((contact) => (
                <div key={contact.id} className="flex items-center justify-between p-2 rounded-lg hover:bg-muted/50 transition-colors">
                  <div className="min-w-0">
                    <p className="text-sm font-medium truncate">{[contact.firstName, contact.lastName].filter(Boolean).join(' ') || contact.email || 'Unknown'}</p>
                    <p className="text-xs text-muted-foreground truncate">
                      {contact.title} {contact.companyName ? `at ${contact.companyName}` : ''}
                    </p>
                  </div>
                  <div className="flex items-center gap-2 ml-2 shrink-0">
                    {(contact.score ?? 0) > 0 && (
                      <Badge variant="outline" className="text-xs">
                        {contact.score}
                      </Badge>
                    )}
                    <Badge variant="secondary" className="text-xs">{contact.status}</Badge>
                  </div>
                </div>
              ))
            )}
          </CardContent>
        </Card>

        {/* Live Events */}
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Activity className="w-4 h-4 text-emerald-500" />
              Live Events
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 max-h-[300px] overflow-y-auto">
            {events.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-6">
                {agent.status === 'running' ? 'Waiting for events...' : 'No events. Start the agent to see activity.'}
              </p>
            ) : (
              events.map((event, i) => (
                <div key={i} className="flex gap-2 text-xs border-l-2 border-border pl-2 py-1">
                  <div className="min-w-0 flex-1">
                    <span className={`font-medium ${getStatusColor(event.event)}`}>{event.event}</span>
                    {event.data && typeof event.data === 'object' && 'message' in event.data && (
                      <p className="text-muted-foreground mt-0.5 truncate">{String(event.data.message)}</p>
                    )}
                  </div>
                  <span className="text-muted-foreground shrink-0">{formatDate(event.timestamp)}</span>
                </div>
              ))
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
