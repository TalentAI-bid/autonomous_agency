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

type ManualActivityType =
  | 'note_added'
  | 'call_logged'
  | 'meeting_scheduled'
  | 'linkedin_connection_sent'
  | 'linkedin_connection_accepted'
  | 'linkedin_message_sent'
  | 'linkedin_message_received'
  | 'linkedin_followup_sent'
  | 'manual_email_sent'
  | 'manual_email_received';

const ACTIVITY_GROUPS: Array<{
  label: string;
  options: Array<{ value: ManualActivityType; label: string; placeholder: string }>;
}> = [
  {
    label: 'Notes',
    options: [
      { value: 'note_added',        label: 'Note',          placeholder: 'e.g. Follow-up note' },
      { value: 'call_logged',       label: 'Call',          placeholder: 'e.g. Intro call with prospect' },
      { value: 'meeting_scheduled', label: 'Meeting',       placeholder: 'e.g. Discovery meeting booked' },
    ],
  },
  {
    label: 'LinkedIn',
    options: [
      { value: 'linkedin_connection_sent',     label: 'Connect sent',      placeholder: 'Sent connection request on LinkedIn' },
      { value: 'linkedin_connection_accepted', label: 'Connect accepted',  placeholder: 'Connection request accepted' },
      { value: 'linkedin_message_sent',        label: 'Message sent',      placeholder: 'Sent a DM on LinkedIn' },
      { value: 'linkedin_message_received',    label: 'Message received',  placeholder: 'They replied on LinkedIn' },
      { value: 'linkedin_followup_sent',       label: 'Follow-up sent',    placeholder: 'Sent a LinkedIn follow-up' },
    ],
  },
  {
    label: 'Email',
    options: [
      { value: 'manual_email_sent',     label: 'Email sent (out of app)',     placeholder: 'e.g. Sent intro email from Gmail' },
      { value: 'manual_email_received', label: 'Email received (out of app)', placeholder: 'e.g. They replied to my Gmail' },
    ],
  },
];

const TYPE_PLACEHOLDER: Record<ManualActivityType, string> = Object.fromEntries(
  ACTIVITY_GROUPS.flatMap((g) => g.options.map((o) => [o.value, o.placeholder] as const)),
) as Record<ManualActivityType, string>;

interface AddActivityDialogProps {
  contactId?: string;
  dealId?: string;
  /** Trigger element. Defaults to a "Add Activity" button if not provided. */
  trigger?: React.ReactNode;
  /** Pre-select an activity type when the dialog opens. */
  defaultType?: ManualActivityType;
}

export function AddActivityDialog({ contactId, dealId, trigger, defaultType }: AddActivityDialogProps) {
  const [open, setOpen] = React.useState(false);
  const [type, setType] = React.useState<ManualActivityType>(defaultType ?? 'note_added');
  const [title, setTitle] = React.useState('');
  const [description, setDescription] = React.useState('');

  const createActivity = useCreateActivity();
  const { toast } = useToast();

  function reset() {
    setType(defaultType ?? 'note_added');
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
          {/* Type selector — grouped by channel */}
          <div className="space-y-2">
            <Label>Type</Label>
            {ACTIVITY_GROUPS.map((group) => (
              <div key={group.label} className="space-y-1.5">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  {group.label}
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {group.options.map((o) => (
                    <button
                      key={o.value}
                      type="button"
                      onClick={() => setType(o.value)}
                      className={cn(
                        'rounded-md border px-2.5 py-1 text-xs font-medium transition-colors',
                        type === o.value
                          ? 'border-primary bg-primary/10 text-primary'
                          : 'border-input bg-transparent text-muted-foreground hover:bg-accent hover:text-accent-foreground',
                      )}
                    >
                      {o.label}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>

          {/* Title */}
          <div className="space-y-1.5">
            <Label htmlFor="activity-title">
              Title <span className="text-destructive">*</span>
            </Label>
            <Input
              id="activity-title"
              placeholder={TYPE_PLACEHOLDER[type]}
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
              placeholder="Optional context, outcome, next steps…"
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
