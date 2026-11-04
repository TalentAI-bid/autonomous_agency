'use client';

import * as React from 'react';
import { StatusPill } from '@/components/home/home-parts';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle, Copy, Download, ExternalLink, Info, Linkedin, OctagonX, UserPlus,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
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
import { useAuth } from '@/hooks/use-auth';
import { apiGet, apiPost } from '@/lib/api';
import { ago } from '@/hooks/use-home';
import { cn } from '@/lib/utils';

type ExtensionStatus = {
  hasKey: boolean;
  connected: boolean;
  lastSeenAt: string | null;
  dailyTasksCount: Record<string, number>;
  dailyResetAt: string | null;
  pendingTaskCount?: number;
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

type LatestRelease = {
  version: string;
  zipUrl: string;
  downloadUrl: string;
  sizeBytes: number | null;
};

const CAPS: Record<string, number> = {
  'linkedin:search_companies': 10,
  'linkedin:fetch_company': 100,
  'gmaps:search_businesses': 20,
  'gmaps:fetch_business': 200,
  'crunchbase:search_companies': 10,
  'crunchbase:fetch_company': 50,
};

type BrowserKey = 'chrome' | 'edge' | 'firefox';

const BROWSERS: Record<BrowserKey, { label: string; extensionsUrl: string }> = {
  chrome: { label: 'Chrome', extensionsUrl: 'chrome://extensions' },
  edge: { label: 'Edge', extensionsUrl: 'edge://extensions' },
  firefox: { label: 'Firefox', extensionsUrl: 'about:debugging#/runtime/this-firefox' },
};

function detectBrowser(): { key: BrowserKey; version: string | null } {
  const ua = navigator.userAgent;
  const edge = ua.match(/Edg\/(\d+)/);
  if (edge) return { key: 'edge', version: edge[1] };
  const ff = ua.match(/Firefox\/(\d+)/);
  if (ff) return { key: 'firefox', version: ff[1] };
  const ch = ua.match(/Chrome\/(\d+)/);
  return { key: 'chrome', version: ch ? ch[1] : null };
}

function formatSize(bytes: number | null | undefined): string {
  if (!bytes || bytes <= 0) return '';
  const mb = bytes / 1024 / 1024;
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;
}

function Panel({ title, aside, children, className }: { title: string; aside?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <section className={cn('overflow-hidden rounded-2xl border border-line bg-bg-panel shadow-sm', className)}>
      <header className="flex items-center justify-between gap-3 border-b border-line px-5 py-3.5">
        <h2 className="m-0 text-body font-semibold text-ink">{title}</h2>
        {aside}
      </header>
      {children}
    </section>
  );
}

export default function ExtensionSettingsPage() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { user } = useAuth();

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

  const latestQ = useQuery<LatestRelease>({
    queryKey: ['ext-latest'],
    queryFn: () => apiGet<LatestRelease>('/extension/latest/info'),
    // Don't hammer a 503 if no release has been cut yet.
    retry: false,
    staleTime: 60_000,
  });

  const revoke = useMutation({
    mutationFn: () => apiPost('/extension/revoke'),
    onSuccess: () => {
      toast({ title: 'Extension disconnected' });
      qc.invalidateQueries({ queryKey: ['ext-status'] });
    },
    onError: () => toast({ title: 'Failed to disconnect', variant: 'destructive' }),
  });

  const cancelPending = useMutation<{ cancelledCount: number }>({
    mutationFn: () => apiPost<{ cancelledCount: number }>('/extension/tasks/cancel-pending'),
    onSuccess: (data) => {
      toast({ title: `Cancelled ${data.cancelledCount} queued task${data.cancelledCount === 1 ? '' : 's'}` });
      qc.invalidateQueries({ queryKey: ['ext-status'] });
      qc.invalidateQueries({ queryKey: ['ext-tasks-recent'] });
    },
    onError: () => toast({ title: 'Failed to stop queued tasks', variant: 'destructive' }),
  });

  const [confirmRevoke, setConfirmRevoke] = React.useState(false);
  const [browser, setBrowser] = React.useState<BrowserKey>('chrome');
  const [browserVersion, setBrowserVersion] = React.useState<string | null>(null);
  const [detected, setDetected] = React.useState<BrowserKey | null>(null);

  React.useEffect(() => {
    const d = detectBrowser();
    setBrowser(d.key);
    setDetected(d.key);
    setBrowserVersion(d.version);
  }, []);

  async function copy(text: string, label = 'Copied to clipboard') {
    try {
      await navigator.clipboard.writeText(text);
      toast({ title: label });
    } catch {
      toast({ title: 'Copy failed', variant: 'destructive' });
    }
  }

  const status = statusQ.data;
  const connected = !!status?.connected;
  const counts = status?.dailyTasksCount ?? {};
  const pending = status?.pendingTaskCount ?? 0;
  const latest = latestQ.data;
  const downloadHref = latest?.downloadUrl ?? latest?.zipUrl;
  const tasks = recentQ.data?.tasks ?? [];
  const lastDone = tasks.find((t) => t.status === 'completed');
  const completedCount = tasks.filter((t) => t.status === 'completed').length;
  const totalUsed = Object.keys(CAPS).reduce((s, k) => s + (counts[k] ?? 0), 0);
  const totalCap = Object.values(CAPS).reduce((s, n) => s + n, 0);
  const b = BROWSERS[browser];

  const download = (
    <Button asChild={!!downloadHref} variant="brand" disabled={!downloadHref} className="h-10 gap-2 rounded-lg px-5 text-body font-semibold">
      {downloadHref ? (
        <a href={downloadHref}>
          <Download size={15} />
          Download for {BROWSERS[browser === 'firefox' ? 'chrome' : browser].label}
          {latest?.sizeBytes ? ` · ${formatSize(latest.sizeBytes)}` : ''}
        </a>
      ) : (
        <span className="inline-flex items-center gap-2">
          <Download size={15} /> Download unavailable
        </span>
      )}
    </Button>
  );

  return (
    <div className="space-y-5">
      {statusQ.isLoading ? (
        <Skeleton className="h-72 rounded-2xl" />
      ) : !connected ? (
        /* ───────────── Not connected: install ───────────── */
        <Panel title="Browser extension" aside={<StatusPill tone="warn">Not connected</StatusPill>}>
          <div className="space-y-5 p-5">
            <p className="m-0 max-w-[640px] text-body leading-relaxed text-ink-2">
              The extension runs on your own LinkedIn session in your browser. Connection requests and Add lead go through it — no cloud bots, no shared
              accounts.
              {detected && (
                <>
                  {' '}
                  <strong className="font-semibold text-ink">
                    You are on {BROWSERS[detected].label}
                    {browserVersion ? ` ${browserVersion}` : ''}
                  </strong>
                  , so these are the {BROWSERS[detected].label} steps.
                </>
              )}
            </p>

            {browser !== 'firefox' && (
              <div className="flex items-start gap-2.5 rounded-card border border-warn/30 bg-warn/10 px-3.5 py-3 text-xs leading-relaxed text-warn-fg">
                <Info size={14} className="mt-px shrink-0" />
                <span>
                  <strong className="font-semibold">{b.label} will ask about developer mode every time it starts</strong>, and turns the extension off after an
                  update. That is {b.label}, not a fault. When it happens, the LinkedIn line in your sidebar turns amber — open {b.extensionsUrl} and switch it
                  back on. Ten seconds.
                </span>
              </div>
            )}

            {browser === 'firefox' ? (
              <div className="flex items-start gap-2.5 rounded-card border border-warn/30 bg-warn/10 px-3.5 py-3 text-xs leading-relaxed text-warn-fg">
                <AlertTriangle size={14} className="mt-px shrink-0" />
                <span>
                  Firefox needs a different build of the extension; the {BROWSERS.chrome.label}/{BROWSERS.edge.label} download will not load there. Open this
                  page in Chrome or Edge to install it.
                </span>
              </div>
            ) : (
              <ol className="m-0 list-none space-y-4 p-0">
                {[
                  {
                    title: 'Download and unzip',
                    sub: `Save ${latest ? 'keenpipe-extension.zip' : 'the extension .zip'} and unzip it somewhere you will not delete — ${b.label} loads it from that folder every time.`,
                  },
                  {
                    title: `Open ${b.extensionsUrl} and turn on Developer mode`,
                    sub: `Top right of the page. ${b.label} shows a security prompt on every start while it is on; dismiss it.`,
                    copy: b.extensionsUrl,
                  },
                  {
                    title: 'Load unpacked → choose the unzipped folder',
                    sub: 'Keenpipe appears in your extensions bar. Pin it.',
                  },
                  {
                    title: 'Open LinkedIn while signed in to Keenpipe',
                    sub: 'The extension links your LinkedIn session to this workspace. The sidebar line turns green when it sees it.',
                  },
                ].map((step, i) => (
                  <li key={step.title} className="flex items-start gap-3.5">
                    <span className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-full border border-line-strong bg-bg-panel font-mono text-2xs text-ink-3">
                      {i + 1}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="text-body font-medium text-ink">{step.title}</div>
                      <div className="mt-0.5 text-xs text-ink-3">{step.sub}</div>
                    </div>
                    {step.copy && (
                      <Button type="button" variant="panel" size="dense" onClick={() => copy(step.copy!, `${step.copy} copied — paste it in the address bar`)} className="h-7 shrink-0 rounded-lg">
                        <Copy size={12} /> Copy link
                      </Button>
                    )}
                  </li>
                ))}
              </ol>
            )}

            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              {download}
              <span className="text-xs text-ink-3">
                {latest
                  ? `Signed .zip · version ${latest.version}`
                  : latestQ.isLoading
                    ? 'Checking the latest version…'
                    : 'No release has been published yet. Ask your admin to run the extension release script.'}
              </span>
            </div>

            <p className="m-0 flex flex-wrap items-center gap-1.5 text-xs text-ink-3">
              Using another browser?
              {(Object.keys(BROWSERS) as BrowserKey[])
                .filter((k) => k !== browser)
                .map((k) => (
                  <button key={k} type="button" onClick={() => setBrowser(k)} className="font-medium text-accent-fg hover:underline">
                    Show {BROWSERS[k].label} steps
                  </button>
                ))}
              <span>— Edge loads it the same way; Firefox needs a different build.</span>
            </p>
          </div>
        </Panel>
      ) : (
        /* ───────────── Connected: health ───────────── */
        <Panel title="Browser extension" aside={<StatusPill tone="up">Connected</StatusPill>}>
          <div className="space-y-4 p-5">
            <div className="flex flex-wrap items-center gap-3.5">
              <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-bg-soft text-ink-3">
                <Linkedin size={18} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-body font-semibold text-ink">Extension connected{user?.name ? ` as ${user.name}` : ''}</div>
                <div className="text-xs text-ink-3">
                  {detected ? `${BROWSERS[detected].label}${browserVersion ? ` ${browserVersion}` : ''}` : 'Browser'}
                  {latest ? ` · latest release ${latest.version}` : ''} · last seen {status?.lastSeenAt ? `${ago(status.lastSeenAt)} ago` : '—'}
                </div>
              </div>
              <StatusPill tone="up">Healthy</StatusPill>
              <Button type="button" variant="ghost" size="dense" onClick={() => setConfirmRevoke(true)} disabled={revoke.isPending} className="h-8 rounded-lg text-ink-2">
                Disconnect
              </Button>
            </div>

            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              {[
                { label: 'Requests today', value: `${totalUsed} of ${totalCap}`, sub: 'Daily limits keep your accounts safe' },
                { label: 'Queued tasks', value: pending, sub: pending ? 'Waiting for the extension' : 'Nothing waiting' },
                { label: 'Completed', value: completedCount, sub: `of the last ${tasks.length} tasks` },
                { label: 'Last capture', value: lastDone ? ago(lastDone.createdAt) + ' ago' : '—', sub: lastDone ? `${lastDone.site} · ${lastDone.type.replace(/_/g, ' ')}` : 'No captures yet' },
              ].map((t) => (
                <div key={t.label} className="rounded-card border border-line bg-bg-panel px-4 py-3">
                  <div className="text-3xs font-medium uppercase tracking-[0.09em] text-ink-4">{t.label}</div>
                  <div className="mt-1.5 font-display text-[22px] leading-none text-ink">{t.value}</div>
                  <div className="mt-1.5 truncate text-2xs text-ink-3" title={t.sub}>
                    {t.sub}
                  </div>
                </div>
              ))}
            </div>

            {pending > 0 && (
              <div className="flex items-center justify-between gap-3 rounded-card border border-line bg-bg-sub px-3.5 py-2.5 text-xs text-ink-2">
                <span>
                  {pending} task{pending === 1 ? '' : 's'} queued. Stopping tells the extension to halt immediately.
                </span>
                <Button type="button" variant="panel" size="dense" onClick={() => cancelPending.mutate()} disabled={cancelPending.isPending} className="h-7 shrink-0 rounded-lg">
                  <OctagonX size={12} /> Stop &amp; clear
                </Button>
              </div>
            )}
          </div>
        </Panel>
      )}

      {/* ───────────── What it does ───────────── */}
      {connected && (
        <Panel title="Add lead — capturing from LinkedIn">
          <div className="grid gap-5 p-5 md:grid-cols-[minmax(0,1fr)_280px]">
            <p className="m-0 text-body leading-relaxed text-ink-2">
              On any LinkedIn profile, the extension shows one button: <strong className="font-semibold text-ink">Add lead</strong>. It creates the person
              and their company in Keenpipe, enriches them, scores them against your bar and — if they clear it — drafts a message for Approvals. Nothing
              sends from LinkedIn itself.
            </p>
            <div className="rounded-card border border-dashed border-line-strong bg-bg-sub p-3.5">
              <div className="text-3xs font-medium uppercase tracking-[0.09em] text-ink-4">Example · the button on a profile</div>
              <div className="mt-2.5 flex items-center gap-2.5">
                <span className="grid size-9 place-items-center rounded-full bg-accent-weak text-xs font-semibold text-accent-fg">AM</span>
                <div className="min-w-0">
                  <div className="truncate text-body font-medium text-ink">Alex Morgan</div>
                  <div className="truncate text-xs text-ink-3">Head of Growth · Example Co</div>
                </div>
              </div>
              <span className="mt-3 inline-flex h-7 items-center gap-1.5 rounded-lg bg-accent px-3 text-xs font-semibold text-white">
                <UserPlus size={12} /> Add lead
              </span>
            </div>
          </div>
        </Panel>
      )}

      {/* ───────────── Troubleshooting ───────────── */}
      <Panel title="If it stops working" aside={<span className="hidden text-xs text-ink-3 sm:block">Each one turns the LinkedIn line amber in the sidebar</span>}>
        <ul className="m-0 list-none divide-y divide-line p-0">
          {[
            {
              title: `${b.label === 'Firefox' ? 'The browser' : b.label} turned it off after an update`,
              sub: `Open ${b.extensionsUrl} and switch Keenpipe back on. Developer-mode extensions are disabled on every ${b.label} update.`,
              action: (
                <Button type="button" variant="panel" size="dense" onClick={() => copy(b.extensionsUrl, `${b.extensionsUrl} copied — paste it in the address bar`)} className="h-7 rounded-lg">
                  <Copy size={12} /> Copy {b.extensionsUrl.split('#')[0]}
                </Button>
              ),
            },
            {
              title: 'LinkedIn signed you out',
              sub: 'Sign in to LinkedIn in the same browser profile. The extension reconnects on its own within a minute.',
              action: (
                <Button asChild variant="panel" size="dense" className="h-7 rounded-lg">
                  <a href="https://www.linkedin.com" target="_blank" rel="noopener noreferrer">
                    <ExternalLink size={12} /> Open LinkedIn
                  </a>
                </Button>
              ),
            },
            {
              title: 'Session not seen for more than a day',
              sub: 'The browser was closed, or the profile changed. Open LinkedIn once; if the line stays amber, reinstall from the download above.',
              action: downloadHref ? (
                <Button asChild variant="panel" size="dense" className="h-7 rounded-lg">
                  <a href={downloadHref}>
                    <Download size={12} /> Reinstall
                  </a>
                </Button>
              ) : null,
            },
            {
              title: 'LinkedIn asked for a check',
              sub: 'LinkedIn sometimes asks you to confirm it is you. Do it in the tab; requests pause until then and resume on their own.',
              action: (
                <Button asChild variant="panel" size="dense" className="h-7 rounded-lg">
                  <a href="https://www.linkedin.com" target="_blank" rel="noopener noreferrer">
                    <ExternalLink size={12} /> Open LinkedIn
                  </a>
                </Button>
              ),
            },
          ].map((row) => (
            <li key={row.title} className="flex items-start gap-3 px-5 py-3.5">
              <span className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full bg-warn/15 text-warn-fg">
                <AlertTriangle size={11} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-body font-medium text-ink">{row.title}</div>
                <div className="mt-0.5 text-xs leading-relaxed text-ink-3">{row.sub}</div>
              </div>
              <div className="shrink-0">{row.action}</div>
            </li>
          ))}
        </ul>
      </Panel>

      {/* Disconnect confirm */}
      <Dialog open={confirmRevoke} onOpenChange={setConfirmRevoke}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Disconnect the extension?</DialogTitle>
            <DialogDescription>
              The extension will be disconnected immediately and stop capturing. To connect again, sign in from the extension popup.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <DialogClose asChild>
              <Button variant="outline" size="sm">Cancel</Button>
            </DialogClose>
            <Button
              size="sm"
              variant="destructive"
              onClick={() => {
                revoke.mutate();
                setConfirmRevoke(false);
              }}
              disabled={revoke.isPending}
            >
              Disconnect
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
