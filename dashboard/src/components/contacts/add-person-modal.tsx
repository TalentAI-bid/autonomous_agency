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
import { useCreateContact } from '@/hooks/use-contacts';
import { useToast } from '@/hooks/use-toast';
import { UserPlus } from 'lucide-react';

interface AddPersonModalProps {
  /** The master agent that owns this contact (required — contacts can't be orphan). */
  masterAgentId: string;
  /** Link the new person to this company so they appear in its People list. */
  companyId: string;
  companyName?: string;
  /** Optional trigger override; defaults to an "Add person" button. */
  trigger?: React.ReactNode;
}

/**
 * Manually add a team member to a company's People list — for when the
 * extension missed someone. Creates a contact linked to the company + agent.
 */
export function AddPersonModal({ masterAgentId, companyId, companyName, trigger }: AddPersonModalProps) {
  const [open, setOpen] = React.useState(false);
  const [firstName, setFirstName] = React.useState('');
  const [lastName, setLastName] = React.useState('');
  const [title, setTitle] = React.useState('');
  const [linkedinUrl, setLinkedinUrl] = React.useState('');
  const [email, setEmail] = React.useState('');

  const createContact = useCreateContact();
  const { toast } = useToast();

  React.useEffect(() => {
    if (!open) {
      setFirstName('');
      setLastName('');
      setTitle('');
      setLinkedinUrl('');
      setEmail('');
    }
  }, [open]);

  const isValid = firstName.trim().length > 0 || lastName.trim().length > 0;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!isValid) return;
    try {
      await createContact.mutateAsync({
        firstName: firstName.trim() || undefined,
        lastName: lastName.trim() || undefined,
        title: title.trim() || undefined,
        linkedinUrl: linkedinUrl.trim() || undefined,
        email: email.trim() || undefined,
        companyId,
        companyName,
        masterAgentId,
      });
      toast({ title: 'Person added', description: [firstName, lastName].filter(Boolean).join(' ') });
      setOpen(false);
    } catch (err) {
      toast({
        title: 'Could not add person',
        description: err instanceof Error ? err.message : 'Please try again.',
        variant: 'destructive',
      });
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {trigger ?? (
          <Button variant="outline" size="sm">
            <UserPlus className="w-3.5 h-3.5 mr-1.5" /> Add person
          </Button>
        )}
      </DialogTrigger>

      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add person{companyName ? ` to ${companyName}` : ''}</DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1.5">
              <Label htmlFor="add-firstName">First name</Label>
              <Input id="add-firstName" value={firstName} onChange={(e) => setFirstName(e.target.value)} autoFocus />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="add-lastName">Last name</Label>
              <Input id="add-lastName" value={lastName} onChange={(e) => setLastName(e.target.value)} />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="add-title">Title / role</Label>
            <Input
              id="add-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Head of Engineering"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="add-linkedin">LinkedIn URL</Label>
            <Input
              id="add-linkedin"
              value={linkedinUrl}
              onChange={(e) => setLinkedinUrl(e.target.value)}
              placeholder="https://www.linkedin.com/in/…"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="add-email">Email (optional)</Label>
            <Input
              id="add-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="name@company.com"
            />
          </div>

          <DialogFooter className="pt-2">
            <DialogClose asChild>
              <Button type="button" variant="outline" size="sm">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" size="sm" disabled={!isValid || createContact.isPending}>
              {createContact.isPending ? 'Adding…' : 'Add person'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
