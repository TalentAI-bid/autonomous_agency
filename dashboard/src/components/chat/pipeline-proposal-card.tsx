'use client';

import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import {
  Search, FileText, Zap, Star, Mail, MessageSquare, CheckCircle, Clock,
} from 'lucide-react';
import type { PipelineProposalData } from '@/types/chat';

const AGENT_ICONS: Record<string, React.ElementType> = {
  discovery: Search,
  document: FileText,
  enrichment: Zap,
  scoring: Star,
  outreach: Mail,
  reply: MessageSquare,
  action: CheckCircle,
};

const AGENT_COLORS: Record<string, string> = {
  discovery: 'bg-blue-500/20 text-blue-400 border-blue-500/30',
  document: 'bg-purple-500/20 text-purple-400 border-purple-500/30',
  enrichment: 'bg-green-500/20 text-green-400 border-green-500/30',
  scoring: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30',
  outreach: 'bg-pink-500/20 text-pink-400 border-pink-500/30',
  reply: 'bg-cyan-500/20 text-cyan-400 border-cyan-500/30',
  action: 'bg-orange-500/20 text-orange-400 border-orange-500/30',
};

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

        {/* Pipeline Steps */}
        <div className="space-y-2">
          {proposal.pipeline.map((step, i) => {
            const Icon = AGENT_ICONS[step.agentType] || Zap;
            const color = AGENT_COLORS[step.agentType] || 'bg-gray-500/20 text-gray-400 border-gray-500/30';
            return (
              <div key={i} className="flex items-start gap-2.5">
                <div className="flex flex-col items-center">
                  <div className={cn('w-7 h-7 rounded-md border flex items-center justify-center', color)}>
                    <Icon className="w-3.5 h-3.5" />
                  </div>
                  {i < proposal.pipeline.length - 1 && (
                    <div className="w-px h-4 bg-border mt-0.5" />
                  )}
                </div>
                <div className="pt-0.5 min-w-0">
                  <p className="text-xs font-medium capitalize">
                    {step.agentType} Agent
                  </p>
                  <p className="text-xs text-muted-foreground truncate">{step.description}</p>
                </div>
              </div>
            );
          })}
        </div>

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
