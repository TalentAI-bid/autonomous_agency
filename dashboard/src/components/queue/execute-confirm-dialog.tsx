'use client';

import * as React from 'react';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/hooks/use-toast';
import { apiPost } from '@/lib/api';
import { useCompleteAction } from '@/hooks/use-queue';

/**
 * Shows the email draft, lets the user confirm, then posts to the existing
 * /api/contacts/:id/send-email route. On success, marks the prospect_action
 * as completed via /queue/actions/:id/complete.
 */
export function ExecuteConfirmDialog({
  actionId,
  contactId,
  subject,
  body,
  onClose,
}: {
  actionId: string;
  contactId: string;
  subject: string;
  body: string;
  onClose: () => void;
}) {
  const [subj, setSubj] = React.useState(subject);
  const [bod, setBod] = React.useState(body);
  const [sending, setSending] = React.useState(false);
  const completeMut = useCompleteAction();

  async function send() {
    setSending(true);
    try {
      await apiPost(`/contacts/${contactId}/send-email`, { subject: subj, body: bod });
      completeMut.mutate(
        { id: actionId, body: { sentAt: new Date().toISOString() } },
        {
          onSuccess: () => {
            toast({ title: 'Email sent' });
            onClose();
          },
        },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Send failed';
      toast({ title: 'Send failed', description: message, variant: 'destructive' });
    } finally {
      setSending(false);
    }
  }

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent style={{ maxWidth: 640 }}>
        <DialogHeader>
          <DialogTitle>Send email</DialogTitle>
        </DialogHeader>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <Input value={subj} onChange={(e) => setSubj(e.target.value)} placeholder="Subject" />
          <Textarea rows={12} value={bod} onChange={(e) => setBod(e.target.value)} placeholder="Body" />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={send} disabled={sending || !subj.trim() || !bod.trim()}>
            {sending ? 'Sending…' : 'Send'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
