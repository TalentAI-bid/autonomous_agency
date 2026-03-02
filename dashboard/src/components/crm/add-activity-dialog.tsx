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
import { useCreateActivity } from '@/hooks/use-crm';
import { useToast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';

type ManualActivityType = 'note_added' | 'call_logged';

const ACTIVITY_TYPE_LABELS: Record<ManualActivityType, string> = {
  note_added:  'Note',
  call_logged: 'Call Log',
};

interface AddActivityDialogProps {
  contactId?: string;
  dealId?: string;
  /** Trigger element. Defaults to a "Add Activity" button if not provided. */
  trigger?: React.ReactNode;
}

export function AddActivityDialog({ contactId, dealId, trigger }: AddActivityDialogProps) {
  const [open, setOpen] = React.useState(false);
  const [type, setType] = React.useState<ManualActivityType>('note_added');
  const [title, setTitle] = React.useState('');
  const [description, setDescription] = React.useState('');

  const createActivity = useCreateActivity();
  const { toast } = useToast();

  function reset() {
    setType('note_added');
    setTitle('');
    setDescription('');
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();

    if (!title.trim()) return;

    try {
      await createActivity.mutateAsync({
        contactId,
        dealId,
        type,
        title: title.trim(),
        description: description.trim() || undefined,
      });

      toast({ title: 'Activity added', description: 'The activity has been logged successfully.' });
      setOpen(false);
      reset();
    } catch {
      toast({
        title: 'Failed to add activity',
        description: 'Something went wrong. Please try again.',
        variant: 'destructive',
      });
    }
  }

  function handleOpenChange(next: boolean) {
    setOpen(next);
    if (!next) reset();
  }

  const isValid = title.trim().length > 0;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        {trigger ?? <Button variant="outline" size="sm">Add Activity</Button>}
      </DialogTrigger>

      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Log Activity</DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Type selector */}
          <div className="space-y-1.5">
            <Label htmlFor="activity-type">Type</Label>
            <div className="flex gap-2" role="group" aria-label="Activity type">
              {(Object.keys(ACTIVITY_TYPE_LABELS) as ManualActivityType[]).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setType(t)}
                  className={cn(
                    'flex-1 rounded-md border px-3 py-2 text-sm font-medium transition-colors',
                    type === t
                      ? 'border-primary bg-primary/10 text-primary'
                      : 'border-input bg-transparent text-muted-foreground hover:bg-accent hover:text-accent-foreground',
                  )}
                >
                  {ACTIVITY_TYPE_LABELS[t]}
                </button>
              ))}
            </div>
          </div>

          {/* Title */}
          <div className="space-y-1.5">
            <Label htmlFor="activity-title">
              Title <span className="text-destructive">*</span>
            </Label>
            <Input
              id="activity-title"
              placeholder={type === 'note_added' ? 'e.g. Follow-up note' : 'e.g. Intro call with prospect'}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              required
              autoFocus
            />
          </div>

          {/* Description */}
          <div className="space-y-1.5">
            <Label htmlFor="activity-description">Description</Label>
            <textarea
              id="activity-description"
              rows={4}
              placeholder={type === 'note_added' ? 'Add your note here…' : 'Call summary, outcomes, next steps…'}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className={cn(
                'flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm',
                'placeholder:text-muted-foreground',
                'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                'disabled:cursor-not-allowed disabled:opacity-50',
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
            <Button
              type="submit"
              size="sm"
              disabled={!isValid || createActivity.isPending}
            >
              {createActivity.isPending ? 'Saving…' : 'Save Activity'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
