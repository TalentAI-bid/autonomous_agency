'use client';

import { useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { AlertCircle, AlertTriangle, ChevronDown, Info, RotateCw, X } from 'lucide-react';
import { useAgentErrors, useResolveError, useStartAgent, type PipelineErrorRow } from '@/hooks/use-agents';
import { useRealtimeStore } from '@/stores/realtime.store';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

const SEVERITY = {
  error: { icon: AlertCircle, tint: 'bg-down/10 text-down', label: 'Error' },
  warning: { icon: AlertTriangle, tint: 'bg-warn/15 text-warn-fg', label: 'Warning' },
  info: { icon: Info, tint: 'bg-accent-weak text-accent-fg', label: 'Info' },
} as const;

export function IssuesBanner({ masterAgentId }: { masterAgentId: string }) {
  const { data: errors, refetch } = useAgentErrors(masterAgentId, true);
  const resolveError = useResolveError(masterAgentId);
  const startAgent = useStartAgent();
  const qc = useQueryClient();
  const events = useRealtimeStore((s) => s.events);
  const [expanded, setExpanded] = useState(false);

  // Force a refetch whenever a new pipeline:error event lands for this agent.
  useEffect(() => {
    const recent = events.find(
      (e) =>
        e.event === 'pipeline:error' &&
        (e.data as Record<string, unknown>)?.masterAgentId === masterAgentId,
    );
    if (recent) {
      qc.invalidateQueries({ queryKey: ['agents', masterAgentId, 'errors'] });
      refetch();
    }
  }, [events, masterAgentId, qc, refetch]);

  const rows = useMemo(() => errors ?? [], [errors]);
  if (rows.length === 0) return null;

  const visible = expanded ? rows : rows.slice(0, 3);
  const hidden = Math.max(0, rows.length - visible.length);

  const errorCount = rows.filter((r) => r.severity === 'error').length;

  return (
    <section className="overflow-hidden rounded-2xl border border-down/30 bg-bg-panel shadow-sm">
      <header className="flex items-center gap-2.5 border-b border-down/20 bg-down/5 px-5 py-3">
        <span className="grid size-7 place-items-center rounded-row bg-down/10 text-down">
          <AlertCircle size={15} />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="m-0 text-body font-semibold text-ink">
            Pipeline issues
            <span className="ml-2 rounded-tag bg-down/10 px-1.5 font-mono text-2xs leading-[18px] text-down">{rows.length}</span>
          </h2>
          <p className="mb-0 mt-0.5 text-xs text-ink-3">
            {errorCount > 0 ? 'Something stopped part of the pipeline. Retry once the cause is fixed.' : 'Worth a look, but the pipeline kept going.'}
          </p>
        </div>
      </header>

      <ul className="m-0 list-none divide-y divide-line p-0">
        {visible.map((row) => {
          const sev = SEVERITY[row.severity] ?? SEVERITY.info;
          const SevIcon = sev.icon;
          return (
            <li key={row.id} className="flex items-start gap-3 px-5 py-3 transition-colors hover:bg-bg-soft">
              <span className={cn('mt-0.5 grid size-6 shrink-0 place-items-center rounded-full', sev.tint)} title={sev.label}>
                <SevIcon size={13} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className={cn('rounded-md px-2 py-0.5 text-2xs font-medium', sev.tint)}>{row.errorType}</span>
                  <span className="text-xs text-ink-3">
                    {row.step} · {row.tool} · {timeAgo(row.createdAt)}
                  </span>
                </div>
                <p className="mb-0 mt-1 line-clamp-2 break-words text-body text-ink" title={row.message}>
                  {row.message}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                {row.retryable && (
                  <Button
                    variant="panel"
                    size="dense"
                    type="button"
                    disabled={startAgent.isPending}
                    onClick={() => startAgent.mutate(masterAgentId)}
                    title="Retry pipeline"
                    className="rounded-lg"
                  >
                    <RotateCw size={12} /> Retry
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="dense"
                  type="button"
                  disabled={resolveError.isPending}
                  onClick={() => resolveError.mutate(row.id)}
                  title="Dismiss"
                  className="rounded-lg text-ink-3"
                >
                  <X size={12} /> Dismiss
                </Button>
              </div>
            </li>
          );
        })}
      </ul>

      {rows.length > 3 && (
        <footer className="border-t border-line px-5 py-2">
          <button
            type="button"
            onClick={() => setExpanded((e) => !e)}
            className="inline-flex items-center gap-1 text-xs font-medium text-accent-fg hover:underline"
          >
            {expanded ? 'Show fewer' : `Show ${hidden} more`}
            <ChevronDown size={12} className={cn('transition-transform', expanded && 'rotate-180')} />
          </button>
        </footer>
      )}
    </section>
  );
}
