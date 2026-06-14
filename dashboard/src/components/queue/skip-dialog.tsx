'use client';

import * as React from 'react';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/hooks/use-toast';
import { useSkipAction } from '@/hooks/use-queue';

const REASONS = [
  { value: 'not_right_time', label: 'Not the right time' },
  { value: 'different_angle_needed', label: 'Different angle needed' },
  { value: 'bad_fit', label: 'Bad fit' },
  { value: 'other', label: 'Other' },
];

export function SkipDialog({
  actionId,
  onClose,
}: {
  actionId: string;
  onClose: () => void;
}) {
  const [reason, setReason] = React.useState('not_right_time');
  const [notes, setNotes] = React.useState('');
  const mut = useSkipAction();

  function submit() {
    mut.mutate(
      { id: actionId, reason, notes: notes.trim() || undefined },
      {
        onSuccess: () => {
          toast({ title: 'Skipped' });
          onClose();
        },
        onError: () => toast({ title: 'Failed to skip', variant: 'destructive' }),
      },
    );
  }

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Skip this action</DialogTitle>
        </DialogHeader>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ fontSize: 12, color: 'var(--ink-3)' }}>
            Reason — tracked for future prompt-tuning analysis.
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {REASONS.map((r) => (
              <label key={r.value} style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                <input
                  type="radio"
                  name="skip-reason"
                  value={r.value}
                  checked={reason === r.value}
                  onChange={() => setReason(r.value)}
                />
                <span style={{ fontSize: 13 }}>{r.label}</span>
              </label>
            ))}
          </div>
          <Textarea
            rows={2}
            placeholder="Optional note"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={submit} disabled={mut.isPending}>
            {mut.isPending ? 'Skipping…' : 'Skip'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
