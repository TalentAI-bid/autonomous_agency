import { IcpSegmentationCard } from '@/components/agents/icp-segmentation-card';
import { StrategyPanel } from '@/components/agents/strategy-panel';
import type { MasterAgent } from '@/types';

export function StrategyTab({ agentId, agent }: { agentId: string; agent: MasterAgent }) {
  return (
    <div className="space-y-4">
      <IcpSegmentationCard
        agentMission={agent.mission ?? null}
        segments={
          ((agent.config as Record<string, unknown> | undefined)?.salesStrategy as
            | { icpSegmentation?: Array<{ name: string; rationale: string; suggestedSeparateAgent: boolean }> }
            | undefined)?.icpSegmentation
        }
      />
      <StrategyPanel masterAgentId={agentId} />
    </div>
  );
}
