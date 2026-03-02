'use client';

import * as React from 'react';
import {
  useEmailAccounts,
  useCreateEmailAccount,
  useUpdateEmailAccount,
  useDeleteEmailAccount,
  useTestEmailAccount,
  useEmailListeners,
  useCreateEmailListener,
  useDeleteEmailListener,
  useTestListenerConnection,
  usePollNow,
} from '@/hooks/use-email-settings';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogTrigger,
  DialogClose,
} from '@/components/ui/dialog';
import { useToast } from '@/hooks/use-toast';
import { Mail, Plus, Trash2, Send, Plug, RefreshCw } from 'lucide-react';
import { formatRelative } from '@/lib/utils';

type Tab = 'accounts' | 'listeners';

export default function EmailSettingsPage() {
  const [tab, setTab] = React.useState<Tab>('accounts');

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <Mail className="w-6 h-6" /> Email Settings
        </h1>
        <p className="text-muted-foreground text-sm mt-1">
          Manage sending accounts and inbox listeners
        </p>
      </div>

      {/* Tabs */}
      <div className="flex gap-2 border-b border-border pb-px">
        <button
          onClick={() => setTab('accounts')}
          className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
            tab === 'accounts'
              ? 'border-primary text-primary'
              : 'border-transparent text-muted-foreground hover:text-foreground'
          }`}
        >
          Sending Accounts
        </button>
        <button
          onClick={() => setTab('listeners')}
          className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
            tab === 'listeners'
              ? 'border-primary text-primary'
              : 'border-transparent text-muted-foreground hover:text-foreground'
          }`}
        >
          Inbox Listeners
        </button>
      </div>

      {tab === 'accounts' ? <AccountsTab /> : <ListenersTab />}
    </div>
  );
}

/* ─── Sending Accounts ──────────────────────────────────────────────────────── */

function AccountsTab() {
  const { data: accounts, isLoading } = useEmailAccounts();
  const updateAccount = useUpdateEmailAccount();
  const deleteAccount = useDeleteEmailAccount();
  const testSend = useTestEmailAccount();
  const { toast } = useToast();

  const [testTo, setTestTo] = React.useState('');
  const [testingId, setTestingId] = React.useState<string | null>(null);

  async function handleToggle(id: string, isActive: boolean) {
    try {
      await updateAccount.mutateAsync({ id, isActive: !isActive });
    } catch {
      toast({ title: 'Failed to update account', variant: 'destructive' });
    }
  }

  async function handleDelete(id: string) {
    try {
      await deleteAccount.mutateAsync(id);
      toast({ title: 'Account deleted' });
    } catch {
      toast({ title: 'Failed to delete account', variant: 'destructive' });
    }
  }

  async function handleTestSend(id: string) {
    if (!testTo.trim()) return;
    setTestingId(id);
    try {
      await testSend.mutateAsync({ id, to: testTo.trim() });
      toast({ title: 'Test email sent' });
      setTestTo('');
      setTestingId(null);
    } catch {
      toast({ title: 'Test send failed', variant: 'destructive' });
      setTestingId(null);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <AddAccountDialog />
      </div>

      {isLoading ? (
        <div className="space-y-3">
          {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-24 w-full" />)}
        </div>
      ) : (accounts ?? []).length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-sm text-muted-foreground">
            No email accounts configured yet.
          </CardContent>
        </Card>
      ) : (
        (accounts ?? []).map((acct) => (
          <Card key={acct.id}>
            <CardContent className="py-4">
              <div className="flex items-start justify-between gap-4">
                <div className="space-y-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium text-sm">{acct.name}</span>
                    <Badge variant="outline" className="text-xs">{acct.provider}</Badge>
                    <Badge variant={acct.isActive ? 'secondary' : 'destructive'} className="text-xs">
                      {acct.isActive ? 'Active' : 'Inactive'}
                    </Badge>
                  </div>
                  <p className="text-xs text-muted-foreground">{acct.fromEmail}</p>
                  {acct.smtpHost && (
                    <p className="text-xs text-muted-foreground">
                      {acct.smtpHost}:{acct.smtpPort}
                    </p>
                  )}
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  {/* Test send */}
                  <div className="flex items-center gap-1">
                    <Input
                      placeholder="test@email.com"
                      className="h-8 w-40 text-xs"
                      value={testingId === acct.id ? testTo : ''}
                      onFocus={() => setTestingId(acct.id)}
                      onChange={(e) => { setTestingId(acct.id); setTestTo(e.target.value); }}
                    />
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-8 w-8"
                      onClick={() => handleTestSend(acct.id)}
                      disabled={testSend.isPending && testingId === acct.id}
                    >
                      <Send className="w-3.5 h-3.5" />
                    </Button>
                  </div>

                  {/* Toggle active */}
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => handleToggle(acct.id, acct.isActive)}
                    disabled={updateAccount.isPending}
                  >
                    {acct.isActive ? 'Disable' : 'Enable'}
                  </Button>

                  {/* Delete */}
                  <Button
                    size="icon"
                    variant="ghost"
                    onClick={() => handleDelete(acct.id)}
                    disabled={deleteAccount.isPending}
                  >
                    <Trash2 className="w-3.5 h-3.5 text-destructive" />
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        ))
      )}
    </div>
  );
}

function AddAccountDialog() {
  const [open, setOpen] = React.useState(false);
  const createAccount = useCreateEmailAccount();
  const { toast } = useToast();

  const [form, setForm] = React.useState({
    name: '',
    provider: 'smtp',
    smtpHost: '',
    smtpPort: 587,
    smtpUser: '',
    smtpPass: '',
    fromEmail: '',
  });

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
      setOpen(false);
      setForm({ name: '', provider: 'smtp', smtpHost: '', smtpPort: 587, smtpUser: '', smtpPass: '', fromEmail: '' });
    } catch {
      toast({ title: 'Failed to create account', variant: 'destructive' });
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm"><Plus className="w-4 h-4 mr-2" /> Add Account</Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Add Email Account</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Name *</Label>
              <Input value={form.name} onChange={(e) => updateField('name', e.target.value)} required />
            </div>
            <div className="space-y-1.5">
              <Label>Provider</Label>
              <select
                value={form.provider}
                onChange={(e) => updateField('provider', e.target.value)}
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm"
              >
                <option value="smtp">SMTP</option>
                <option value="ses">AWS SES</option>
                <option value="sendgrid">SendGrid</option>
                <option value="custom">Custom</option>
              </select>
            </div>
            <div className="space-y-1.5">
              <Label>SMTP Host</Label>
              <Input value={form.smtpHost} onChange={(e) => updateField('smtpHost', e.target.value)} placeholder="smtp.example.com" />
            </div>
            <div className="space-y-1.5">
              <Label>SMTP Port</Label>
              <Input type="number" value={form.smtpPort} onChange={(e) => updateField('smtpPort', Number(e.target.value))} />
            </div>
            <div className="space-y-1.5">
              <Label>SMTP User</Label>
              <Input value={form.smtpUser} onChange={(e) => updateField('smtpUser', e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>SMTP Password</Label>
              <Input type="password" value={form.smtpPass} onChange={(e) => updateField('smtpPass', e.target.value)} />
            </div>
            <div className="col-span-2 space-y-1.5">
              <Label>From Email *</Label>
              <Input type="email" value={form.fromEmail} onChange={(e) => updateField('fromEmail', e.target.value)} required placeholder="noreply@example.com" />
            </div>
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline" size="sm">Cancel</Button>
            </DialogClose>
            <Button type="submit" size="sm" disabled={createAccount.isPending}>
              {createAccount.isPending ? 'Creating…' : 'Create Account'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/* ─── Inbox Listeners ───────────────────────────────────────────────────────── */

function ListenersTab() {
  const { data: listeners, isLoading } = useEmailListeners();
  const deleteListener = useDeleteEmailListener();
  const testConnection = useTestListenerConnection();
  const pollNow = usePollNow();
  const { toast } = useToast();

  async function handleDelete(id: string) {
    try {
      await deleteListener.mutateAsync(id);
      toast({ title: 'Listener deleted' });
    } catch {
      toast({ title: 'Failed to delete listener', variant: 'destructive' });
    }
  }

  async function handleTest(id: string) {
    try {
      const result = await testConnection.mutateAsync(id);
      if (result.success) {
        toast({ title: 'Connection successful' });
      } else {
        toast({ title: 'Connection failed', description: result.error, variant: 'destructive' });
      }
    } catch {
      toast({ title: 'Connection test failed', variant: 'destructive' });
    }
  }

  async function handlePoll(id: string) {
    try {
      await pollNow.mutateAsync(id);
      toast({ title: 'Poll job queued' });
    } catch {
      toast({ title: 'Failed to trigger poll', variant: 'destructive' });
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <AddListenerDialog />
      </div>

      {isLoading ? (
        <div className="space-y-3">
          {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-24 w-full" />)}
        </div>
      ) : (listeners ?? []).length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-sm text-muted-foreground">
            No inbox listeners configured yet.
          </CardContent>
        </Card>
      ) : (
        (listeners ?? []).map((listener) => (
          <Card key={listener.id}>
            <CardContent className="py-4">
              <div className="flex items-start justify-between gap-4">
                <div className="space-y-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium text-sm">
                      {listener.host}:{listener.port}
                    </span>
                    <Badge variant="outline" className="text-xs uppercase">{listener.protocol}</Badge>
                    <Badge variant={listener.isActive ? 'secondary' : 'destructive'} className="text-xs">
                      {listener.isActive ? 'Active' : 'Inactive'}
                    </Badge>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {listener.username} | Mailbox: {listener.mailbox}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Polling every {Math.round(listener.pollingIntervalMs / 1000)}s
                    {listener.lastPolledAt && ` | Last polled ${formatRelative(listener.lastPolledAt)}`}
                  </p>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => handleTest(listener.id)}
                    disabled={testConnection.isPending}
                  >
                    <Plug className="w-3.5 h-3.5 mr-1" /> Test
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => handlePoll(listener.id)}
                    disabled={pollNow.isPending}
                  >
                    <RefreshCw className="w-3.5 h-3.5 mr-1" /> Poll Now
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    onClick={() => handleDelete(listener.id)}
                    disabled={deleteListener.isPending}
                  >
                    <Trash2 className="w-3.5 h-3.5 text-destructive" />
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        ))
      )}
    </div>
  );
}

function AddListenerDialog() {
  const [open, setOpen] = React.useState(false);
  const createListener = useCreateEmailListener();
  const { toast } = useToast();

  const [form, setForm] = React.useState({
    protocol: 'imap',
    host: '',
    port: 993,
    username: '',
    password: '',
    mailbox: 'INBOX',
    pollingIntervalMs: 60000,
  });

  function updateField(field: string, value: string | number | boolean) {
    setForm((prev) => ({ ...prev, [field]: value }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    try {
      await createListener.mutateAsync({
        protocol: form.protocol,
        host: form.host,
        port: form.port,
        username: form.username,
        password: form.password,
        useTls: true,
        mailbox: form.mailbox,
        pollingIntervalMs: form.pollingIntervalMs,
      });
      toast({ title: 'Listener created' });
      setOpen(false);
      setForm({ protocol: 'imap', host: '', port: 993, username: '', password: '', mailbox: 'INBOX', pollingIntervalMs: 60000 });
    } catch {
      toast({ title: 'Failed to create listener', variant: 'destructive' });
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm"><Plus className="w-4 h-4 mr-2" /> Add Listener</Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add Inbox Listener</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Protocol</Label>
              <select
                value={form.protocol}
                onChange={(e) => {
                  updateField('protocol', e.target.value);
                  updateField('port', e.target.value === 'imap' ? 993 : 995);
                }}
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm"
              >
                <option value="imap">IMAP</option>
                <option value="pop3">POP3</option>
              </select>
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
              <Label>Poll Interval (ms)</Label>
              <Input type="number" min={5000} value={form.pollingIntervalMs} onChange={(e) => updateField('pollingIntervalMs', Number(e.target.value))} />
            </div>
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline" size="sm">Cancel</Button>
            </DialogClose>
            <Button type="submit" size="sm" disabled={createListener.isPending}>
              {createListener.isPending ? 'Creating…' : 'Create Listener'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
