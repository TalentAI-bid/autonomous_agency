'use client';

import { useRouter } from 'next/navigation';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
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
    <Card className="border-amber-500/30 bg-amber-500/5">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-medium flex items-center gap-2">
          <Layers className="w-4 h-4 text-amber-500" />
          Multi-ICP mission detected
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p className="text-muted-foreground">
          Your mission contains multiple ICPs. Running them all in one agent reduces signal
          quality. For best results, split into separate agents:
        </p>
        <ul className="space-y-2">
          {recommended.map((segment) => (
            <li
              key={segment.name}
              className="flex items-start justify-between gap-3 rounded-md border bg-background p-3"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <Badge variant="secondary" className="text-xs">
                    <Sparkles className="w-3 h-3 mr-1" />
                    {segment.name}
                  </Badge>
                </div>
                <p className="text-xs text-muted-foreground mt-1">{segment.rationale}</p>
              </div>
              <Button
                size="sm"
                variant="outline"
                onClick={() => launchSegment(segment)}
                className="h-7 text-xs shrink-0"
              >
                Create agent
              </Button>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
