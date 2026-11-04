'use client';

import * as React from 'react';
import Link from 'next/link';
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

export const PRIORITY_TONE: Record<string, string> = {
  P0: 'bg-down/10 text-down',
  P1: 'bg-warn/15 text-warn-fg',
  P2: 'bg-info/10 text-info',
  P3: 'bg-bg-soft text-ink-3',
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

  const done = action.status === 'completed' || action.status === 'skipped';

  return (
    <li className={cn('px-5 py-4', done && 'opacity-50')}>
      <div className="flex items-start gap-3.5">
        <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-bg-soft text-[16px]" aria-hidden>
          {labelInfo.icon}
        </span>

        <div className="min-w-0 flex-1 space-y-2.5">
          <div>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="text-body font-semibold text-ink">{company.name}</span>
              {company.score != null && <span className="font-mono text-2xs text-ink-4">score {company.score}</span>}
              <span className={cn('rounded-tag px-2 py-0.5 text-2xs font-semibold', PRIORITY_TONE[action.priority] ?? PRIORITY_TONE.P3)}>
                {action.priority}
              </span>
              <span className="rounded-tag bg-bg-soft px-2 py-0.5 text-2xs text-ink-2">{labelInfo.label}</span>
              {action.status === 'in_progress' && (
                <span className="rounded-tag bg-accent-weak px-2 py-0.5 text-2xs font-medium text-accent-fg">In progress</span>
              )}
              {action.draftConfidence != null && action.draftConfidence < 50 && (
                <span className="rounded-tag bg-warn/15 px-2 py-0.5 text-2xs font-medium text-warn-fg">Low context</span>
              )}
            </div>
            <div className="mt-1 text-xs text-ink-3">
              {contact ? (
                <>
                  To{' '}
                  <Link href={`/prospects/${contact.id}`} className="font-medium text-ink-2 no-underline hover:text-accent">
                    {recommendedName}
                  </Link>
                  {contact.title && <> · {contact.title}</>}
                </>
              ) : (
                <span className="italic">No contact yet — research needed</span>
              )}
              {action.priorityReason && <> · {action.priorityReason}</>}
            </div>
          </div>

          {action.whyNow && <p className="m-0 text-xs italic leading-relaxed text-ink-2">{action.whyNow}</p>}

          {showDraft && (
            <button
              type="button"
              onClick={() => setDraftExpanded((v) => !v)}
              className="block w-full cursor-pointer rounded-lg border border-line bg-bg-sub px-3 py-2.5 text-left transition-colors hover:border-line-strong"
            >
              {action.draftSubject && <div className="mb-1 text-xs font-semibold text-ink">Re: {action.draftSubject}</div>}
              <div
                className="overflow-hidden whitespace-pre-wrap text-xs leading-relaxed text-ink-2"
                style={{ maxHeight: draftExpanded ? 'none' : 60 }}
              >
                {action.draftBody}
              </div>
              {!draftExpanded && action.draftBody && action.draftBody.length > 200 && (
                <div className="mt-1.5 text-2xs text-ink-4">Click to expand · {action.draftBody.length} chars</div>
              )}
            </button>
          )}

          {alternatives.length > 0 && action.status === 'pending' && (
            <div>
              <button
                type="button"
                onClick={() => setAltsOpen((v) => !v)}
                className="cursor-pointer border-0 bg-transparent p-0 text-xs font-medium text-ink-2 hover:text-accent"
              >
                {altsOpen ? '▼' : '▶'} Other contacts at this company ({alternatives.length})
              </button>
              {altsOpen && (
                <div className="mt-1.5 flex flex-col gap-1">
                  {alternatives.map((alt) => (
                    <button
                      type="button"
                      key={alt.contactId}
                      onClick={() => handleRetarget(alt)}
                      disabled={retargetMut.isPending}
                      className="flex cursor-pointer items-center gap-1.5 rounded-lg border border-line bg-bg-panel px-2.5 py-1.5 text-left text-xs text-ink transition-colors hover:border-line-strong"
                    >
                      <span className="font-medium">{alt.name}</span>
                      {alt.title && <span className="text-ink-3">· {alt.title}</span>}
                      <span className="ml-auto text-2xs text-ink-3">Switch &amp; regenerate draft</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2">
            {action.status === 'pending' && (
              <Button type="button" variant="brand" size="dense" onClick={handleExecute} disabled={executeMut.isPending} className="h-8 rounded-lg px-3.5 text-xs font-semibold">
                {executeMut.isPending ? '…' : isResearch ? 'Find decision-makers' : 'Execute'}
              </Button>
            )}
            {action.status === 'in_progress' && (
              <Button type="button" variant="brand" size="dense" onClick={handleMarkSent} disabled={completeMut.isPending} className="h-8 rounded-lg px-3.5 text-xs font-semibold">
                {isResearch ? 'Mark researched' : 'Mark sent'}
              </Button>
            )}
            {showDraft && action.status === 'pending' && (
              <Button type="button" variant="panel" size="dense" onClick={() => setEditing(true)} className="h-8 rounded-lg px-3 text-xs">
                Edit
              </Button>
            )}
            {action.status === 'pending' && (
              <button
                type="button"
                onClick={() => setSkipping(true)}
                className="h-8 rounded-lg px-2.5 text-xs font-medium text-ink-3 transition-colors hover:bg-hover hover:text-ink"
              >
                Skip
              </button>
            )}
            {contact && (
              <Link href={`/prospects/${contact.id}`} className="ml-auto text-xs text-ink-3 no-underline hover:text-accent">
                Open ↗
              </Link>
            )}
          </div>
        </div>
      </div>

      {editing && (
        <DraftEditorDialog
          action={action}
          label={labelInfo.label}
          recipient={[recommendedName, company.name].filter(Boolean).join(' · ')}
          onClose={() => setEditing(false)}
        />
      )}
      {skipping && <SkipDialog actionId={action.id} onClose={() => setSkipping(false)} />}
      {executing?.kind === 'email_confirm' && contact && (
        <ExecuteConfirmDialog
          actionId={action.id}
          contactId={contact.id}
          subject={executing.subject ?? ''}
          body={executing.body ?? ''}
          onClose={() => setExecuting(null)}
        />
      )}
    </li>
  );
}
