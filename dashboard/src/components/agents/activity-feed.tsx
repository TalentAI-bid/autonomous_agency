'use client';

import { useState } from 'react';
import { useActivityFeed } from '@/hooks/use-activity';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { formatDate } from '@/lib/utils';
import { Activity, CheckCircle2, XCircle, Clock, Pause, Play } from 'lucide-react';
import type { AgentType } from '@/types';

const AGENT_TYPE_COLORS: Record<string, string> = {
  discovery: 'bg-info/10 text-info',
  enrichment: 'bg-a-master/10 text-a-master',
  scoring: 'bg-warn/10 text-warn-fg',
  outreach: 'bg-up/10 text-up',
  reply: 'bg-a-enrichment/10 text-a-enrichment',
  document: 'bg-info/10 text-info',
  action: 'bg-down/10 text-down',
  strategy: 'bg-a-master/10 text-a-master',
  strategist: 'bg-info/10 text-info',
};

const STATUS_ICONS = {
  started: Clock,
  completed: CheckCircle2,
  failed: XCircle,
  skipped: Pause,
};

interface ActivityFeedProps {
  masterAgentId: string;
}

export function ActivityFeed({ masterAgentId }: ActivityFeedProps) {
  const [filter, setFilter] = useState<string | undefined>(undefined);
  const [paused, setPaused] = useState(false);
  const { data, isLoading } = useActivityFeed({
    masterAgentId,
    agentType: filter,
    limit: 50,
  });

  const activities = data?.data ?? [];

  const agentTypes: AgentType[] = ['strategist', 'discovery', 'enrichment', 'scoring', 'outreach', 'reply', 'document', 'action', 'strategy'];

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <Activity className="w-4 h-4 text-up" />
            Activity Feed
          </CardTitle>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setPaused(!paused)}
            className="h-7 px-2 text-xs"
          >
            {paused ? <Play className="w-3 h-3 mr-1" /> : <Pause className="w-3 h-3 mr-1" />}
            {paused ? 'Resume' : 'Pause'}
          </Button>
        </div>
        <div className="flex flex-wrap gap-1 mt-2">
          <Badge
            variant={!filter ? 'default' : 'outline'}
            className="text-xs cursor-pointer"
            onClick={() => setFilter(undefined)}
          >
            All
          </Badge>
          {agentTypes.map((type) => (
            <Badge
              key={type}
              variant={filter === type ? 'default' : 'outline'}
              className="text-xs cursor-pointer capitalize"
              onClick={() => setFilter(filter === type ? undefined : type)}
            >
              {type}
            </Badge>
          ))}
        </div>
      </CardHeader>
      <CardContent className="space-y-1.5 max-h-[500px] overflow-y-auto">
        {isLoading ? (
          <p className="text-sm text-muted-foreground text-center py-6">Loading...</p>
        ) : activities.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-6">
            No activity logged yet. Run the agent to see activity here.
          </p>
        ) : (
          activities.map((entry: any) => {
            const StatusIcon = STATUS_ICONS[entry.status as keyof typeof STATUS_ICONS] ?? Clock;
            const colorClass = AGENT_TYPE_COLORS[entry.agentType] ?? 'bg-ink-3/10 text-ink-3';

            return (
              <div key={entry.id} className="flex items-start gap-2 py-1.5 text-xs border-l-2 border-border pl-2">
                <StatusIcon className={`w-3.5 h-3.5 mt-0.5 shrink-0 ${
                  entry.status === 'completed' ? 'text-up' :
                  entry.status === 'failed' ? 'text-destructive' :
                  'text-muted-foreground'
                }`} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <Badge variant="outline" className={`text-[10px] px-1 py-0 ${colorClass}`}>
                      {entry.agentType}
                    </Badge>
                    <span className="font-medium">{entry.action}</span>
                    {entry.durationMs != null && (
                      <span className="text-muted-foreground ml-auto shrink-0">{entry.durationMs}ms</span>
                    )}
                  </div>
                  {entry.inputSummary && (
                    <p className="text-muted-foreground truncate mt-0.5">{entry.inputSummary}</p>
                  )}
                  {entry.error && (
                    <p className="text-destructive truncate mt-0.5">{entry.error}</p>
                  )}
                </div>
                <span className="text-muted-foreground shrink-0 ml-2">{formatDate(entry.createdAt)}</span>
              </div>
            );
          })
        )}
      </CardContent>
    </Card>
  );
}
