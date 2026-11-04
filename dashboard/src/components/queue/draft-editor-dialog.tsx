'use client';

import * as React from 'react';
import { Mail, MessageSquare, PenLine } from 'lucide-react';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/hooks/use-toast';
import { useEditDraft } from '@/hooks/use-queue';
import type { QueueAction } from '@/lib/api/queue';

const FIELD_LABEL = 'mb-1.5 block text-3xs font-medium uppercase tracking-[0.09em] text-ink-4';

export function DraftEditorDialog({
  action,
  label,
  recipient,
  onClose,
}: {
  action: QueueAction;
  /** Human name of the action, e.g. "First Email". */
  label?: string;
  /** Who the draft is for, e.g. "Jane Doe · Acme". */
  recipient?: string;
  onClose: () => void;
}) {
  const [subject, setSubject] = React.useState(action.draftSubject ?? '');
  const [body, setBody] = React.useState(action.draftBody ?? '');
  const mut = useEditDraft();
  const hasSubject = action.channelTarget === 'email';
  const Icon = hasSubject ? Mail : action.channelTarget ? MessageSquare : PenLine;

  const words = body.trim().split(/\s+/).filter(Boolean).length;
  const dirty = body !== (action.draftBody ?? '') || (hasSubject && subject !== (action.draftSubject ?? ''));

  function save() {
    mut.mutate(
      { id: action.id, body, subject: hasSubject ? subject : undefined },
      {
        onSuccess: () => {
          toast({ title: 'Draft saved' });
          onClose();
        },
        onError: () => toast({ title: 'Failed to save draft', variant: 'destructive' }),
      },
    );
  }

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-[640px] gap-0 overflow-hidden rounded-2xl border-line p-0">
        <DialogHeader className="flex-row items-center gap-3 space-y-0 border-b border-line px-5 py-4 pr-12">
          <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-accent-weak text-accent">
            <Icon size={16} />
          </span>
          <div className="min-w-0">
            <DialogTitle className="text-body font-semibold leading-tight text-ink">Edit draft</DialogTitle>
            <DialogDescription className="mt-0.5 truncate text-xs text-ink-3">
              {[label, recipient].filter(Boolean).join(' · ') || 'Changes are saved to this action only.'}
            </DialogDescription>
          </div>
        </DialogHeader>

        <div className="flex flex-col gap-4 px-5 py-5">
          {hasSubject && (
            <div>
              <label htmlFor="draft-subject" className={FIELD_LABEL}>Subject</label>
              <Input
                id="draft-subject"
                placeholder="Subject line"
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
              />
            </div>
          )}
          <div>
            <label htmlFor="draft-body" className={FIELD_LABEL}>{hasSubject ? 'Message' : 'Draft'}</label>
            <Textarea
              id="draft-body"
              rows={12}
              placeholder="Write your message…"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              className="resize-y leading-relaxed"
            />
          </div>
        </div>

        <DialogFooter className="items-center gap-3 border-t border-line bg-bg-sub px-5 py-3 sm:justify-between sm:space-x-0">
          <span className="font-mono text-xs text-ink-3">
            {body.length} chars · {words} {words === 1 ? 'word' : 'words'}
          </span>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={onClose}>Cancel</Button>
            <Button variant="brand" size="sm" onClick={save} disabled={mut.isPending || !body.trim() || !dirty}>
              {mut.isPending ? 'Saving…' : 'Save draft'}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
