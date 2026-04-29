'use client';

import * as React from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogTrigger,
  DialogClose,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useCreateDeal, useCrmStages } from '@/hooks/use-crm';
import { useToast } from '@/hooks/use-toast';
import { ContactPicker } from './contact-picker';
import { Plus } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { Contact } from '@/types';

interface NewDealDialogProps {
  /** Optional trigger override; defaults to a "+ New Deal" button. */
  trigger?: React.ReactNode;
  /** When provided, pre-selects the stage. Otherwise defaults to first/lead stage. */
  defaultStageId?: string;
}

export function NewDealDialog({ trigger, defaultStageId }: NewDealDialogProps) {
  const [open, setOpen] = React.useState(false);
  const [contactId, setContactId] = React.useState<string | null>(null);
  const [contact, setContact] = React.useState<Contact | null>(null);
  const [title, setTitle] = React.useState('');
  const [stageId, setStageId] = React.useState<string>(defaultStageId ?? '');
  const [value, setValue] = React.useState('');
  const [currency, setCurrency] = React.useState('USD');
  const [notes, setNotes] = React.useState('');

  const { data: stages } = useCrmStages();
  const createDeal = useCreateDeal();
  const { toast } = useToast();

  // Default stage when stages load
  React.useEffect(() => {
    if (!stageId && stages && stages.length > 0) {
      const def = stages.find((s) => s.isDefault) ?? stages[0]!;
      setStageId(def.id);
    }
  }, [stages, stageId]);

  // Auto-fill title once a contact is picked (don't overwrite user-edited)
  const titleAutoSeeded = React.useRef(false);
  React.useEffect(() => {
    if (contact && !titleAutoSeeded.current && !title) {
      const name = [contact.firstName, contact.lastName].filter(Boolean).join(' ') || contact.email || 'Contact';
      setTitle(`Deal: ${name}`);
      titleAutoSeeded.current = true;
    }
  }, [contact, title]);

  function reset() {
    setContactId(null);
    setContact(null);
    setTitle('');
    setStageId(defaultStageId ?? '');
    setValue('');
    setCurrency('USD');
    setNotes('');
    titleAutoSeeded.current = false;
  }

  function handleOpenChange(next: boolean) {
    setOpen(next);
    if (!next) reset();
  }

  const isValid = contactId && title.trim().length > 0 && stageId.length > 0;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!isValid) return;
    try {
      await createDeal.mutateAsync({
        contactId: contactId!,
        title: title.trim(),
        stageId,
        value: value.trim() || undefined,
        currency: value.trim() ? currency : undefined,
        notes: notes.trim() || undefined,
        masterAgentId: contact?.masterAgentId ?? undefined,
      });
      toast({ title: 'Deal created', description: title.trim() });
      handleOpenChange(false);
    } catch (err) {
      toast({
        title: 'Could not create deal',
        description: err instanceof Error ? err.message : 'Please try again.',
        variant: 'destructive',
      });
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        {trigger ?? (
          <Button size="sm">
            <Plus className="w-4 h-4 mr-2" />
            New Deal
          </Button>
        )}
      </DialogTrigger>

      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New Deal</DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <ContactPicker value={contactId} onChange={(id, c) => { setContactId(id); setContact(c); }} />

          <div className="space-y-1.5">
            <Label htmlFor="deal-title">
              Title <span className="text-destructive">*</span>
            </Label>
            <Input
              id="deal-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Q2 evaluation — Acme"
              required
            />
          </div>

          <div className="space-y-1.5">
            <Label>
              Stage <span className="text-destructive">*</span>
            </Label>
            <div className="flex flex-wrap gap-1.5" role="radiogroup">
              {(stages ?? []).map((s) => (
                <button
                  key={s.id}
                  type="button"
                  role="radio"
                  aria-checked={stageId === s.id}
                  onClick={() => setStageId(s.id)}
                  className={cn(
                    'rounded-md border px-2.5 py-1 text-xs font-medium transition-colors',
                    stageId === s.id
                      ? 'border-primary bg-primary/10 text-primary'
                      : 'border-input bg-transparent text-muted-foreground hover:bg-accent hover:text-accent-foreground',
                  )}
                  style={stageId === s.id ? undefined : { borderLeftColor: s.color, borderLeftWidth: 3 }}
                >
                  {s.name}
                </button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-3 gap-2">
            <div className="space-y-1.5 col-span-2">
              <Label htmlFor="deal-value">Value</Label>
              <Input
                id="deal-value"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder="optional"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="deal-currency">Currency</Label>
              <select
                id="deal-currency"
                value={currency}
                onChange={(e) => setCurrency(e.target.value)}
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm"
              >
                <option value="USD">USD</option>
                <option value="EUR">EUR</option>
                <option value="GBP">GBP</option>
              </select>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="deal-notes">Notes</Label>
            <textarea
              id="deal-notes"
              rows={3}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Optional context, next step, owner…"
              className={cn(
                'flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm',
                'placeholder:text-muted-foreground',
                'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                'resize-none',
              )}
            />
          </div>

          <DialogFooter className="pt-2">
            <DialogClose asChild>
              <Button type="button" variant="outline" size="sm">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" size="sm" disabled={!isValid || createDeal.isPending}>
              {createDeal.isPending ? 'Creating…' : 'Create Deal'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
