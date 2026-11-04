'use client';

import { useRouter } from 'next/navigation';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Layers, Sparkles } from 'lucide-react';

interface IcpSegment {
  name: string;
  rationale: string;
  suggestedSeparateAgent: boolean;
}

interface IcpSegmentationCardProps {
  agentMission?: string | null;
  segments: IcpSegment[] | undefined | null;
}

export function IcpSegmentationCard({ agentMission, segments }: IcpSegmentationCardProps) {
  const router = useRouter();
  const recommended = (segments ?? []).filter((s) => s.suggestedSeparateAgent);
  if (!recommended.length) return null;

  const launchSegment = (segment: IcpSegment) => {
    const derivedMission = agentMission
      ? `${agentMission}\n\n[Scoped to ICP: ${segment.name}]`
      : segment.name;
    const params = new URLSearchParams({
      mission: derivedMission,
      name: segment.name,
    });
    router.push(`/agents/new?${params.toString()}`);
  };

  return (
    <section className="overflow-hidden rounded-2xl border border-warn/30 bg-bg-panel shadow-sm">
      <header className="flex items-center gap-2.5 border-b border-warn/20 bg-warn/5 px-5 py-3">
        <span className="grid size-7 place-items-center rounded-row bg-warn/15 text-warn-fg">
          <Layers size={14} />
        </span>
        <div className="min-w-0">
          <h2 className="m-0 text-body font-semibold text-ink">Multi-ICP mission detected</h2>
          <p className="mb-0 mt-0.5 text-xs text-ink-3">
            Running several ICPs in one agent reduces signal quality. Splitting them gives better results.
          </p>
        </div>
      </header>
      <ul className="m-0 list-none divide-y divide-line p-0">
        {recommended.map((segment) => (
          <li key={segment.name} className="flex items-start justify-between gap-4 px-5 py-3.5">
            <div className="min-w-0">
              <Badge variant="accent">
                <Sparkles size={11} />
                {segment.name}
              </Badge>
              <p className="mb-0 mt-1.5 text-xs leading-relaxed text-ink-3">{segment.rationale}</p>
            </div>
            <Button size="sm" type="button" variant="panel" onClick={() => launchSegment(segment)} className="shrink-0">
              Create agent
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}
