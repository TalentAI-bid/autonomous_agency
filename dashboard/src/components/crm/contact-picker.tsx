'use client';

import * as React from 'react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { useContacts, useCreateContact } from '@/hooks/use-contacts';
import { useAgents } from '@/hooks/use-agents';
import { Search, UserPlus, X, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useToast } from '@/hooks/use-toast';
import type { Contact } from '@/types';

interface ContactPickerProps {
  /** The currently selected contact id; null when none picked. */
  value: string | null;
  /** Fired with the selected contact (or null when cleared). */
  onChange: (contactId: string | null, contact: Contact | null) => void;
  /** When true, render a "Create new contact" inline path. */
  allowCreate?: boolean;
  /** Optional label override above the input. */
  label?: string;
  /** Show "no contact" hint message (used in activity dialog free-float case). */
  allowNoContact?: boolean;
  className?: string;
}

/**
 * Typeahead contact search + optional inline create-contact form.
 * Backed by GET /api/contacts?search=… which is debounced.
 */
export function ContactPicker({
  value,
  onChange,
  allowCreate = true,
  label = 'Contact',
  allowNoContact = false,
  className,
}: ContactPickerProps) {
  const [query, setQuery] = React.useState('');
  const [debouncedQuery, setDebouncedQuery] = React.useState('');
  const [open, setOpen] = React.useState(false);
  const [creating, setCreating] = React.useState(false);
  const containerRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query), 200);
    return () => clearTimeout(t);
  }, [query]);

  // Close popover on outside click
  React.useEffect(() => {
    function onClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  const { data: results, isLoading } = useContacts(
    debouncedQuery.trim().length >= 2 ? { search: debouncedQuery, limit: 8 } : undefined,
  );
  const contacts = results?.data ?? [];

  // Show the selected contact's display label even after the user types something else
  const { data: selectedRes } = useContacts(value ? undefined : undefined);
  const selectedContact = value ? contacts.find((c) => c.id === value) ?? null : null;
  // Best-effort: keep the last picked label even when query changes
  const [pickedLabel, setPickedLabel] = React.useState<string | null>(null);

  function handlePick(contact: Contact) {
    setPickedLabel(displayName(contact));
    setQuery('');
    setOpen(false);
    onChange(contact.id, contact);
  }

  function handleClear() {
    setPickedLabel(null);
    setQuery('');
    onChange(null, null);
  }

  return (
    <div className={cn('space-y-1.5', className)} ref={containerRef}>
      <Label>
        {label}
        {!allowNoContact && <span className="text-destructive"> *</span>}
      </Label>

      {value ? (
        <div className="flex items-center gap-2 rounded-md border border-input bg-muted/30 px-3 py-2 text-sm">
          <span className="flex-1 truncate font-medium">{pickedLabel ?? selectedContact ? displayName(selectedContact!) : 'Selected contact'}</span>
          <button
            type="button"
            onClick={handleClear}
            className="text-muted-foreground hover:text-foreground"
            aria-label="Clear"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ) : (
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
            onFocus={() => setOpen(true)}
            placeholder="Search by name or email…"
            className="pl-9"
          />
          {open && (debouncedQuery.trim().length >= 2 || allowCreate) && (
            <div className="absolute z-50 mt-1 w-full rounded-md border border-border bg-popover shadow-md">
              {isLoading && (
                <div className="flex items-center gap-2 px-3 py-2 text-sm text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Searching…
                </div>
              )}
              {!isLoading && contacts.length > 0 && (
                <ul className="max-h-64 overflow-auto py-1">
                  {contacts.map((c) => (
                    <li key={c.id}>
                      <button
                        type="button"
                        onClick={() => handlePick(c)}
                        className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-accent"
                      >
                        <span className="min-w-0">
                          <span className="block truncate font-medium">{displayName(c)}</span>
                          {c.email && <span className="block truncate text-xs text-muted-foreground">{c.email}</span>}
                        </span>
                        {c.companyName && (
                          <span className="shrink-0 text-xs text-muted-foreground">{c.companyName}</span>
                        )}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {!isLoading && contacts.length === 0 && debouncedQuery.trim().length >= 2 && (
                <div className="px-3 py-2 text-sm text-muted-foreground">No contacts match.</div>
              )}
              {allowCreate && (
                <div className="border-t border-border px-2 py-1.5">
                  <button
                    type="button"
                    onClick={() => { setOpen(false); setCreating(true); }}
                    className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-accent"
                  >
                    <UserPlus className="h-3.5 w-3.5" />
                    Create new contact{query ? ` "${query}"` : ''}
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {creating && (
        <CreateContactInline
          initialName={query}
          onCreated={(c) => {
            handlePick(c);
            setCreating(false);
          }}
          onCancel={() => setCreating(false)}
        />
      )}
    </div>
  );
}

function displayName(c: Contact): string {
  return [c.firstName, c.lastName].filter(Boolean).join(' ') || c.email || 'Unknown';
}

// ─── Inline "create new contact" mini-form ────────────────────────────────

function CreateContactInline({
  initialName,
  onCreated,
  onCancel,
}: {
  initialName: string;
  onCreated: (c: Contact) => void;
  onCancel: () => void;
}) {
  const initialParts = initialName.trim().split(/\s+/);
  const [firstName, setFirstName] = React.useState(initialParts[0] ?? '');
  const [lastName, setLastName] = React.useState(initialParts.slice(1).join(' '));
  const [email, setEmail] = React.useState('');
  const [agentId, setAgentId] = React.useState<string>('');

  const { data: agents } = useAgents();
  const createContact = useCreateContact();
  const { toast } = useToast();

  React.useEffect(() => {
    if (!agentId && agents && agents.length > 0) setAgentId(agents[0]!.id);
  }, [agents, agentId]);

  const isValid = firstName.trim().length > 0 && agentId.length > 0;

  async function handleSubmit() {
    if (!isValid) return;
    try {
      const created = await createContact.mutateAsync({
        firstName: firstName.trim() || undefined,
        lastName: lastName.trim() || undefined,
        email: email.trim() || undefined,
        masterAgentId: agentId,
      });
      onCreated(created);
    } catch (err) {
      toast({
        title: 'Could not create contact',
        description: err instanceof Error ? err.message : 'Please try again.',
        variant: 'destructive',
      });
    }
  }

  return (
    <div className="rounded-md border border-input bg-muted/20 p-3 space-y-2.5">
      <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        New contact
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1">
          <Label className="text-xs">First name *</Label>
          <Input value={firstName} onChange={(e) => setFirstName(e.target.value)} autoFocus />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Last name</Label>
          <Input value={lastName} onChange={(e) => setLastName(e.target.value)} />
        </div>
      </div>
      <div className="space-y-1">
        <Label className="text-xs">Email</Label>
        <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="optional" />
      </div>
      <div className="space-y-1">
        <Label className="text-xs">Agent *</Label>
        <select
          value={agentId}
          onChange={(e) => setAgentId(e.target.value)}
          className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm"
        >
          {(agents ?? []).map((a) => (
            <option key={a.id} value={a.id}>{a.name}</option>
          ))}
        </select>
      </div>
      <div className="flex gap-2 justify-end pt-1">
        <Button type="button" variant="outline" size="sm" onClick={onCancel}>Cancel</Button>
        <Button type="button" size="sm" onClick={handleSubmit} disabled={!isValid || createContact.isPending}>
          {createContact.isPending ? 'Creating…' : 'Create & select'}
        </Button>
      </div>
    </div>
  );
}
