'use client';

import * as React from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogClose,
} from '@/components/ui/dialog';
import { useToast } from '@/hooks/use-toast';
import { apiGet, apiPost } from '@/lib/api';
import { Chrome, Copy, KeyRound, Trash2, Plug, PlugZap, AlertTriangle } from 'lucide-react';

type ExtensionStatus = {
  hasKey: boolean;
  connected: boolean;
  lastSeenAt: string | null;
  dailyTasksCount: Record<string, number>;
  dailyResetAt: string | null;
};

type RecentTask = {
  id: string;
  site: string;
  type: string;
  status: string;
  priority: number;
  attempts: number;
  error: string | null;
  params: Record<string, unknown> | null;
  result: Record<string, unknown> | null;
  itemCount: number;
  createdAt: string;
  dispatchedAt: string | null;
  completedAt: string | null;
};

const CAPS: Record<string, number> = {
  'linkedin:search_companies': 10,
  'linkedin:fetch_company': 100,
  'gmaps:search_businesses': 20,
  'gmaps:fetch_business': 200,
  'crunchbase:search_companies': 10,
  'crunchbase:fetch_company': 50,
};

export default function ExtensionSettingsPage() {
  const qc = useQueryClient();
  const { toast } = useToast();

  const statusQ = useQuery<ExtensionStatus>({
    queryKey: ['ext-status'],
    queryFn: () => apiGet<ExtensionStatus>('/extension/status'),
    refetchInterval: 5000,
  });

  const recentQ = useQuery<{ tasks: RecentTask[]; count: number }>({
    queryKey: ['ext-tasks-recent'],
    queryFn: () => apiGet<{ tasks: RecentTask[]; count: number }>('/extension/tasks/recent?limit=20'),
    refetchInterval: 10000,
  });

  const generate = useMutation<{ apiKey: string; sessionId: string }>({
    mutationFn: () => apiPost<{ apiKey: string; sessionId: string }>('/extension/generate-key'),
    onSuccess: (data) => {
      setShownKey(data.apiKey);
      qc.invalidateQueries({ queryKey: ['ext-status'] });
    },
    onError: () => toast({ title: 'Failed to generate key', variant: 'destructive' }),
  });

  const revoke = useMutation({
    mutationFn: () => apiPost('/extension/revoke'),
    onSuccess: () => {
      toast({ title: 'Extension key revoked' });
      qc.invalidateQueries({ queryKey: ['ext-status'] });
    },
    onError: () => toast({ title: 'Failed to revoke', variant: 'destructive' }),
  });

  const [shownKey, setShownKey] = React.useState<string | null>(null);
  const [confirmRevoke, setConfirmRevoke] = React.useState(false);

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast({ title: 'Copied to clipboard' });
    } catch {
      toast({ title: 'Copy failed', variant: 'destructive' });
    }
  }

  const status = statusQ.data;
  const counts = status?.dailyTasksCount ?? {};

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <Chrome className="w-6 h-6" /> Browser Extension
        </h1>
        <p className="text-muted-foreground text-sm mt-1">
          Scrape LinkedIn, Google Maps, and Crunchbase using your authenticated browser sessions.
        </p>
      </div>

      {/* Status + Key */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center justify-between text-base">
            <span>Status</span>
            {statusQ.isLoading ? (
              <Skeleton className="h-6 w-24" />
            ) : status?.connected ? (
              <Badge className="bg-emerald-500/15 text-emerald-400 hover:bg-emerald-500/25 gap-1">
                <PlugZap className="w-3 h-3" /> Connected
              </Badge>
            ) : status?.hasKey ? (
              <Badge variant="outline" className="gap-1">
                <Plug className="w-3 h-3" /> Key issued — waiting for extension
              </Badge>
            ) : (
              <Badge variant="outline">No key issued</Badge>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {statusQ.isLoading ? (
            <Skeleton className="h-16 w-full" />
          ) : (
            <p className="text-sm text-muted-foreground">
              {status?.hasKey
                ? status.connected
                  ? `Extension connected. Last seen: ${fmtDate(status.lastSeenAt)}.`
                  : 'An API key is issued but the extension has not connected. Open the extension popup, paste the key, and click Connect.'
                : 'Generate an API key, paste it into the TalentAI Chrome extension popup, and your browser becomes the scraping agent.'}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              onClick={() => generate.mutate()}
              disabled={generate.isPending}
            >
              <KeyRound className="w-4 h-4 mr-2" />
              {status?.hasKey ? 'Rotate key' : 'Generate API key'}
            </Button>
            {status?.hasKey && (
              <Button
                size="sm"
                variant="destructive"
                onClick={() => setConfirmRevoke(true)}
                disabled={revoke.isPending}
              >
                <Trash2 className="w-4 h-4 mr-2" /> Revoke key
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Usage */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Today's usage</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid sm:grid-cols-2 gap-3">
            {Object.entries(CAPS).map(([key, cap]) => {
              const used = counts[key] ?? 0;
              const pct = Math.min(100, Math.round((used / cap) * 100));
              const [site, type] = key.split(':');
              return (
                <div key={key} className="space-y-1.5">
                  <div className="flex justify-between text-xs">
                    <span className="text-muted-foreground">
                      <span className="font-medium text-foreground">{site}</span> / {type}
                    </span>
                    <span className="tabular-nums">{used} / {cap}</span>
                  </div>
                  <div className="h-1.5 rounded-full bg-zinc-800 overflow-hidden">
                    <div
                      className={`h-full transition-all ${pct >= 90 ? 'bg-red-500' : pct >= 60 ? 'bg-amber-500' : 'bg-emerald-500'}`}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
          {status?.dailyResetAt && (
            <p className="mt-4 text-xs text-muted-foreground">
              Counters reset 24 hours after {fmtDate(status.dailyResetAt)}.
            </p>
          )}
        </CardContent>
      </Card>

      {/* Recent tasks */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Recent tasks</CardTitle>
        </CardHeader>
        <CardContent>
          {recentQ.isLoading ? (
            <Skeleton className="h-32 w-full" />
          ) : (recentQ.data?.tasks ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">No extension tasks yet.</p>
          ) : (
            <div className="divide-y divide-border">
              {(recentQ.data?.tasks ?? []).map((t) => (
                <RecentTaskRow key={t.id} task={t} />
              ))}
            </div>
          )}
          <p className="mt-3 text-[11px] text-muted-foreground">
            Click a row to see the full request params and the raw response from the
            extension. If a task shows "completed" with <span className="font-mono">items: 0</span>,
            the page loaded but the adapter didn't recognise it — inspect{' '}
            <span className="font-mono">result.debug</span> to see why
            (login wall, captcha, new DOM, etc.).
          </p>
        </CardContent>
      </Card>

      {/* Install instructions */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">How to install</CardTitle>
        </CardHeader>
        <CardContent className="text-sm space-y-3 text-muted-foreground">
          <div className="rounded-md border border-emerald-500/20 bg-emerald-500/10 p-3 text-xs text-emerald-300">
            <strong className="text-emerald-200">New:</strong> You no longer need to generate an
            API key manually. After installing the extension, open its popup and sign in with
            your TalentAI email and password — the extension provisions its own connection key
            automatically. The buttons above remain available as an advanced fallback (e.g. for
            SSO-only tenants or scripted provisioning).
          </div>
          <ol className="list-decimal ml-5 space-y-1">
            <li>Open <code className="bg-muted px-1 rounded">chrome://extensions</code> in Chrome.</li>
            <li>Enable <strong>Developer mode</strong> (top-right toggle).</li>
            <li>Click <strong>Load unpacked</strong> and select the <code className="bg-muted px-1 rounded">extension/</code> folder from the TalentAI repo.</li>
            <li>Click the TalentAI icon in your toolbar, enter your TalentAI email &amp; password and the server URL, then click <strong>Sign in</strong>.</li>
            <li>Stay signed into LinkedIn / Google Maps / Crunchbase in your regular Chrome window — the extension uses your existing sessions.</li>
          </ol>
        </CardContent>
      </Card>

      {/* Generated key dialog */}
      <Dialog open={!!shownKey} onOpenChange={(open) => !open && setShownKey(null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <KeyRound className="w-5 h-5" /> Your new API key
            </DialogTitle>
            <DialogDescription>
              <span className="flex items-center gap-2 text-amber-400 font-medium">
                <AlertTriangle className="w-4 h-4" />
                Copy this now — you won't be able to see it again.
              </span>
            </DialogDescription>
          </DialogHeader>
          <div className="bg-muted px-3 py-2 rounded font-mono text-xs break-all select-all">
            {shownKey}
          </div>
          <DialogFooter className="sm:justify-between gap-2">
            <Button variant="outline" size="sm" onClick={() => shownKey && copy(shownKey)}>
              <Copy className="w-4 h-4 mr-2" /> Copy
            </Button>
            <DialogClose asChild>
              <Button size="sm">I've saved it</Button>
            </DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Revoke confirm */}
      <Dialog open={confirmRevoke} onOpenChange={setConfirmRevoke}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Revoke extension key?</DialogTitle>
            <DialogDescription>
              The current Chrome extension will be immediately disconnected.
              You'll need to generate a new key and paste it into the extension to reconnect.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <DialogClose asChild>
              <Button variant="outline" size="sm">Cancel</Button>
            </DialogClose>
            <Button
              size="sm"
              variant="destructive"
              onClick={() => { revoke.mutate(); setConfirmRevoke(false); }}
              disabled={revoke.isPending}
            >
              Revoke
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function RecentTaskRow({ task }: { task: RecentTask }) {
  const [open, setOpen] = React.useState(false);
  const completed = task.status === 'completed';
  const empty = completed && task.itemCount === 0;

  return (
    <div className="py-2 text-xs">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between gap-3 text-left hover:bg-muted/30 -mx-2 px-2 py-1 rounded"
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="text-[10px]">{task.site}</Badge>
            <span className="font-mono truncate">{task.type}</span>
            {completed && (
              <span
                className={`tabular-nums text-[10px] ${empty ? 'text-amber-400' : 'text-emerald-400'}`}
                title="Items extracted by the adapter from the result blob"
              >
                items: {task.itemCount}
              </span>
            )}
          </div>
          {task.error && (
            <p className="text-red-400 mt-0.5 truncate" title={task.error}>{task.error}</p>
          )}
          {empty && !task.error && (
            <p className="text-amber-400 mt-0.5 truncate">
              Completed but extracted nothing — expand to inspect the page diagnostics.
            </p>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <StatusBadge status={task.status} />
          <span className="text-muted-foreground tabular-nums">{fmtDate(task.createdAt)}</span>
          <span className="text-muted-foreground">{open ? '▾' : '▸'}</span>
        </div>
      </button>
      {open && (
        <div className="mt-2 ml-2 grid gap-2 sm:grid-cols-2">
          <PayloadBlock label="Params" value={task.params} />
          <PayloadBlock label="Result" value={task.result} />
        </div>
      )}
    </div>
  );
}

function PayloadBlock({ label, value }: { label: string; value: unknown }) {
  return (
    <div className="rounded border border-border bg-muted/30 p-2">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">{label}</div>
      <pre className="text-[10px] font-mono whitespace-pre-wrap break-all max-h-64 overflow-auto">
        {value ? JSON.stringify(value, null, 2) : '—'}
      </pre>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const style = {
    completed: 'bg-emerald-500/15 text-emerald-400',
    dispatched: 'bg-sky-500/15 text-sky-400',
    in_progress: 'bg-sky-500/15 text-sky-400',
    pending: 'bg-zinc-500/15 text-zinc-400',
    failed: 'bg-red-500/15 text-red-400',
    cancelled: 'bg-zinc-500/15 text-zinc-400',
  }[status] ?? 'bg-zinc-500/15 text-zinc-400';
  return <Badge className={`${style} hover:${style} text-[10px]`}>{status}</Badge>;
}

function fmtDate(v: string | null): string {
  if (!v) return '—';
  try {
    const d = new Date(v);
    return d.toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' });
  } catch {
    return v;
  }
}
