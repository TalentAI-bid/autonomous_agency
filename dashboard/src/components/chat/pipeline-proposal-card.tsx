'use client';

import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Check, Clock } from 'lucide-react';
import { PipelineStepsCard } from '@/components/agents/pipeline-steps-card';
import type { PipelineProposalData } from '@/types/chat';

interface PipelineProposalCardProps {
  proposal: PipelineProposalData;
  onApprove: () => void;
  onRequestChanges: () => void;
  isApproving: boolean;
}

const Chip = ({ children }: { children: React.ReactNode }) => (
  <Badge variant="soft">{children}</Badge>
);

export function PipelineProposalCard({ proposal, onApprove, onRequestChanges, isApproving }: PipelineProposalCardProps) {
  const config = proposal.config as Record<string, unknown>;

  return (
    <section className="mt-3 w-full rounded-2xl border border-accent-line bg-bg-panel p-5 shadow-sm">
      <div className="text-3xs font-medium uppercase tracking-[0.09em] text-accent">Proposed agent</div>
      <h3 className="mb-0 mt-1.5 font-display text-[22px] font-normal leading-tight tracking-[-0.01em] text-ink">{proposal.name}</h3>
      <p className="mb-0 mt-2 text-body leading-relaxed text-ink-3">{proposal.summary}</p>

      {proposal.pipelineSteps && proposal.pipelineSteps.length > 0 && (
        <div className="mt-4">
          <PipelineStepsCard steps={proposal.pipelineSteps} />
        </div>
      )}

      <div className="mt-4 flex flex-wrap gap-1.5">
        {!!config.targetRole && <Chip>{'Role: ' + String(config.targetRole)}</Chip>}
        {Array.isArray(config.skills) && config.skills.length > 0 && <Chip>{'Skills: ' + (config.skills as string[]).join(', ')}</Chip>}
        {Array.isArray(config.locations) && config.locations.length > 0 && (
          <Chip>{'Locations: ' + (config.locations as string[]).join(', ')}</Chip>
        )}
        {config.scoringThreshold !== undefined && <Chip>{'Score bar: ' + String(config.scoringThreshold)}</Chip>}
        {!!config.emailAccountId && <Chip>Sending mailbox selected</Chip>}
      </div>

      {Array.isArray(config.emailRules) && (config.emailRules as string[]).length > 0 && (
        <div className="mt-4">
          <div className="text-3xs font-medium uppercase tracking-[0.09em] text-ink-4">Email rules</div>
          <ul className="m-0 mt-1.5 list-none space-y-1 p-0">
            {(config.emailRules as string[]).map((rule, i) => (
              <li key={i} className="flex items-start gap-2 text-xs leading-relaxed text-ink-3">
                <span className="mt-1.5 size-1 shrink-0 rounded-full bg-accent" />
                <span>{rule}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="mt-4 flex items-center gap-1.5 text-xs text-ink-3">
        <Clock size={13} />
        <span>Estimated: {proposal.estimatedDuration}</span>
      </div>

      <div className="mt-5 flex flex-wrap items-center gap-2 border-t border-line pt-4">
        <Button type="button" variant="brand" size="dense" onClick={onApprove} disabled={isApproving} className="h-9 gap-1.5 rounded-lg px-4 text-body font-semibold">
          <Check size={14} strokeWidth={2.5} />
          {isApproving ? 'Launching…' : 'Approve & launch'}
        </Button>
        <Button type="button" variant="panel" size="dense" onClick={onRequestChanges} className="h-9 rounded-lg px-4 text-body font-medium">
          Request changes
        </Button>
        <span className="text-xs text-ink-3">Nothing sends until you approve drafts in Approvals.</span>
      </div>
    </section>
  );
}
