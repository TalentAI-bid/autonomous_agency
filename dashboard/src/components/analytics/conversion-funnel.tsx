'use client';

import type { DashboardAnalytics } from '@/hooks/use-analytics';
import { HomeSection } from '@/components/home/home-parts';

interface ConversionFunnelProps {
  analytics?: DashboardAnalytics;
}

const STAGES = [
  { key: 'discovered', label: 'Discovered' },
  { key: 'enriched', label: 'Enriched' },
  { key: 'scored', label: 'Scored' },
  { key: 'contacted', label: 'Contacted' },
  { key: 'replied', label: 'Replied' },
  { key: 'interview_scheduled', label: 'Interview scheduled' },
];

export function ConversionFunnel({ analytics }: ConversionFunnelProps) {
  const byStatus = analytics?.contacts.byStatus ?? {};
  const total = analytics?.contacts.total ?? 0;
  const max = Math.max(...STAGES.map((s) => byStatus[s.key] ?? 0), 1);

  return (
    <HomeSection title="Pipeline by stage" meta={total > 0 ? `${total.toLocaleString()} contacts · where they are now` : undefined}>
      {total === 0 ? (
        <div className="border-t border-line px-4 py-8 text-center text-body text-ink-3">No contacts yet. Run an agent to start the pipeline.</div>
      ) : (
        STAGES.map((stage, i) => {
          const value = byStatus[stage.key] ?? 0;
          return (
            <div key={stage.key} className="flex items-center gap-3 border-t border-line px-4 py-3">
              <span className="grid size-5 shrink-0 place-items-center rounded-full bg-bg-sub font-mono text-2xs text-ink-3">{i + 1}</span>
              <div className="w-[132px] shrink-0 truncate text-body text-ink-2">{stage.label}</div>
              <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-bg-soft">
                <div className="h-full rounded-full bg-accent transition-all duration-500" style={{ width: `${(value / max) * 100}%` }} />
              </div>
              <div className="flex w-[84px] shrink-0 items-baseline justify-end gap-1.5">
                <span className="font-mono text-body font-medium tabular-nums text-ink">{value.toLocaleString()}</span>
                <span className="font-mono text-2xs text-ink-4">{Math.round((value / total) * 100)}%</span>
              </div>
            </div>
          );
        })
      )}
    </HomeSection>
  );
}
