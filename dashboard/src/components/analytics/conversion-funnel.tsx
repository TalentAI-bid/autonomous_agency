'use client';

import type { AnalyticsOverview } from '@/types';

interface ConversionFunnelProps {
  analytics?: AnalyticsOverview;
}

const STAGES = [
  { key: 'discovered', label: 'Discovered', color: 'bg-blue-500' },
  { key: 'enriched', label: 'Enriched', color: 'bg-indigo-500' },
  { key: 'scored', label: 'Scored', color: 'bg-purple-500' },
  { key: 'contacted', label: 'Contacted', color: 'bg-emerald-500' },
  { key: 'replied', label: 'Replied', color: 'bg-teal-500' },
  { key: 'interviewed', label: 'Interviewed', color: 'bg-amber-500' },
];

export function ConversionFunnel({ analytics }: ConversionFunnelProps) {
  const contacts = analytics?.contacts;
  const funnelData: Record<string, number> = {
    discovered: contacts?.discovered ?? 0,
    enriched: contacts?.enriched ?? 0,
    scored: contacts?.scored ?? 0,
    contacted: contacts?.contacted ?? 0,
    replied: contacts?.replied ?? 0,
    interviewed: contacts?.interview_scheduled ?? 0,
  };
  const maxValue = Math.max(...Object.values(funnelData), 1);

  return (
    <div className="space-y-3">
      {STAGES.map((stage, i) => {
        const value = funnelData[stage.key] ?? 0;
        const pct = Math.round((value / maxValue) * 100);
        const prevValue = i > 0 ? funnelData[STAGES[i - 1].key] ?? 0 : value;
        const convRate = prevValue > 0 ? Math.round((value / prevValue) * 100) : null;

        return (
          <div key={stage.key} className="space-y-1">
            <div className="flex justify-between items-baseline text-xs">
              <span className="text-muted-foreground">{stage.label}</span>
              <div className="flex items-center gap-2">
                {convRate !== null && i > 0 && (
                  <span className="text-muted-foreground">{convRate}%</span>
                )}
                <span className="font-semibold tabular-nums">{value}</span>
              </div>
            </div>
            <div className="h-5 bg-muted rounded overflow-hidden flex items-center">
              <div
                className={`h-full ${stage.color} rounded transition-all duration-500`}
                style={{ width: `${pct}%` }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}
