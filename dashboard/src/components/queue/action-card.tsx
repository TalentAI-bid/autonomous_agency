'use client';

import * as React from 'react';
import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import type { QueueAction, QueueContact, QueueCompany, TargetAlternative } from '@/lib/api/queue';
import { DraftEditorDialog } from './draft-editor-dialog';
import { SkipDialog } from './skip-dialog';
import { ExecuteConfirmDialog } from './execute-confirm-dialog';
import {
  useExecuteAction,
  useCompleteAction,
  useRetargetAction,
} from '@/hooks/use-queue';
import { toast } from '@/hooks/use-toast';

import { cn } from '@/lib/utils';
const ACTION_LABELS: Record<string, { icon: string; label: string }> = {
  linkedin_connect:                  { icon: '🤝', label: 'Connection Request' },
  linkedin_dm_first:                 { icon: '💼', label: 'LinkedIn DM (first)' },
  linkedin_dm_followup:              { icon: '💼', label: 'LinkedIn DM (follow-up)' },
  linkedin_dm_reply:                 { icon: '💼', label: 'LinkedIn DM (reply)' },
  email_first:                       { icon: '📧', label: 'First Email' },
  email_followup:                    { icon: '📧', label: 'Email Follow-up' },
  email_reply:                       { icon: '📧', label: 'Email Reply' },
  whatsapp_send:                     { icon: '📱', label: 'WhatsApp' },
  phone_call:                        { icon: '☎️', label: 'Phone Call' },
  meeting_prep:                      { icon: '📅', label: 'Meeting Prep' },
  manual_research:                   { icon: '🔍', label: 'Manual Research' },
  manual_followup_task:              { icon: '✅', label: 'Follow-up Task' },
  reactivation_outreach:             { icon: '🔁', label: 'Reactivation' },
  breakup_message:                   { icon: '👋', label: 'Breakup Message' },
  mark_dead_review:                  { icon: '⚰️', label: 'Mark Dead — Review' },
  research_company_decision_makers:  { icon: '🔎', label: 'Find Decision-Makers' },
};

const PRIORITY_VARIANT: Record<string, 'error' | 'warning' | 'blue' | 'outline'> = {
  P0: 'error',
  P1: 'warning',
  P2: 'blue',
  P3: 'outline',
};

export function ActionCard({
  action,
  company,
  contact,
}: {
  action: QueueAction;
  company: QueueCompany;
  contact: QueueContact | null;
}) {
  const labelInfo = ACTION_LABELS[action.actionType] ?? { icon: '·', label: action.actionType };
  const [draftExpanded, setDraftExpanded] = React.useState(false);
  const [editing, setEditing] = React.useState(false);
  const [skipping, setSkipping] = React.useState(false);
  const [altsOpen, setAltsOpen] = React.useState(false);
  const [executing, setExecuting] = React.useState<null | {
    kind: 'email_confirm' | 'linkedin_clipboard' | 'manual' | 'research';
    subject?: string | null;
    body?: string | null;
    targetUrl?: string | null;
    contactId?: string;
  }>(null);

  const executeMut = useExecuteAction();
  const completeMut = useCompleteAction();
  const retargetMut = useRetargetAction();

  function handleExecute() {
    executeMut.mutate(action.id, {
      onSuccess: (result) => {
        if (result.kind === 'linkedin_clipboard') {
          if (result.draftBody && typeof navigator !== 'undefined' && navigator.clipboard) {
            navigator.clipboard.writeText(result.draftBody).catch(() => {});
          }
          if (result.targetUrl && typeof window !== 'undefined') {
            window.open(result.targetUrl, '_blank', 'noopener,noreferrer');
          }
          toast({
            title: 'Draft copied to clipboard',
            description: 'Paste in LinkedIn, click Send, then [Mark Sent] here.',
          });
          setExecuting(result);
        } else if (result.kind === 'research') {
          toast({
            title: 'Marked open — find decision-makers',
            description: 'Open the company page to add contacts via the extension or discovery.',
          });
          setExecuting(result);
        } else {
          setExecuting(result);
        }
      },
      onError: () => toast({ title: 'Execute failed', variant: 'destructive' }),
    });
  }

  function handleMarkSent() {
    completeMut.mutate(
      { id: action.id, body: { sentAt: new Date().toISOString() } },
      {
        onSuccess: () => {
          toast({ title: 'Marked sent' });
          setExecuting(null);
        },
      },
    );
  }

  function handleRetarget(alt: TargetAlternative) {
    retargetMut.mutate(
      { id: action.id, contactId: alt.contactId },
      {
        onSuccess: () => {
          toast({ title: `Retargeted to ${alt.name}`, description: 'Draft regenerated.' });
          setAltsOpen(false);
        },
        onError: () => toast({ title: 'Retarget failed', variant: 'destructive' }),
      },
    );
  }

  const recommendedName = contact
    ? ([contact.firstName, contact.lastName].filter(Boolean).join(' ') || '—')
    : null;
  const showDraft = Boolean(action.draftBody);
  const isResearch = action.actionType === 'research_company_decision_makers';
  const alternatives = action.targetAlternatives ?? [];

  return (
    <div
      className={cn(
        'rounded-card border border-border p-3.5',
        action.status === 'in_progress' ? 'bg-bg-panel' : 'bg-bg-sub',
        (action.status === 'completed' || action.status === 'skipped') && 'opacity-50',
      )}
    >
      <div className="flex justify-between items-start gap-3 mb-1.5">
        <div className="flex-1 min-w-0">
          <div className="flex gap-2 items-center mb-1 flex-wrap">
            <Badge variant={PRIORITY_VARIANT[action.priority]}>{action.priority}</Badge>
            <span className="text-[14px]">{labelInfo.icon} {labelInfo.label}</span>
            {action.priorityReason && (
              <span className="text-xs text-ink-3">{action.priorityReason}</span>
            )}
            {action.draftConfidence != null && action.draftConfidence < 50 && (
              <Badge variant="warning">⚠️ Low context</Badge>
            )}
          </div>
          {/* Company name is the primary identifier. */}
          <div className="text-title font-semibold text-ink">
            {company.name}
            {company.score != null && (
              <span className="text-xs text-ink-3 ml-2 font-normal">
                score {company.score}
              </span>
            )}
          </div>
          {/* Recommended target. Null for research actions. */}
          {contact ? (
            <div className="text-label text-ink-2 mt-0.5">
              Recommended target:&nbsp;
              <Link href={`/prospects/${contact.id}`} className="text-ink no-underline">
                {recommendedName}
              </Link>
              {contact.title && <span className="text-ink-3"> · {contact.title}</span>}
            </div>
          ) : (
            <div className="text-label text-ink-3 mt-0.5 italic">
              No contact yet — research needed
            </div>
          )}
        </div>
      </div>

      {action.whyNow && (
        <div className="text-label text-ink-2 mb-2 italic">
          {action.whyNow}
        </div>
      )}

      {showDraft && (
        <div
          className="border border-dashed border-border rounded-chip p-2 bg-bg-panel mb-2 cursor-pointer"
          onClick={() => setDraftExpanded((v) => !v)}
        >
          {action.draftSubject && (
            <div className="text-label font-medium mb-1">
              Re: {action.draftSubject}
            </div>
          )}
          <div
            className="text-label text-ink-2 whitespace-pre-wrap overflow-hidden" style={{ maxHeight: draftExpanded ? 'none' : 60 }}
          >
            {action.draftBody}
          </div>
          {!draftExpanded && action.draftBody && action.draftBody.length > 200 && (
            <div className="text-2xs text-ink-3 mt-1">
              Click to expand · {action.draftBody.length} chars
            </div>
          )}
        </div>
      )}

      {alternatives.length > 0 && action.status === 'pending' && (
        <div className="mb-2">
          <button
            onClick={() => setAltsOpen((v) => !v)}
            className="bg-transparent border-0 text-ink-2 text-label cursor-pointer p-0"
          >
            {altsOpen ? '▼' : '▶'} Other contacts at this company ({alternatives.length})
          </button>
          {altsOpen && (
            <div className="mt-1.5 flex flex-col gap-1">
              {alternatives.map((alt) => (
                <button
                  key={alt.contactId}
                  onClick={() => handleRetarget(alt)}
                  disabled={retargetMut.isPending}
                  className="flex items-center gap-1.5 py-1.5 px-2 bg-bg-panel border border-border rounded-chip text-left cursor-pointer text-label text-ink"
                >
                  <span className="font-medium">{alt.name}</span>
                  {alt.title && <span className="text-ink-3">· {alt.title}</span>}
                  <span className="ml-auto text-2xs text-ink-3">
                    Switch & regenerate draft
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="flex gap-1.5 flex-wrap">
        {action.status === 'pending' && (
          <Button size="sm" onClick={handleExecute} disabled={executeMut.isPending}>
            {executeMut.isPending ? '…' : isResearch ? 'Find decision-makers' : 'Execute'}
          </Button>
        )}
        {action.status === 'in_progress' && !isResearch && (
          <Button size="sm" onClick={handleMarkSent} disabled={completeMut.isPending}>
            Mark Sent
          </Button>
        )}
        {action.status === 'in_progress' && isResearch && (
          <Button size="sm" onClick={handleMarkSent} disabled={completeMut.isPending}>
            Mark Researched
          </Button>
        )}
        {showDraft && action.status === 'pending' && (
          <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
            Edit
          </Button>
        )}
        {action.status === 'pending' && (
          <Button size="sm" variant="ghost" onClick={() => setSkipping(true)}>
            Skip
          </Button>
        )}
        {contact && (
          <Link href={`/prospects/${contact.id}`} className="text-xs text-ink-3 self-center ml-auto">
            Open ↗
          </Link>
        )}
      </div>

      {editing && (
        <DraftEditorDialog
          action={action}
          onClose={() => setEditing(false)}
        />
      )}
      {skipping && (
        <SkipDialog
          actionId={action.id}
          onClose={() => setSkipping(false)}
        />
      )}
      {executing?.kind === 'email_confirm' && contact && (
        <ExecuteConfirmDialog
          actionId={action.id}
          contactId={contact.id}
          subject={executing.subject ?? ''}
          body={executing.body ?? ''}
          onClose={() => setExecuting(null)}
        />
      )}
    </div>
  );
}
