'use client';

import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { PipelineStepsCard } from './pipeline-steps-card';
import { useSearchChoice } from '@/hooks/use-agents';
import {
  Info, AlertTriangle, XCircle, CheckCircle2, Globe, Chrome, SkipForward, Loader2, Search,
} from 'lucide-react';

const SEVERITY_STYLES: Record<string, { border: string; icon: React.ElementType; iconColor: string }> = {
  info:    { border: 'border-l-blue-500',    icon: Info,          iconColor: 'text-blue-400' },
  warning: { border: 'border-l-amber-500',   icon: AlertTriangle, iconColor: 'text-amber-400' },
  error:   { border: 'border-l-red-500',     icon: XCircle,       iconColor: 'text-red-400' },
  success: { border: 'border-l-emerald-500', icon: CheckCircle2,  iconColor: 'text-emerald-400' },
};

interface SystemAlertCardProps {
  content: Record<string, unknown>;
  masterAgentId?: string;
}

const NEGOTIATION_ACTIONS = new Set([
  'data_sources_selected',
  'extension_tasks_enqueued',
  'crawler_discovery_skipped',
  'service_unavailable',
  'search_quality_low',
  'broaden_auto_applied',
  'broaden_manual_applied',
  'broaden_auto_failed',
  'search_choice_continue',
]);

export function SystemAlertCard({ content, masterAgentId }: SystemAlertCardProps) {
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
          {action === 'search_quality_low' && (
            <SearchQualityLowAlert content={content} masterAgentId={masterAgentId} />
          )}
          {(action === 'broaden_auto_applied' || action === 'broaden_manual_applied') && (
            <BroadenAppliedAlert content={content} />
          )}
          {action === 'broaden_auto_failed' && (
            <BroadenAutoFailedAlert content={content} />
          )}
          {action === 'search_choice_continue' && (
            <SearchChoiceContinueAlert content={content} />
          )}
          {!NEGOTIATION_ACTIONS.has(action ?? '') && (
            <GenericAlert content={content} />
          )}
        </div>
      </div>
    </div>
  );
}

function SearchQualityLowAlert({
  content,
  masterAgentId,
}: {
  content: Record<string, unknown>;
  masterAgentId?: string;
}) {
  const [userTerm, setUserTerm] = useState('');
  const [activeChoice, setActiveChoice] = useState<string | null>(null);
  const searchChoice = useSearchChoice(masterAgentId ?? '');
  const disabled = !masterAgentId || searchChoice.isPending;

  const outcome = content.outcome as 'empty' | 'thin' | undefined;
  const totalFound = typeof content.totalFound === 'number' ? content.totalFound : 0;
  const jobTitle = content.jobTitle ? String(content.jobTitle) : '';
  const perLocation = Array.isArray(content.perLocation)
    ? (content.perLocation as Array<{ location: string; count: number }>)
    : [];
  const choices = Array.isArray(content.choices)
    ? (content.choices as Array<{ id: string; label: string }>)
    : [
        { id: 'continue', label: 'Continue with what I have' },
        { id: 'broaden_manual', label: 'Let me type a broader term' },
        { id: 'broaden_auto', label: 'Broaden it for me' },
      ];

  const handleChoice = (choiceId: string, term?: string) => {
    if (!masterAgentId) return;
    setActiveChoice(choiceId);
    searchChoice.mutate(
      { choiceId: choiceId as 'continue' | 'broaden_manual' | 'broaden_auto', userTerm: term },
      { onSettled: () => setActiveChoice(null) },
    );
  };

  return (
    <>
      <p className="text-xs font-medium flex items-center gap-1.5">
        <Search className="w-3 h-3" />
        Search quality {outcome === 'empty' ? '— 0 results' : `— only ${totalFound} companies`}
      </p>
      {content.message && (
        <p className="text-[11px] text-muted-foreground">{String(content.message)}</p>
      )}
      {jobTitle && (
        <p className="text-[10px] text-muted-foreground/80">
          Searched: <code className="text-[10px]">{jobTitle}</code>
        </p>
      )}
      {perLocation.length > 0 && (
        <div className="mt-1 space-y-0.5">
          {perLocation.map((p) => (
            <div
              key={p.location}
              className="flex items-center justify-between text-[10px] font-mono text-muted-foreground"
            >
              <span className="truncate">{p.location}</span>
              <span
                className={cn(
                  'tabular-nums',
                  p.count === 0 ? 'text-red-400' : p.count < 5 ? 'text-amber-400' : 'text-emerald-400',
                )}
              >
                {p.count}
              </span>
            </div>
          ))}
        </div>
      )}
      <div className="flex flex-wrap gap-1.5 mt-2">
        {choices.map((c) => {
          const isActive = activeChoice === c.id;
          return (
            <Button
              key={c.id}
              type="button"
              size="sm"
              variant={c.id === 'broaden_auto' ? 'default' : 'secondary'}
              disabled={disabled || (c.id === 'broaden_manual' && !userTerm.trim())}
              onClick={() => handleChoice(c.id, c.id === 'broaden_manual' ? userTerm.trim() : undefined)}
              className="h-7 text-[11px]"
            >
              {isActive && <Loader2 className="w-3 h-3 mr-1 animate-spin" />}
              {c.label}
            </Button>
          );
        })}
      </div>
      <input
        type="text"
        value={userTerm}
        onChange={(e) => setUserTerm(e.target.value)}
        placeholder="Type a broader term (e.g. blockchain developer)"
        disabled={disabled}
        className="mt-1.5 w-full h-7 px-2 text-[11px] bg-background border border-border rounded"
      />
      <p className="text-[10px] text-muted-foreground/70 italic">
        Or type your own broader term in the chat below.
      </p>
    </>
  );
}

function BroadenAppliedAlert({ content }: { content: Record<string, unknown> }) {
  const appliedTerm = content.appliedTerm ? String(content.appliedTerm) : '';
  const originalTerm = content.originalTerm ? String(content.originalTerm) : null;
  const totalFound = typeof content.totalFound === 'number' ? content.totalFound : 0;
  return (
    <>
      <p className="text-xs font-medium flex items-center gap-1.5">
        <Search className="w-3 h-3" />
        {originalTerm ? 'Auto-broadened search' : 'Broader search applied'}
      </p>
      <p className="text-[11px] text-muted-foreground">
        {originalTerm ? (
          <>
            <code className="text-[11px]">{originalTerm}</code> →{' '}
            <code className="text-[11px]">{appliedTerm}</code>
          </>
        ) : (
          <code className="text-[11px]">{appliedTerm}</code>
        )}{' '}
        <span className="text-emerald-400 font-medium">found {totalFound} companies</span>.
      </p>
    </>
  );
}

function BroadenAutoFailedAlert({ content }: { content: Record<string, unknown> }) {
  return (
    <>
      <p className="text-xs font-medium">Couldn't auto-broaden</p>
      <p className="text-[11px] text-muted-foreground">
        {content.message ? String(content.message) : 'No suggestion was generated — type a broader term in the chat.'}
      </p>
    </>
  );
}

function SearchChoiceContinueAlert({ content }: { content: Record<string, unknown> }) {
  return (
    <>
      <p className="text-xs font-medium">Continuing with current results</p>
      {content.message && (
        <p className="text-[11px] text-muted-foreground">{String(content.message)}</p>
      )}
    </>
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
