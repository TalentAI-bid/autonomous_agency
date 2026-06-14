'use client';

import * as React from 'react';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/hooks/use-toast';
import { useEditDraft } from '@/hooks/use-queue';
import type { QueueAction } from '@/lib/api/queue';

export function DraftEditorDialog({
  action,
  onClose,
}: {
  action: QueueAction;
  onClose: () => void;
}) {
  const [subject, setSubject] = React.useState(action.draftSubject ?? '');
  const [body, setBody] = React.useState(action.draftBody ?? '');
  const mut = useEditDraft();
  const hasSubject = action.channelTarget === 'email';

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
      <DialogContent style={{ maxWidth: 640 }}>
        <DialogHeader>
          <DialogTitle>Edit draft</DialogTitle>
        </DialogHeader>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {hasSubject && (
            <Input
              placeholder="Subject"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
            />
          )}
          <Textarea
            rows={12}
            placeholder="Body"
            value={body}
            onChange={(e) => setBody(e.target.value)}
          />
          <div style={{ fontSize: 11, color: 'var(--ink-3)', alignSelf: 'flex-end' }}>
            {body.length} chars · {body.trim().split(/\s+/).filter(Boolean).length} words
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={save} disabled={mut.isPending || !body.trim()}>
            {mut.isPending ? 'Saving…' : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
