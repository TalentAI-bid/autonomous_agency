import { Activity, BarChart3, Target } from 'lucide-react';
import { AgentMonitor } from '@/components/agents/agent-monitor';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatDate, getStatusColor } from '@/lib/utils';
import type { useAgentStats } from '@/hooks/use-agents';
import type { useRealtimeStore } from '@/stores/realtime.store';
import type { MasterAgent } from '@/types';

type Stats = ReturnType<typeof useAgentStats>['data'];
type AgentEvent = ReturnType<typeof useRealtimeStore.getState>['events'][number];

export function OverviewTab({
  agentId,
  agent,
  stats,
  totalContacts,
  events,
}: {
  agentId: string;
  agent: MasterAgent;
  stats: Stats;
  totalContacts: number;
  events: AgentEvent[];
}) {
  const config = (agent.config ?? {}) as Record<string, unknown>;
  const targetRoles = (config.targetRoles as string[]) ?? [];
  const requiredSkills = (config.requiredSkills as string[]) ?? [];
  const locations = (config.locations as string[]) ?? [];
  const byStatus = stats?.byStatus ?? {};

  const funnelStages = [
    { label: 'Discovered', value: byStatus.discovered ?? 0, color: 'bg-info' },
    { label: 'Enriched', value: byStatus.enriched ?? 0, color: 'bg-info' },
    { label: 'Scored', value: byStatus.scored ?? 0, color: 'bg-a-master' },
    { label: 'Contacted', value: byStatus.contacted ?? 0, color: 'bg-up' },
  ];

  return (
    <>
      {/* Agent Monitor */}
      <AgentMonitor masterAgentId={agentId} />

      {/* Pipeline Stats + Parsed Requirements */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <BarChart3 className="w-4 h-4" />
              Pipeline Stats
              {stats?.avgScore != null && (
                <Badge variant="outline" className="ml-auto text-xs">Avg Score: {stats.avgScore}</Badge>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {funnelStages.map((stage) => (
              <div key={stage.label} className="space-y-1">
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">{stage.label}</span>
                  <span className="font-medium">{stage.value}</span>
                </div>
                <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                  <div
                    className={`h-full ${stage.color} rounded-full transition-all`}
                    style={{ width: totalContacts > 0 ? `${(stage.value / totalContacts) * 100}%` : '0%' }}
                  />
                </div>
              </div>
            ))}
            {totalContacts === 0 && (
              <p className="text-sm text-muted-foreground text-center py-4">
                No contacts yet. Run the agent to start the pipeline.
              </p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Target className="w-4 h-4" />
              Parsed Requirements
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {targetRoles.length > 0 && (
              <div>
                <p className="text-xs text-muted-foreground mb-1.5">
                  {agent.useCase === 'sales' ? 'Target Decision-Makers' : 'Target Roles'}
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {targetRoles.map((role) => (
                    <Badge key={role} variant="secondary" className="text-xs">{role}</Badge>
                  ))}
                </div>
              </div>
            )}
            {requiredSkills.length > 0 && (
              <div>
                <p className="text-xs text-muted-foreground mb-1.5">
                  {agent.useCase === 'sales' ? 'Target Company Attributes' : 'Required Skills'}
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {requiredSkills.map((skill) => (
                    <Badge key={skill} variant="outline" className="text-xs">{skill}</Badge>
                  ))}
                </div>
              </div>
            )}
            {locations.length > 0 && (
              <div>
                <p className="text-xs text-muted-foreground mb-1.5">Locations</p>
                <div className="flex flex-wrap gap-1.5">
                  {locations.map((loc) => (
                    <Badge key={loc} variant="outline" className="text-xs">{loc}</Badge>
                  ))}
                </div>
              </div>
            )}
            {typeof config.bdStrategy === 'string' && (
              <div>
                <p className="text-xs text-muted-foreground mb-1.5">Discovery Strategy</p>
                <Badge variant="outline" className="text-xs">
                  {config.bdStrategy === 'hiring_signal' ? 'Hiring Signal (Job boards)' :
                   config.bdStrategy === 'industry_target' ? 'Industry Targeting (Registries)' :
                   'Hybrid (Both)'}
                </Badge>
              </div>
            )}
            {targetRoles.length === 0 && requiredSkills.length === 0 && locations.length === 0 && (
              <p className="text-sm text-muted-foreground text-center py-4">
                Requirements will appear after the agent runs.
              </p>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Live Events */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <Activity className="w-4 h-4 text-up" />
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
    </>
  );
}
