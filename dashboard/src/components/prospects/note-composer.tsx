'use client';

import * as React from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/hooks/use-toast';
import { useAddProspectNote } from '@/hooks/use-prospect';

export function NoteComposer({ prospectId }: { prospectId: string }) {
  const [body, setBody] = React.useState('');
  const mut = useAddProspectNote(prospectId);

  function submit() {
    const trimmed = body.trim();
    if (!trimmed) return;
    mut.mutate(trimmed, {
      onSuccess: () => {
        setBody('');
        toast({ title: 'Note added' });
      },
      onError: () => toast({ title: 'Failed to add note', variant: 'destructive' }),
    });
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <Textarea
        rows={3}
        placeholder="Add a note — what you learned, follow-up plan, context for the next message…"
        value={body}
        onChange={(e) => setBody(e.target.value)}
      />
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <Button size="sm" onClick={submit} disabled={!body.trim() || mut.isPending}>
          {mut.isPending ? 'Saving…' : 'Add note'}
        </Button>
      </div>
    </div>
  );
}
