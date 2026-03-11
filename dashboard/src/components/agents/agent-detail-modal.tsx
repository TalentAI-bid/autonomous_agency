'use client';

import { useState } from 'react';
import { useActivityFeed, useActivityStats } from '@/hooks/use-activity';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { formatDate } from '@/lib/utils';
import { X, CheckCircle2, XCircle, Clock } from 'lucide-react';
import type { AgentType } from '@/types';

interface AgentDetailModalProps {
  agentType: AgentType;
  masterAgentId: string;
  onClose: () => void;
}

export function AgentDetailModal({ agentType, masterAgentId, onClose }: AgentDetailModalProps) {
  const [showErrorsOnly, setShowErrorsOnly] = useState(false);
  const { data: statsData } = useActivityStats({ masterAgentId, hours: 24 });
  const { data: feedData } = useActivityFeed({
    masterAgentId,
    agentType,
    status: showErrorsOnly ? 'failed' : undefined,
    limit: 30,
  });

  const stats = statsData as any;
  const activities = feedData?.data ?? (feedData as any)?.data ?? [];
  const agentStats = stats?.byAgentType?.find((s: any) => s.agentType === agentType);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div className="bg-background border rounded-xl w-full max-w-2xl max-h-[80vh] overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between p-4 border-b">
          <div>
            <h2 className="text-lg font-semibold capitalize">{agentType} Agent</h2>
            <p className="text-xs text-muted-foreground">Last 24 hours</p>
          </div>
          <Button variant="ghost" size="sm" onClick={onClose}>
            <X className="w-4 h-4" />
          </Button>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-3 gap-4 p-4 border-b">
          <div>
            <p className="text-xs text-muted-foreground">Total Actions</p>
            <p className="text-2xl font-bold">{agentStats?.total ?? 0}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Failed</p>
            <p className="text-2xl font-bold text-destructive">{agentStats?.failed ?? 0}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Avg Duration</p>
            <p className="text-2xl font-bold">{agentStats?.avgDuration ?? 0}ms</p>
          </div>
        </div>

        {/* Error filter */}
        <div className="flex items-center gap-2 px-4 pt-3">
          <Button
            variant={showErrorsOnly ? 'default' : 'outline'}
            size="sm"
            onClick={() => setShowErrorsOnly(!showErrorsOnly)}
            className="h-7 text-xs"
          >
            <XCircle className="w-3 h-3 mr-1" />
            {showErrorsOnly ? 'Showing Errors' : 'Show Errors Only'}
          </Button>
        </div>

        {/* Activity log */}
        <div className="p-4 overflow-y-auto max-h-[400px] space-y-1.5">
          {activities.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-6">No activity found.</p>
          ) : (
            activities.map((entry: any) => (
              <div key={entry.id} className="flex items-start gap-2 py-1 text-xs border-l-2 border-border pl-2">
                {entry.status === 'completed' ? (
                  <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500 shrink-0 mt-0.5" />
                ) : entry.status === 'failed' ? (
                  <XCircle className="w-3.5 h-3.5 text-destructive shrink-0 mt-0.5" />
                ) : (
                  <Clock className="w-3.5 h-3.5 text-muted-foreground shrink-0 mt-0.5" />
                )}
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="font-medium">{entry.action}</span>
                    <Badge variant="outline" className="text-[10px] px-1 py-0">{entry.status}</Badge>
                    {entry.durationMs != null && (
                      <span className="text-muted-foreground ml-auto">{entry.durationMs}ms</span>
                    )}
                  </div>
                  {entry.inputSummary && <p className="text-muted-foreground truncate">{entry.inputSummary}</p>}
                  {entry.error && <p className="text-destructive truncate">{entry.error}</p>}
                </div>
                <span className="text-muted-foreground shrink-0">{formatDate(entry.createdAt)}</span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
