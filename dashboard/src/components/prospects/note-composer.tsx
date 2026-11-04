'use client';

import * as React from 'react';
import { Card } from '@/components/ui/card';
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
    <Card as="section">
      <header className="border-b border-line px-5 py-3.5">
        <h2 className="m-0 text-body font-semibold text-ink">Add a note</h2>
      </header>
      <div className="space-y-3 p-5">
        <Textarea
          rows={3}
          placeholder="What you learned, the follow-up plan, context for the next message…"
          value={body}
          onChange={(e) => setBody(e.target.value)}
        />
        <div className="flex justify-end">
          <Button type="button" variant="brand" size="sm" onClick={submit} disabled={!body.trim() || mut.isPending}>
            {mut.isPending ? 'Saving…' : 'Add note'}
          </Button>
        </div>
      </div>
    </Card>
  );
}
