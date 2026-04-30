'use client';

import * as React from 'react';
import { Mail, Pencil, Plus, X, Check, Loader2, AlertTriangle, AlertCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useSetContactEmail, type ManualEmailStatus } from '@/hooks/use-contacts';
import { useToast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';

interface EmailEditorProps {
  contactId: string;
  currentEmail: string | null;
  emailVerified: boolean;
  size?: 'inline' | 'compact';
  className?: string;
}

/**
 * Inline email editor with Reacher-verified atomic save.
 * Shared between the contact detail page and the company team list.
 */
export function EmailEditor({
  contactId,
  currentEmail,
  emailVerified,
  size = 'inline',
  className,
}: EmailEditorProps) {
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState(currentEmail ?? '');
  const [lastStatus, setLastStatus] = React.useState<ManualEmailStatus | null>(null);
  const setEmail = useSetContactEmail();
  const { toast } = useToast();

  React.useEffect(() => {
    setDraft(currentEmail ?? '');
  }, [currentEmail]);

  async function handleSave() {
    const trimmed = draft.trim();
    if (!trimmed) return;
    try {
      const res = await setEmail.mutateAsync({ id: contactId, email: trimmed });
      setLastStatus(res.status);
      setEditing(false);
      const messages: Record<ManualEmailStatus, { title: string; description: string }> = {
        safe: { title: 'Email verified', description: 'Reacher confirmed the address is deliverable.' },
        catch_all: { title: 'Email saved', description: 'Domain accepts all addresses — couldn\'t fully verify.' },
        risky: { title: 'Email saved (risky)', description: 'Reacher flagged this address as risky.' },
        unknown: { title: 'Email saved', description: 'Verification result was inconclusive.' },
        error: { title: 'Email saved', description: 'Verification service unavailable.' },
        daily_limit: { title: 'Email saved', description: 'Daily verification quota reached — saved unverified.' },
        invalid: { title: 'Email rejected', description: 'Reacher says this address is invalid.' },
      };
      const msg = messages[res.status];
      toast({ title: msg.title, description: msg.description });
    } catch (err) {
      const description = err instanceof Error ? err.message : 'Could not save email.';
      toast({ title: 'Save failed', description, variant: 'destructive' });
    }
  }

  function handleCancel() {
    setEditing(false);
    setDraft(currentEmail ?? '');
  }

  const compact = size === 'compact';

  // ─── Editing state ───────────────────────────────────────────
  if (editing) {
    return (
      <div className={cn('flex items-center gap-2', className)}>
        <Input
          type="email"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void handleSave();
            if (e.key === 'Escape') handleCancel();
          }}
          placeholder="name@company.com"
          autoFocus
          disabled={setEmail.isPending}
          className={compact ? 'h-7 text-xs' : 'h-8 text-sm'}
        />
        <Button
          type="button"
          size="sm"
          onClick={handleSave}
          disabled={setEmail.isPending || !draft.trim()}
          className={compact ? 'h-7 px-2 text-xs' : 'h-8'}
        >
          {setEmail.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Save'}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={handleCancel}
          disabled={setEmail.isPending}
          className={compact ? 'h-7 px-2' : 'h-8'}
          aria-label="Cancel"
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
    );
  }

  // ─── No email ────────────────────────────────────────────────
  if (!currentEmail) {
    return (
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={() => { setDraft(''); setEditing(true); }}
        className={cn(compact ? 'h-7 px-2 text-xs' : 'h-8 text-xs', className)}
      >
        <Plus className="h-3.5 w-3.5 mr-1" />
        Add email
      </Button>
    );
  }

  // ─── Has email — show with verify chip + edit button ────────
  const status = lastStatus ?? (emailVerified ? 'safe' : null);
  return (
    <div className={cn('flex items-center gap-1.5', className)}>
      <Mail className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
      <a
        href={`mailto:${currentEmail}`}
        className={cn('text-blue-400 hover:underline truncate', compact ? 'text-xs' : 'text-sm')}
      >
        {currentEmail}
      </a>
      <VerifyChip status={status} pending={setEmail.isPending} />
      <button
        type="button"
        onClick={() => { setDraft(currentEmail); setEditing(true); }}
        className="text-muted-foreground hover:text-foreground"
        aria-label="Edit email"
      >
        <Pencil className="h-3 w-3" />
      </button>
    </div>
  );
}

function VerifyChip({ status, pending }: { status: ManualEmailStatus | null; pending: boolean }) {
  if (pending) {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" /> Verifying…
      </span>
    );
  }
  if (!status) return null;
  switch (status) {
    case 'safe':
      return <Check className="h-3.5 w-3.5 text-green-400" aria-label="Verified" />;
    case 'catch_all':
    case 'risky':
      return (
        <span className="inline-flex items-center gap-0.5 text-xs text-amber-400" title={status === 'catch_all' ? 'Catch-all domain' : 'Risky'}>
          <AlertTriangle className="h-3 w-3" />
        </span>
      );
    case 'invalid':
      return (
        <span className="inline-flex items-center gap-0.5 text-xs text-rose-400" title="Invalid">
          <AlertCircle className="h-3 w-3" />
        </span>
      );
    default:
      return <span className="text-xs text-muted-foreground" title={status}>—</span>;
  }
}
