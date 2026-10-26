'use client';

import { useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Panel, PanelBody, PanelHead } from '@/components/ui/panel';
import { Pill } from '@/components/ui/pill';
import { Dot } from '@/components/ui/dot';
import { Icon } from '@/components/ui/icon';
import { useAgentErrors, useResolveError, useStartAgent, type PipelineErrorRow } from '@/hooks/use-agents';
import { useRealtimeStore } from '@/stores/realtime.store';

import { Button } from '@/components/ui/button';
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

function severityState(sev: PipelineErrorRow['severity']): 'warn' | 'live' | 'paused' {
  if (sev === 'error') return 'paused';
  if (sev === 'warning') return 'warn';
  return 'live';
}

function severityVariant(sev: PipelineErrorRow['severity']): 'down' | 'warn' | 'default' {
  if (sev === 'error') return 'down';
  if (sev === 'warning') return 'warn';
  return 'default';
}

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

  return (
    <Panel
      className="mb-4 border-down"
    >
      <PanelHead className="flex items-center gap-2.5">
        <Icon name="flag" size={14} />
        <span>Pipeline issues</span>
        <Pill variant="down">{rows.length}</Pill>
      </PanelHead>
      <PanelBody className="flex flex-col gap-1.5">
        {visible.map((row) => (
          <div
            key={row.id}
            className="grid grid-cols-[16px_1fr_auto] items-center gap-2.5 py-1.5 px-0 border-b border-line"
          >
            <Dot state={severityState(row.severity)} title={row.severity} />
            <div className="flex flex-col gap-0.5 min-w-0">
              <div className="inline-flex items-center gap-1.5 flex-wrap">
                <Pill variant={severityVariant(row.severity)}>{row.errorType}</Pill>
                <span className="text-xs text-ink-3">
                  {row.step} · {row.tool} · {timeAgo(row.createdAt)}
                </span>
              </div>
              <span
                className="text-body text-ink overflow-hidden text-ellipsis whitespace-nowrap"
                title={row.message}
              >
                {row.message}
              </span>
            </div>
            <div className="inline-flex gap-1.5">
              {row.retryable && (
                <Button
                  variant="panel" size="xs"
                  type="button"
                  disabled={startAgent.isPending}
                  onClick={() => startAgent.mutate(masterAgentId)}
                  title="Retry pipeline"
                >
                  Retry
                </Button>
              )}
              <Button
                variant="panel" size="xs"
                type="button"
                disabled={resolveError.isPending}
                onClick={() => resolveError.mutate(row.id)}
                title="Dismiss"
              >
                Dismiss
              </Button>
            </div>
          </div>
        ))}
        {hidden > 0 && !expanded && (
          <Button
            variant="panel" size="xs"
            type="button"
            className="self-start mt-1.5"
            onClick={() => setExpanded(true)}
          >
            Show {hidden} more
          </Button>
        )}
        {expanded && rows.length > 3 && (
          <Button
            variant="panel" size="xs"
            type="button"
            className="self-start mt-1.5"
            onClick={() => setExpanded(false)}
          >
            Collapse
          </Button>
        )}
      </PanelBody>
    </Panel>
  );
}
