'use client';

import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { PipelineStepsCard } from './pipeline-steps-card';
import {
  Info, AlertTriangle, XCircle, CheckCircle2, Globe, Chrome, SkipForward,
} from 'lucide-react';

const SEVERITY_STYLES: Record<string, { border: string; icon: React.ElementType; iconColor: string }> = {
  info:    { border: 'border-l-blue-500',    icon: Info,          iconColor: 'text-blue-400' },
  warning: { border: 'border-l-amber-500',   icon: AlertTriangle, iconColor: 'text-amber-400' },
  error:   { border: 'border-l-red-500',     icon: XCircle,       iconColor: 'text-red-400' },
  success: { border: 'border-l-emerald-500', icon: CheckCircle2,  iconColor: 'text-emerald-400' },
};

interface SystemAlertCardProps {
  content: Record<string, unknown>;
}

export function SystemAlertCard({ content }: SystemAlertCardProps) {
  const action = content.action as string | undefined;
  const severity = (content.severity as string) || 'info';

  if (action === 'pipeline_steps_proposed' && Array.isArray(content.steps)) {
    return (
      <PipelineStepsCard
        steps={content.steps as Array<{ id: string; tool: string; action: string; dependsOn: string[]; params?: Record<string, unknown> }>}
        message={content.message as string | undefined}
      />
    );
  }

  // All other alert types use the severity-bordered card layout
  const style = SEVERITY_STYLES[severity] ?? SEVERITY_STYLES.info;
  const SeverityIcon = style.icon;

  return (
    <div className={cn('border-l-2 rounded-r-md bg-muted/30 p-3', style.border)}>
      <div className="flex items-start gap-2">
        <SeverityIcon className={cn('w-4 h-4 mt-0.5 shrink-0', style.iconColor)} />
        <div className="flex-1 min-w-0 space-y-1.5">
          {action === 'data_sources_selected' && (
            <DataSourcesAlert content={content} />
          )}
          {action === 'extension_tasks_enqueued' && (
            <ExtensionTasksAlert content={content} />
          )}
          {action === 'crawler_discovery_skipped' && (
            <CrawlerSkippedAlert content={content} />
          )}
          {action === 'service_unavailable' && (
            <ServiceUnavailableAlert content={content} />
          )}
          {!['data_sources_selected', 'extension_tasks_enqueued', 'crawler_discovery_skipped', 'service_unavailable'].includes(action ?? '') && (
            <GenericAlert content={content} />
          )}
        </div>
      </div>
    </div>
  );
}

function DataSourcesAlert({ content }: { content: Record<string, unknown> }) {
  const sources = content.sources as string[] | undefined;
  const quality = content.expectedQuality as string | undefined;
  const userNotes = content.userNotes as string | undefined;

  return (
    <>
      <p className="text-xs font-medium flex items-center gap-1.5">
        <Globe className="w-3 h-3" />
        Data Sources Selected
      </p>
      {sources?.length && (
        <div className="flex flex-wrap gap-1">
          {sources.map((s) => (
            <Badge key={s} variant="secondary" className="text-[10px]">{s}</Badge>
          ))}
        </div>
      )}
      {quality && (
        <Badge
          variant="secondary"
          className={cn('text-[10px]', {
            'bg-emerald-500/20 text-emerald-300': quality === 'excellent',
            'bg-blue-500/20 text-blue-300': quality === 'good',
            'bg-amber-500/20 text-amber-300': quality === 'medium',
            'bg-red-500/20 text-red-300': quality === 'limited',
          })}
        >
          Quality: {quality}
        </Badge>
      )}
      {userNotes && <p className="text-[11px] text-muted-foreground">{userNotes}</p>}
    </>
  );
}

function ExtensionTasksAlert({ content }: { content: Record<string, unknown> }) {
  const count = content.taskCount as number | undefined;
  const companies = content.companies as string[] | undefined;

  return (
    <>
      <p className="text-xs font-medium flex items-center gap-1.5">
        <Chrome className="w-3 h-3" />
        Extension Tasks Enqueued
      </p>
      {count != null && (
        <p className="text-[11px] text-muted-foreground">{count} tasks queued for processing</p>
      )}
      {companies?.length && (
        <div className="flex flex-wrap gap-1">
          {companies.slice(0, 5).map((c) => (
            <Badge key={c} variant="secondary" className="text-[10px]">{c}</Badge>
          ))}
          {companies.length > 5 && (
            <Badge variant="secondary" className="text-[10px]">+{companies.length - 5} more</Badge>
          )}
        </div>
      )}
      {content.message && <p className="text-[11px] text-muted-foreground">{String(content.message)}</p>}
    </>
  );
}

function CrawlerSkippedAlert({ content }: { content: Record<string, unknown> }) {
  return (
    <>
      <p className="text-xs font-medium flex items-center gap-1.5">
        <SkipForward className="w-3 h-3" />
        Crawler Discovery Skipped
      </p>
      <p className="text-[11px] text-muted-foreground">
        {content.message ? String(content.message) : 'Web crawling was skipped for this region. Falling back to alternative discovery method.'}
      </p>
      {content.reason && (
        <p className="text-[10px] text-muted-foreground/70 italic">{String(content.reason)}</p>
      )}
    </>
  );
}

function ServiceUnavailableAlert({ content }: { content: Record<string, unknown> }) {
  return (
    <>
      <p className="text-xs font-medium">Service Unavailable</p>
      <p className="text-[11px] text-muted-foreground">
        {content.message ? String(content.message) : 'A required service is temporarily unavailable.'}
      </p>
      {content.service && (
        <Badge variant="secondary" className="text-[10px]">{String(content.service)}</Badge>
      )}
    </>
  );
}

function GenericAlert({ content }: { content: Record<string, unknown> }) {
  const msg = content.message ? String(content.message) : null;
  const action = content.action ? String(content.action).replace(/_/g, ' ') : null;

  return (
    <>
      {action && <p className="text-xs font-medium capitalize">{action}</p>}
      {msg && <p className="text-[11px] text-muted-foreground">{msg}</p>}
      {!msg && !action && (
        <pre className="text-[10px] text-muted-foreground overflow-x-auto whitespace-pre-wrap">
          {JSON.stringify(content, null, 2)}
        </pre>
      )}
    </>
  );
}
