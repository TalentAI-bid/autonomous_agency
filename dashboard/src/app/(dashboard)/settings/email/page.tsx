'use client';

import * as React from 'react';
import { StatusPill } from '@/components/home/home-parts';
import { useConfirm } from '@/components/ui/confirm-dialog';
import {
  useEmailAccounts,
  useCreateEmailAccount,
  useUpdateEmailAccount,
  useDeleteEmailAccount,
  useEmailListeners,
  useCreateEmailListener,
  useDeleteEmailListener,
  useTestListenerConnection,
  usePollNow,
} from '@/hooks/use-email-settings';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogClose,
} from '@/components/ui/dialog';
import { AccountPanel, ListenerPanel, UnlocksNote, useSendingHealth } from '@/components/settings/email-panels';
import { useToast } from '@/hooks/use-toast';
import { Pause } from 'lucide-react';
import { cn, formatRelative } from '@/lib/utils';

/* ─── Shared pieces ─────────────────────────────────────────────────────────── */

type PillTone = 'up' | 'warn';

function SectionCard({
  title,
  pill,
  loading,
  children,
}: {
  title: string;
  pill: { tone: PillTone; text: string };
  loading: boolean;
  children: React.ReactNode;
}) {
  return (
    <section className="overflow-hidden rounded-2xl border border-line bg-bg-panel shadow-sm">
      <header className="flex items-center justify-between border-b border-line px-5 py-3.5">
        <h2 className="m-0 text-body font-semibold text-ink">{title}</h2>
        {!loading && <StatusPill tone={pill.tone}>{pill.text}</StatusPill>}
      </header>
      <div className="p-6">{loading ? <Skeleton className="h-40 w-full" /> : children}</div>
    </section>
  );
}

function EmptyBlock({ title, body, children, note }: { title: string; body: string; children: React.ReactNode; note: React.ReactNode }) {
  return (
    <div className="p-1">
      <span className="grid size-9 place-items-center rounded-full bg-warn/10 text-warn-fg">
        <Pause size={14} />
      </span>
      <h3 className="mb-0 mt-4 font-display text-[26px] font-normal leading-tight tracking-[-0.01em] text-ink">{title}</h3>
      <p className="mb-5 mt-2 max-w-[500px] text-body leading-relaxed text-ink-3">{body}</p>
      <div className="flex flex-wrap items-center gap-2">{children}</div>
      <p className="mb-0 mt-4 text-xs text-ink-3">{note}</p>
    </div>
  );
}

/* ─── Page ──────────────────────────────────────────────────────────────────── */

type Preset = 'google' | 'microsoft' | 'smtp';

export default function EmailSettingsPage() {
  return (
    <div className="space-y-5">
      <SendingCard />
      <ReplyDetectionCard />
    </div>
  );
}

/* ─── Sending ───────────────────────────────────────────────────────────────── */

function SendingCard() {
  const confirm = useConfirm();
  const { data: accounts, isLoading } = useEmailAccounts();
  const updateAccount = useUpdateEmailAccount();
  const deleteAccount = useDeleteEmailAccount();
  const { toast } = useToast();

  const [preset, setPreset] = React.useState<Preset | null>(null);

  const list = accounts ?? [];
  const { quota, hasActive } = useSendingHealth(list);

  const pill: { tone: PillTone; text: string } = !hasActive
    ? { tone: 'warn', text: 'Not connected' }
    : quota && !quota.available
      ? { tone: 'warn', text: `At its limit — ${quota.dailyUsed} of ${quota.dailyLimit} sent today` }
      : { tone: 'up', text: quota ? `Healthy — ${quota.dailyUsed} of ${quota.dailyLimit} sent today` : 'Connected' };

  async function handleToggle(id: string, isActive: boolean) {
    try {
      await updateAccount.mutateAsync({ id, isActive: !isActive });
    } catch {
      toast({ title: 'Failed to update account', variant: 'destructive' });
    }
  }

  async function handleDisconnect(id: string, email: string) {
    const ok = await confirm({
      title: `Disconnect ${email}?`,
      description: 'Agents will stop sending from it.',
      confirmLabel: 'Disconnect',
    });
    if (!ok) return;
    try {
      await deleteAccount.mutateAsync(id);
      toast({ title: 'Mailbox disconnected' });
    } catch {
      toast({ title: 'Failed to disconnect mailbox', variant: 'destructive' });
    }
  }

  const connectButtons = (
    <>
      <Button type="button" variant="brand" size="dense" onClick={() => setPreset('google')} className="h-9 rounded-lg px-4 text-body font-semibold">
        Connect Google
      </Button>
      <Button type="button" variant="panel" size="dense" onClick={() => setPreset('microsoft')} className="h-9 rounded-lg px-4 text-body font-medium">
        Connect Microsoft
      </Button>
      <Button type="button" variant="ghost" size="dense" onClick={() => setPreset('smtp')} className="h-9 rounded-lg px-3 text-body font-medium">
        Other (SMTP)
      </Button>
    </>
  );

  return (
    <SectionCard title="Sending" pill={pill} loading={isLoading}>
      {list.length === 0 ? (
        <EmptyBlock
          title="Nothing can be sent yet"
          body="Agents can find leads, score them and draft messages, but no cold email leaves until an address you own is connected. Keenpipe sends as you, from your own mailbox, and you can disconnect any time."
          note="Takes about a minute. New mailboxes warm up gradually before they reach full volume."
        >
          {connectButtons}
        </EmptyBlock>
      ) : (
        <div className="space-y-6">
          {list.map((acct, i) => (
            <div key={acct.id} className={cn(i > 0 && 'border-t border-line pt-6')}>
              <AccountPanel
                account={acct}
                busy={updateAccount.isPending || deleteAccount.isPending}
                onToggle={() => handleToggle(acct.id, acct.isActive)}
                onDisconnect={() => handleDisconnect(acct.id, acct.fromEmail)}
              />
            </div>
          ))}
          <div className="flex flex-wrap items-center gap-2 border-t border-line pt-4">
            <span className="mr-1 text-xs text-ink-3">Add another mailbox</span>
            {connectButtons}
          </div>
        </div>
      )}
      <AccountDialog preset={preset} onClose={() => setPreset(null)} />
    </SectionCard>
  );
}

const PRESETS: Record<Preset, { name: string; smtpHost: string; smtpPort: number; fromHint: string }> = {
  google: { name: 'Google', smtpHost: 'smtp.gmail.com', smtpPort: 587, fromHint: 'you@gmail.com' },
  microsoft: { name: 'Microsoft', smtpHost: 'smtp.office365.com', smtpPort: 587, fromHint: 'you@company.com' },
  smtp: { name: '', smtpHost: '', smtpPort: 587, fromHint: 'noreply@example.com' },
};

const EMPTY_ACCOUNT = { name: '', provider: 'smtp', smtpHost: '', smtpPort: 587, smtpUser: '', smtpPass: '', fromEmail: '' };

function AccountDialog({ preset, onClose }: { preset: Preset | null; onClose: () => void }) {
  const createAccount = useCreateEmailAccount();
  const { toast } = useToast();
  const [form, setForm] = React.useState(EMPTY_ACCOUNT);

  // Load the provider preset each time the dialog opens.
  React.useEffect(() => {
    if (!preset) return;
    const p = PRESETS[preset];
    setForm({ ...EMPTY_ACCOUNT, name: p.name, smtpHost: p.smtpHost, smtpPort: p.smtpPort });
  }, [preset]);

  function updateField(field: string, value: string | number | boolean) {
    setForm((prev) => ({ ...prev, [field]: value }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    try {
      await createAccount.mutateAsync({
        name: form.name,
        provider: form.provider,
        smtpHost: form.smtpHost || undefined,
        smtpPort: form.smtpPort || undefined,
        smtpUser: form.smtpUser || undefined,
        smtpPass: form.smtpPass || undefined,
        fromEmail: form.fromEmail,
        isWarmup: true,
      });
      toast({ title: 'Account created' });
      onClose();
    } catch {
      toast({ title: 'Failed to create account', variant: 'destructive' });
    }
  }

  const p = preset ? PRESETS[preset] : PRESETS.smtp;

  return (
    <Dialog open={preset !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{preset === 'google' || preset === 'microsoft' ? `Connect ${p.name}` : 'Add email account'}</DialogTitle>
        </DialogHeader>
        {(preset === 'google' || preset === 'microsoft') && (
          <p className="m-0 text-xs text-ink-3">
            Uses {p.name}&apos;s SMTP server. Use an app password, not your normal sign-in password.
          </p>
        )}
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Name *</Label>
              <Input value={form.name} onChange={(e) => updateField('name', e.target.value)} required />
            </div>
            <div className="space-y-1.5">
              <Label>Provider</Label>
              <Select value={form.provider} onChange={(e) => updateField('provider', e.target.value)} className="w-full">
                <option value="smtp">SMTP</option>
                <option value="ses">AWS SES</option>
                <option value="sendgrid">SendGrid</option>
                <option value="custom">Custom</option>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>SMTP host</Label>
              <Input value={form.smtpHost} onChange={(e) => updateField('smtpHost', e.target.value)} placeholder="smtp.example.com" />
            </div>
            <div className="space-y-1.5">
              <Label>SMTP port</Label>
              <Input type="number" value={form.smtpPort} onChange={(e) => updateField('smtpPort', Number(e.target.value))} />
            </div>
            <div className="space-y-1.5">
              <Label>SMTP user</Label>
              <Input value={form.smtpUser} onChange={(e) => updateField('smtpUser', e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>SMTP password</Label>
              <Input type="password" value={form.smtpPass} onChange={(e) => updateField('smtpPass', e.target.value)} />
            </div>
            <div className="col-span-2 space-y-1.5">
              <Label>From email *</Label>
              <Input type="email" value={form.fromEmail} onChange={(e) => updateField('fromEmail', e.target.value)} required placeholder={p.fromHint} />
            </div>
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline" size="sm">Cancel</Button>
            </DialogClose>
            <Button type="submit" variant="brand" size="sm" disabled={createAccount.isPending}>
              {createAccount.isPending ? 'Creating…' : 'Create account'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/* ─── Reply detection ───────────────────────────────────────────────────────── */

function ReplyDetectionCard() {
  const confirm = useConfirm();
  const { data: listeners, isLoading } = useEmailListeners();
  const deleteListener = useDeleteEmailListener();
  const testConnection = useTestListenerConnection();
  const pollNow = usePollNow();
  const { toast } = useToast();

  const [adding, setAdding] = React.useState(false);
  const [explain, setExplain] = React.useState(false);

  const list = listeners ?? [];
  const on = list.some((l) => l.isActive);
  const lastCheck = list
    .map((l) => l.lastPolledAt)
    .filter((d): d is string => !!d)
    .sort()
    .pop();

  const pill: { tone: PillTone; text: string } = !on
    ? { tone: 'warn', text: 'Not connected' }
    : { tone: 'up', text: lastCheck ? `Connected — last check ${formatRelative(lastCheck).replace(/^about /, '')}` : 'Connected' };

  const busy = deleteListener.isPending || testConnection.isPending || pollNow.isPending;

  async function handleDisconnect(id: string, name: string) {
    const ok = await confirm({
      title: `Disconnect reply detection for ${name}?`,
      description: 'Replies will stop reaching your Inbox.',
      confirmLabel: 'Disconnect',
    });
    if (!ok) return;
    try {
      await deleteListener.mutateAsync(id);
      toast({ title: 'Reply detection disconnected' });
    } catch {
      toast({ title: 'Failed to disconnect', variant: 'destructive' });
    }
  }

  async function handleTest(id: string) {
    try {
      const result = await testConnection.mutateAsync(id);
      if (result.success) toast({ title: 'Connection successful' });
      else toast({ title: 'Connection failed', description: result.error, variant: 'destructive' });
    } catch {
      toast({ title: 'Connection test failed', variant: 'destructive' });
    }
  }

  async function handlePoll(id: string) {
    try {
      await pollNow.mutateAsync(id);
      toast({ title: 'Checking for replies…' });
    } catch {
      toast({ title: 'Failed to trigger a check', variant: 'destructive' });
    }
  }

  return (
    <SectionCard title="Reply detection" pill={pill} loading={isLoading}>
      {list.length === 0 ? (
        <EmptyBlock
          title="Keenpipe cannot see replies yet"
          body="Reply detection watches the inbox you send from and matches each answer to the message that caused it. Until it is connected: your reply rate reads —, the Inbox stays empty, Reports stay at zero, and no deal ever moves on its own."
          note="Read-only. It reads replies to messages Keenpipe sent, nothing else."
        >
          <Button type="button" variant="brand" size="dense" onClick={() => setAdding(true)} className="h-9 rounded-lg px-4 text-body font-semibold">
            Connect reply detection
          </Button>
          <Button type="button" variant="ghost" size="dense" onClick={() => setExplain((v) => !v)} aria-expanded={explain} className="h-9 rounded-lg px-3 text-body font-medium">
            What it reads
          </Button>
        </EmptyBlock>
      ) : (
        <div className="space-y-6">
          {list.map((listener, i) => (
            <div key={listener.id} className={cn(i > 0 && 'border-t border-line pt-6')}>
              <ListenerPanel
                listener={listener}
                busy={busy}
                onTest={() => handleTest(listener.id)}
                onPoll={() => handlePoll(listener.id)}
                onDisconnect={() => handleDisconnect(listener.id, listener.username)}
              />
            </div>
          ))}
          <UnlocksNote />
          <div className="flex items-center gap-2">
            <Button type="button" variant="panel" size="dense" onClick={() => setAdding(true)} className="h-8 rounded-lg px-3 text-xs font-medium">
              Add another inbox
            </Button>
          </div>
        </div>
      )}

      {explain && (
        <p className="mb-0 mt-5 max-w-[520px] rounded-row bg-bg-soft px-3.5 py-3 text-xs leading-relaxed text-ink-3">
          It checks the inbox you send from on a schedule and matches each new message to one Keenpipe sent. Messages that are not replies to
          something Keenpipe sent are ignored. It only reads — it never sends, moves or deletes mail.
        </p>
      )}

      <ListenerDialog open={adding} onClose={() => setAdding(false)} />
    </SectionCard>
  );
}

const EMPTY_LISTENER = { protocol: 'imap', host: '', port: 993, username: '', password: '', mailbox: 'INBOX', pollingIntervalMs: 60000 };

function ListenerDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const createListener = useCreateEmailListener();
  const { toast } = useToast();
  const { data: accounts } = useEmailAccounts();
  const { data: listeners } = useEmailListeners();
  const [form, setForm] = React.useState(EMPTY_LISTENER);
  const [accountId, setAccountId] = React.useState('');

  // The listener must be linked to the mailbox it watches, otherwise the app
  // keeps reporting that mailbox as "not watched".
  function pickAccount(id: string) {
    setAccountId(id);
    const a = (accounts ?? []).find((x) => x.id === id);
    if (!a) return;
    setForm((prev) => ({
      ...prev,
      username: a.smtpUser || a.fromEmail,
      host: a.smtpHost ? a.smtpHost.replace(/^smtp\./, 'imap.') : prev.host,
    }));
  }

  React.useEffect(() => {
    if (!open) return;
    setForm(EMPTY_LISTENER);
    const watched = new Set((listeners ?? []).map((l) => l.emailAccountId));
    const target = (accounts ?? []).find((a) => !watched.has(a.id)) ?? (accounts ?? [])[0];
    setAccountId(target?.id ?? '');
    if (target) {
      setForm({
        ...EMPTY_LISTENER,
        username: target.smtpUser || target.fromEmail,
        host: target.smtpHost ? target.smtpHost.replace(/^smtp\./, 'imap.') : '',
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function updateField(field: string, value: string | number | boolean) {
    setForm((prev) => ({ ...prev, [field]: value }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    try {
      await createListener.mutateAsync({
        emailAccountId: accountId || undefined,
        protocol: form.protocol,
        host: form.host,
        port: form.port,
        username: form.username,
        password: form.password,
        useTls: true,
        mailbox: form.mailbox,
        pollingIntervalMs: form.pollingIntervalMs,
      });
      toast({ title: 'Reply detection connected' });
      onClose();
    } catch {
      toast({ title: 'Failed to create listener', variant: 'destructive' });
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Connect reply detection</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            {(accounts ?? []).length > 0 && (
              <div className="col-span-2 space-y-1.5">
                <Label>Mailbox to watch</Label>
                <Select value={accountId} onChange={(e) => pickAccount(e.target.value)} className="w-full">
                  {(accounts ?? []).map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.fromEmail}
                    </option>
                  ))}
                </Select>
              </div>
            )}
            <div className="space-y-1.5">
              <Label>Protocol</Label>
              <Select
                value={form.protocol}
                onChange={(e) => {
                  updateField('protocol', e.target.value);
                  updateField('port', e.target.value === 'imap' ? 993 : 995);
                }}
                className="w-full"
              >
                <option value="imap">IMAP</option>
                <option value="pop3">POP3</option>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Port</Label>
              <Input type="number" value={form.port} onChange={(e) => updateField('port', Number(e.target.value))} />
            </div>
            <div className="col-span-2 space-y-1.5">
              <Label>Host *</Label>
              <Input value={form.host} onChange={(e) => updateField('host', e.target.value)} required placeholder="imap.example.com" />
            </div>
            <div className="space-y-1.5">
              <Label>Username *</Label>
              <Input value={form.username} onChange={(e) => updateField('username', e.target.value)} required />
            </div>
            <div className="space-y-1.5">
              <Label>Password *</Label>
              <Input type="password" value={form.password} onChange={(e) => updateField('password', e.target.value)} required />
            </div>
            <div className="space-y-1.5">
              <Label>Mailbox</Label>
              <Input value={form.mailbox} onChange={(e) => updateField('mailbox', e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>Check interval (ms)</Label>
              <Input type="number" min={5000} value={form.pollingIntervalMs} onChange={(e) => updateField('pollingIntervalMs', Number(e.target.value))} />
            </div>
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline" size="sm">Cancel</Button>
            </DialogClose>
            <Button type="submit" variant="brand" size="sm" disabled={createListener.isPending}>
              {createListener.isPending ? 'Connecting…' : 'Connect'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
