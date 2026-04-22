'use client';

import { useMasterAgentQuota } from '@/hooks/use-agents';
import { Badge } from '@/components/ui/badge';
import { Clock, AlertTriangle } from 'lucide-react';

interface Props {
  masterAgentId: string;
  compact?: boolean;
}

function fmtMin(ms: number): string {
  if (ms <= 0) return '0m';
  const totalMin = Math.round(ms / 60000);
  if (totalMin < 60) return `${totalMin}m`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return m === 0 ? `${h}h` : `${h}h${m}m`;
}

function fmtResetIn(resetsAt: string): string {
  const ms = Math.max(0, new Date(resetsAt).getTime() - Date.now());
  return fmtMin(ms);
}

export function QuotaBadge({ masterAgentId, compact = false }: Props) {
  const { data, isLoading } = useMasterAgentQuota(masterAgentId);

  if (isLoading || !data) {
    return null;
  }

  const usedMin = fmtMin(data.runtimeUsedMs);
  const budgetMin = fmtMin(data.runtimeBudgetMs);
  const percent = data.runtimeBudgetMs > 0
    ? Math.min(100, Math.round((data.runtimeUsedMs / data.runtimeBudgetMs) * 100))
    : 0;

  if (compact) {
    return (
      <Badge
        variant={data.exhausted ? 'destructive' : percent >= 75 ? 'outline' : 'secondary'}
        className="text-xs gap-1"
        title={`Daily runtime: ${usedMin} / ${budgetMin} (resets in ${fmtResetIn(data.resetsAt)})`}
      >
        {data.exhausted ? <AlertTriangle className="w-3 h-3" /> : <Clock className="w-3 h-3" />}
        {usedMin} / {budgetMin}
      </Badge>
    );
  }

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-xs">
        <div className="flex items-center gap-1.5 text-muted-foreground">
          {data.exhausted ? (
            <AlertTriangle className="w-3.5 h-3.5 text-red-500" />
          ) : (
            <Clock className="w-3.5 h-3.5" />
          )}
          <span>Daily runtime</span>
        </div>
        <span className="font-medium">
          {usedMin} <span className="text-muted-foreground">/ {budgetMin}</span>
        </span>
      </div>
      <div className="w-full h-1.5 bg-muted rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all ${
            data.exhausted ? 'bg-red-500' : percent >= 75 ? 'bg-amber-500' : 'bg-primary'
          }`}
          style={{ width: `${percent}%` }}
        />
      </div>
      <p className="text-[11px] text-muted-foreground">
        {data.exhausted
          ? `Paused — resets in ${fmtResetIn(data.resetsAt)}`
          : `Resets in ${fmtResetIn(data.resetsAt)}`}
      </p>
    </div>
  );
}
