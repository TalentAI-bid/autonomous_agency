'use client';

import { useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Panel, PanelBody, PanelHead } from '@/components/ui/panel';
import { Pill } from '@/components/ui/pill';
import { Dot } from '@/components/ui/dot';
import { Icon } from '@/components/ui/icon';
import { useAgentErrors, useResolveError, useStartAgent, type PipelineErrorRow } from '@/hooks/use-agents';
import { useRealtimeStore } from '@/stores/realtime.store';

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
      style={{
        borderColor: 'var(--down, oklch(0.65 0.18 25))',
        marginBottom: 16,
      }}
    >
      <PanelHead style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <Icon name="flag" size={14} />
        <span>Pipeline issues</span>
        <Pill variant="down">{rows.length}</Pill>
      </PanelHead>
      <PanelBody style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {visible.map((row) => (
          <div
            key={row.id}
            style={{
              display: 'grid',
              gridTemplateColumns: '16px 1fr auto',
              alignItems: 'center',
              gap: 10,
              padding: '6px 0',
              borderBottom: '1px solid var(--line, rgba(255,255,255,0.06))',
            }}
          >
            <Dot state={severityState(row.severity)} title={row.severity} />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
              <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                <Pill variant={severityVariant(row.severity)}>{row.errorType}</Pill>
                <span style={{ fontSize: 11, color: 'var(--ink-3)' }}>
                  {row.step} · {row.tool} · {timeAgo(row.createdAt)}
                </span>
              </div>
              <span
                style={{
                  fontSize: 13,
                  color: 'var(--ink-1)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
                title={row.message}
              >
                {row.message}
              </span>
            </div>
            <div style={{ display: 'inline-flex', gap: 6 }}>
              {row.retryable && (
                <button
                  className="btn is-sm"
                  type="button"
                  disabled={startAgent.isPending}
                  onClick={() => startAgent.mutate(masterAgentId)}
                  title="Retry pipeline"
                >
                  Retry
                </button>
              )}
              <button
                className="btn is-sm"
                type="button"
                disabled={resolveError.isPending}
                onClick={() => resolveError.mutate(row.id)}
                title="Dismiss"
              >
                Dismiss
              </button>
            </div>
          </div>
        ))}
        {hidden > 0 && !expanded && (
          <button
            className="btn is-sm"
            type="button"
            style={{ alignSelf: 'flex-start', marginTop: 6 }}
            onClick={() => setExpanded(true)}
          >
            Show {hidden} more
          </button>
        )}
        {expanded && rows.length > 3 && (
          <button
            className="btn is-sm"
            type="button"
            style={{ alignSelf: 'flex-start', marginTop: 6 }}
            onClick={() => setExpanded(false)}
          >
            Collapse
          </button>
        )}
      </PanelBody>
    </Panel>
  );
}
