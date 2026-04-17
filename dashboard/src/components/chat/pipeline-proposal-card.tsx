'use client';

import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { CheckCircle, Clock } from 'lucide-react';
import { PipelineStepsCard } from '@/components/agents/pipeline-steps-card';
import type { PipelineProposalData } from '@/types/chat';

interface PipelineProposalCardProps {
  proposal: PipelineProposalData;
  onApprove: () => void;
  onRequestChanges: () => void;
  isApproving: boolean;
}

export function PipelineProposalCard({
  proposal,
  onApprove,
  onRequestChanges,
  isApproving,
}: PipelineProposalCardProps) {
  const config = proposal.config as Record<string, unknown>;

  return (
    <Card className="mt-3 border-primary/20">
      <CardContent className="p-4 space-y-4">
        <div>
          <h3 className="text-sm font-semibold">{proposal.name}</h3>
          <p className="text-xs text-muted-foreground mt-1">{proposal.summary}</p>
        </div>

        {/* Dynamic Pipeline Steps */}
        {proposal.pipelineSteps && proposal.pipelineSteps.length > 0 && (
          <PipelineStepsCard steps={proposal.pipelineSteps} />
        )}

        {/* Config Details */}
        <div className="flex flex-wrap gap-1.5">
          {!!config.targetRole && (
            <Badge variant="secondary" className="text-[10px]">{'Role: ' + String(config.targetRole)}</Badge>
          )}
          {Array.isArray(config.skills) && config.skills.length > 0 && (
            <Badge variant="secondary" className="text-[10px]">{'Skills: ' + (config.skills as string[]).join(', ')}</Badge>
          )}
          {Array.isArray(config.locations) && config.locations.length > 0 && (
            <Badge variant="secondary" className="text-[10px]">{'Locations: ' + (config.locations as string[]).join(', ')}</Badge>
          )}
          {config.scoringThreshold !== undefined && (
            <Badge variant="secondary" className="text-[10px]">{'Threshold: ' + String(config.scoringThreshold)}</Badge>
          )}
          {!!config.emailAccountId && (
            <Badge variant="secondary" className="text-[10px]">Sending account selected</Badge>
          )}
        </div>

        {/* Email Rules */}
        {Array.isArray(config.emailRules) && (config.emailRules as string[]).length > 0 && (
          <div className="space-y-1">
            <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">Email Rules</p>
            {(config.emailRules as string[]).map((rule, i) => (
              <div key={i} className="flex items-start gap-1.5 text-xs text-muted-foreground">
                <span className="text-primary shrink-0">*</span>
                <span>{rule}</span>
              </div>
            ))}
          </div>
        )}

        {/* Duration */}
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Clock className="w-3.5 h-3.5" />
          <span>Estimated: {proposal.estimatedDuration}</span>
        </div>

        {/* Actions */}
        <div className="flex gap-2 pt-1">
          <Button size="sm" onClick={onApprove} disabled={isApproving} className="flex-1">
            <CheckCircle className="w-3.5 h-3.5 mr-1.5" />
            {isApproving ? 'Launching...' : 'Approve & Launch'}
          </Button>
          <Button size="sm" variant="outline" onClick={onRequestChanges} className="flex-1">
            Request Changes
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
