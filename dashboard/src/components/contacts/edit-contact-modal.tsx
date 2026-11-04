'use client';

import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogTrigger,
  DialogClose,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useUpdateContact, useRescrapeContactLinkedin } from '@/hooks/use-contacts';
import { useToast } from '@/hooks/use-toast';
import { apiGet } from '@/lib/api';
import { Pencil, Linkedin, Loader2 } from 'lucide-react';
import type { Contact, ContactDeepData } from '@/types';

interface EditContactModalProps {
  contact: Contact;
  /** Optional trigger override; defaults to an "Edit" button. */
  trigger?: React.ReactNode;
}

/**
 * Edit a contact's name / role / LinkedIn URL — for correcting the cases where
 * the extension's team scrape got a name or title wrong. Includes a
 * "Re-scrape from LinkedIn" button that asks the extension to re-read the
 * person's profile; the result arrives as a suggestion on
 * rawData.linkedinRescrape, which we poll for and pre-fill into the inputs.
 * Nothing is persisted until the user clicks Save (PATCH /contacts/:id).
 */
export function EditContactModal({ contact, trigger }: EditContactModalProps) {
  const [open, setOpen] = React.useState(false);
  const [firstName, setFirstName] = React.useState('');
  const [lastName, setLastName] = React.useState('');
  const [title, setTitle] = React.useState('');
  const [linkedinUrl, setLinkedinUrl] = React.useState('');
  // When non-null, we're waiting on a re-scrape that started at this epoch ms.
  const [rescrapeStartedAt, setRescrapeStartedAt] = React.useState<number | null>(null);

  const updateContact = useUpdateContact();
  const rescrape = useRescrapeContactLinkedin();
  const { toast } = useToast();

  // Seed inputs from the contact each time the dialog opens.
  React.useEffect(() => {
    if (!open) return;
    setFirstName(contact.firstName ?? '');
    setLastName(contact.lastName ?? '');
    setTitle(contact.title ?? '');
    setLinkedinUrl(contact.linkedinUrl ?? '');
    setRescrapeStartedAt(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, contact.id]);

  // Poll the contact only while we're waiting for a re-scrape suggestion.
  const polling = rescrapeStartedAt !== null;
  const { data: polled } = useQuery({
    queryKey: ['contact-rescrape', contact.id],
    queryFn: () => apiGet<Contact>(`/contacts/${contact.id}`),
    enabled: open && polling,
    refetchInterval: polling ? 3000 : false,
  });

  React.useEffect(() => {
    if (!polling || !polled || rescrapeStartedAt === null) return;
    const suggestion = (polled.rawData as ContactDeepData | undefined)?.linkedinRescrape;
    if (!suggestion?.scrapedAt) return;
    if (new Date(suggestion.scrapedAt).getTime() <= rescrapeStartedAt) return;

    if (suggestion.name) {
      const parts = suggestion.name.trim().split(/\s+/);
      setFirstName(parts[0] ?? '');
      setLastName(parts.slice(1).join(' '));
    }
    if (suggestion.title) setTitle(suggestion.title);
    setRescrapeStartedAt(null);

    if (suggestion.name || suggestion.title) {
      toast({ title: 'LinkedIn re-scrape complete', description: 'Review the suggested name/role, then Save.' });
    } else {
      toast({
        title: "Couldn't read that profile",
        description: 'The extension opened the page but found no usable name/role. Edit manually.',
        variant: 'destructive',
      });
    }
  }, [polled, polling, rescrapeStartedAt, toast]);

  async function handleRescrape() {
    setRescrapeStartedAt(Date.now());
    try {
      await rescrape.mutateAsync(contact.id);
      toast({ title: 'Re-scrape requested', description: 'Opening the profile via your browser extension…' });
    } catch (err) {
      setRescrapeStartedAt(null);
      toast({
        title: 'Could not start re-scrape',
        description: err instanceof Error ? err.message : 'Please try again.',
        variant: 'destructive',
      });
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    try {
      await updateContact.mutateAsync({
        id: contact.id,
        firstName: firstName.trim() || undefined,
        lastName: lastName.trim() || undefined,
        title: title.trim() || undefined,
        linkedinUrl: linkedinUrl.trim() || undefined,
      });
      toast({ title: 'Contact updated' });
      setOpen(false);
    } catch (err) {
      toast({
        title: 'Could not update contact',
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
            <Pencil className="w-3.5 h-3.5 mr-1.5" /> Edit
          </Button>
        )}
      </DialogTrigger>

      <DialogContent className="gap-0 overflow-hidden rounded-2xl border-line p-0 sm:max-w-md">
        <DialogHeader className="flex-row items-center gap-3 space-y-0 border-b border-line px-5 py-4 pr-12 text-left">
          <span className="grid size-9 shrink-0 place-items-center rounded-full bg-accent-weak text-xs font-semibold text-accent">
            {(
              ((contact.firstName ?? '').charAt(0) + (contact.lastName ?? '').charAt(0)) || (contact.email ?? '?').charAt(0)
            ).toUpperCase()}
          </span>
          <div className="min-w-0">
            <DialogTitle className="text-body font-semibold leading-tight text-ink">Edit contact</DialogTitle>
            <DialogDescription className="mt-0.5 truncate text-xs text-ink-3">
              {[contact.firstName, contact.lastName].filter(Boolean).join(' ') || 'Fix a name, role or LinkedIn link.'}
            </DialogDescription>
          </div>
        </DialogHeader>

        <form onSubmit={handleSubmit}>
          <div className="space-y-4 px-5 py-5">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="edit-firstName">First name</Label>
                <Input id="edit-firstName" value={firstName} onChange={(e) => setFirstName(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="edit-lastName">Last name</Label>
                <Input id="edit-lastName" value={lastName} onChange={(e) => setLastName(e.target.value)} />
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="edit-title">Title / role</Label>
              <Input
                id="edit-title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="e.g. Head of Engineering"
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="edit-linkedin">LinkedIn URL</Label>
              <Input
                id="edit-linkedin"
                value={linkedinUrl}
                onChange={(e) => setLinkedinUrl(e.target.value)}
                placeholder="https://www.linkedin.com/in/…"
              />
            </div>

            <div className="rounded-xl border border-line bg-bg-sub p-3.5">
              <div className="flex items-center gap-3">
                <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-[color:#0a66c2] text-white">
                  <Linkedin size={15} />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="m-0 text-body font-medium text-ink">Re-scrape from LinkedIn</p>
                  <p className="m-0 text-xs leading-snug text-ink-3">
                    Pull the correct name &amp; role from the profile, then review it here.
                  </p>
                </div>
                <Button size="sm"
                  type="button"
                  variant="panel"
                  className="shrink-0"
                  onClick={handleRescrape}
                  disabled={!linkedinUrl.trim() || rescrape.isPending || polling}
                >
                  {polling ? (
                    <>
                      <Loader2 className="mr-1.5 size-3.5 animate-spin" /> Waiting…
                    </>
                  ) : (
                    'Re-scrape'
                  )}
                </Button>
              </div>
              {polling && (
                <p className="m-0 mt-2.5 border-t border-line pt-2.5 text-xs leading-snug text-ink-3">
                  Make sure the KeenPipe browser extension is connected. It opens this profile in a tab and reads it back here.
                </p>
              )}
            </div>
          </div>

          <DialogFooter className="items-center gap-2 border-t border-line bg-bg-sub px-5 py-3 sm:space-x-0">
            <DialogClose asChild>
              <Button type="button" variant="outline" size="sm">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" variant="brand" size="sm" disabled={updateContact.isPending}>
              {updateContact.isPending ? 'Saving…' : 'Save changes'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
