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
      style={{
        border: '1px solid var(--border)',
        borderRadius: 10,
        padding: 14,
        background: action.status === 'in_progress' ? 'var(--bg-1)' : 'var(--bg-2)',
        opacity: action.status === 'completed' || action.status === 'skipped' ? 0.5 : 1,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, marginBottom: 6 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 4, flexWrap: 'wrap' }}>
            <Badge variant={PRIORITY_VARIANT[action.priority]}>{action.priority}</Badge>
            <span style={{ fontSize: 14 }}>{labelInfo.icon} {labelInfo.label}</span>
            {action.priorityReason && (
              <span style={{ fontSize: 11, color: 'var(--ink-3)' }}>{action.priorityReason}</span>
            )}
            {action.draftConfidence != null && action.draftConfidence < 50 && (
              <Badge variant="warning">⚠️ Low context</Badge>
            )}
          </div>
          {/* Company name is the primary identifier. */}
          <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--ink-1)' }}>
            {company.name}
            {company.score != null && (
              <span style={{ fontSize: 11, color: 'var(--ink-3)', marginLeft: 8, fontWeight: 400 }}>
                score {company.score}
              </span>
            )}
          </div>
          {/* Recommended target. Null for research actions. */}
          {contact ? (
            <div style={{ fontSize: 12, color: 'var(--ink-2)', marginTop: 2 }}>
              Recommended target:&nbsp;
              <Link href={`/prospects/${contact.id}`} style={{ color: 'var(--ink-1)', textDecoration: 'none' }}>
                {recommendedName}
              </Link>
              {contact.title && <span style={{ color: 'var(--ink-3)' }}> · {contact.title}</span>}
            </div>
          ) : (
            <div style={{ fontSize: 12, color: 'var(--ink-3)', marginTop: 2, fontStyle: 'italic' }}>
              No contact yet — research needed
            </div>
          )}
        </div>
      </div>

      {action.whyNow && (
        <div style={{ fontSize: 12, color: 'var(--ink-2)', marginBottom: 8, fontStyle: 'italic' }}>
          {action.whyNow}
        </div>
      )}

      {showDraft && (
        <div
          style={{
            border: '1px dashed var(--border)',
            borderRadius: 6,
            padding: 8,
            background: 'var(--bg-1)',
            marginBottom: 8,
            cursor: 'pointer',
          }}
          onClick={() => setDraftExpanded((v) => !v)}
        >
          {action.draftSubject && (
            <div style={{ fontSize: 12, fontWeight: 500, marginBottom: 4 }}>
              Re: {action.draftSubject}
            </div>
          )}
          <div
            style={{
              fontSize: 12,
              color: 'var(--ink-2)',
              whiteSpace: 'pre-wrap',
              maxHeight: draftExpanded ? 'none' : 60,
              overflow: 'hidden',
            }}
          >
            {action.draftBody}
          </div>
          {!draftExpanded && action.draftBody && action.draftBody.length > 200 && (
            <div style={{ fontSize: 10, color: 'var(--ink-3)', marginTop: 4 }}>
              Click to expand · {action.draftBody.length} chars
            </div>
          )}
        </div>
      )}

      {alternatives.length > 0 && action.status === 'pending' && (
        <div style={{ marginBottom: 8 }}>
          <button
            onClick={() => setAltsOpen((v) => !v)}
            style={{
              background: 'transparent',
              border: 'none',
              color: 'var(--ink-2)',
              fontSize: 12,
              cursor: 'pointer',
              padding: 0,
            }}
          >
            {altsOpen ? '▼' : '▶'} Other contacts at this company ({alternatives.length})
          </button>
          {altsOpen && (
            <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 4 }}>
              {alternatives.map((alt) => (
                <button
                  key={alt.contactId}
                  onClick={() => handleRetarget(alt)}
                  disabled={retargetMut.isPending}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    padding: '6px 8px',
                    background: 'var(--bg-1)',
                    border: '1px solid var(--border)',
                    borderRadius: 6,
                    textAlign: 'left',
                    cursor: 'pointer',
                    fontSize: 12,
                    color: 'var(--ink-1)',
                  }}
                >
                  <span style={{ fontWeight: 500 }}>{alt.name}</span>
                  {alt.title && <span style={{ color: 'var(--ink-3)' }}>· {alt.title}</span>}
                  <span style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--ink-3)' }}>
                    Switch & regenerate draft
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
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
          <Link href={`/prospects/${contact.id}`} style={{ fontSize: 11, color: 'var(--ink-3)', alignSelf: 'center', marginLeft: 'auto' }}>
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
