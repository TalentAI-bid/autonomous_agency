'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import {
  Chrome,
  Download,
  Sparkles,
  Target,
  PenLine,
  GitMerge,
  Layers,
  MessageSquare,
  ShieldCheck,
  Check,
  Keyboard,
  History,
  ArrowRight,
  AlertTriangle,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { apiGet } from '@/lib/api';

type TabKey = 'install' | 'shortcuts' | 'whatsnew';

type LatestExtensionRelease = {
  version: string;
  extensionId: string;
  zipUrl: string;
  crxUrl: string;
  releaseNotes: string;
  releasedAt: string | null;
  sizeBytes: number | null;
};

function formatSize(bytes: number | null): string {
  if (!bytes || bytes <= 0) return '—';
  const mb = bytes / 1024 / 1024;
  if (mb >= 1) return `${mb.toFixed(1)} MB`;
  const kb = bytes / 1024;
  return `${kb.toFixed(0)} KB`;
}

const FEATURES = [
  {
    icon: Sparkles,
    title: 'Capture from profiles',
    body: 'One click turns any profile into an enriched lead. Your Discovery + Enrichment agents queue it in real time.',
  },
  {
    icon: Target,
    title: 'Score before you send',
    body: 'Live ICP fit, intent, and net-new signals so you only touch profiles that are worth a thread.',
  },
  {
    icon: PenLine,
    title: 'Draft with context',
    body: 'Outreach agent drafts a message using the profile, shared interests, and your mission brief.',
  },
  {
    icon: GitMerge,
    title: 'Sync to your pipeline',
    body: 'Every captured lead lands in the right spot — deduped against the enrichment layer across the flow.',
  },
  {
    icon: Layers,
    title: 'Bulk from Sales Navigator',
    body: 'Select up to 250 results at a time. Agents fan out the enrichment load across the flow.',
  },
  {
    icon: MessageSquare,
    title: 'Reply, Inbox, in context',
    body: 'Pull the thread history + agent insights into any reply so you never lose the narrative.',
  },
] as const;

const INSTALL_STEPS = [
  { title: 'Download the package', detail: 'A signed .zip — ~1.8 MB.' },
  { title: 'Unzip, then open extensions', detail: 'chrome://extensions · edge://extensions · about:addons' },
  { title: 'Load unpacked', detail: 'Toggle developer mode and select the unzipped folder.' },
  { title: 'Sign in with your workspace', detail: 'Use your TalentAI email. The extension provisions its own key.' },
] as const;

const SHORTCUTS = [
  { combo: ['⌥', 'S'], action: 'Score the current profile' },
  { combo: ['⌥', 'E'], action: 'Send to outreach agent' },
  { combo: ['⌥', 'D'], action: 'Draft a reply in context' },
  { combo: ['⌥', 'K'], action: 'Assign to a specific agent' },
  { combo: ['⌥', 'B'], action: 'Bulk capture from search results' },
] as const;

const CHANGELOG = [
  {
    version: 'v0.4.5',
    date: 'Apr 18, 2026',
    kind: 'Latest',
    notes: [
      'Sales Navigator bulk select up to 250 · always against the enrichment layer.',
      'Sticky floating score badge on every profile page.',
    ],
  },
  {
    version: 'v0.4.3',
    date: 'Mar 27, 2026',
    kind: 'Stable',
    notes: [
      'Reply-in-context panel now pulls thread + agent memory.',
      'Firefox MV3 support.',
    ],
  },
  {
    version: 'v0.4.0',
    date: 'Mar 02, 2026',
    kind: 'Stable',
    notes: ['New sign-in flow — no manual API key for most tenants.'],
  },
] as const;

export default function LinkedInExtensionPage() {
  const router = useRouter();
  const [tab, setTab] = useState<TabKey>('install');
  const latestQ = useQuery<LatestExtensionRelease>({
    queryKey: ['ext-latest'],
    queryFn: () => apiGet<LatestExtensionRelease>('/extension/latest'),
    // Don't hammer a 503 if no release has been cut yet.
    retry: false,
    staleTime: 60_000,
  });
  const latest = latestQ.data;

  return (
    <div className="max-w-6xl mx-auto px-6 py-8 space-y-10">
      {/* Hero */}
      <section className="grid grid-cols-1 lg:grid-cols-[1.15fr_1fr] gap-8 items-start">
        <div className="space-y-5">
          <Badge variant="outline" className="gap-1.5 text-xs">
            <Chrome className="w-3.5 h-3.5" />
            The extension
          </Badge>
          <h1 className="text-4xl sm:text-5xl font-semibold tracking-tight leading-[1.05]">
            Your agents, on every profile.
          </h1>
          <p className="text-base text-muted-foreground max-w-xl">
            Capture, score, enrich and draft without leaving the network tab.
            The extension streams profile context into your agents and lays their
            findings back on the page.
          </p>
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1.5">
              <Chrome className="w-3.5 h-3.5" /> Chrome
            </span>
            <span className="text-muted-foreground/40">·</span>
            <span>Edge</span>
            <span className="text-muted-foreground/40">·</span>
            <span>Firefox</span>
          </div>

          <div className="flex flex-wrap gap-2 pt-2">
            <Button
              size="lg"
              className="gap-2"
              disabled={!latest?.zipUrl}
              asChild={!!latest?.zipUrl}
            >
              {latest?.zipUrl ? (
                <a href={latest.zipUrl} download>
                  <Download className="w-4 h-4" />
                  Download the extension
                </a>
              ) : (
                <span>
                  <Download className="w-4 h-4" />
                  Download the extension
                </span>
              )}
            </Button>
            <Button
              size="lg"
              variant="outline"
              className="gap-2"
              onClick={() => router.push('/settings/extension')}
            >
              Manage connection
              <ArrowRight className="w-4 h-4" />
            </Button>
          </div>

          {latestQ.isError && (
            <div className="flex items-start gap-2 text-[11px] text-amber-400">
              <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              <span>
                No release has been cut yet. Run{' '}
                <code className="font-mono bg-muted px-1 rounded">extension/scripts/release.sh</code>{' '}
                on the server to publish one.
              </span>
            </div>
          )}

          <div className="flex items-center gap-4 pt-2 text-[11px] text-muted-foreground">
            <span className="inline-flex items-center gap-1.5">
              <ShieldCheck className="w-3.5 h-3.5" /> Signed · SHA256 verified
            </span>
            <span className="font-mono">
              {latest
                ? `v${latest.version} · ${formatSize(latest.sizeBytes)}`
                : latestQ.isLoading
                  ? 'loading…'
                  : 'version unavailable'}
            </span>
          </div>
        </div>

        {/* Mock preview card */}
        <ProfilePreview />
      </section>

      {/* Feature grid */}
      <section>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          {FEATURES.map(({ icon: Icon, title, body }) => (
            <Card key={title} className="border-border/60">
              <CardHeader className="pb-2">
                <div className="w-8 h-8 rounded-md bg-primary/10 text-primary flex items-center justify-center mb-2">
                  <Icon className="w-4 h-4" />
                </div>
                <CardTitle className="text-sm font-medium">{title}</CardTitle>
              </CardHeader>
              <CardContent>
                <CardDescription className="text-xs leading-relaxed">
                  {body}
                </CardDescription>
              </CardContent>
            </Card>
          ))}
        </div>
      </section>

      {/* Install / Shortcuts / What's new tabs */}
      <section>
        <div className="flex items-center gap-1 border-b border-border mb-6">
          <TabButton active={tab === 'install'} onClick={() => setTab('install')} icon={Download} label="Install" />
          <TabButton active={tab === 'shortcuts'} onClick={() => setTab('shortcuts')} icon={Keyboard} label="Shortcuts" />
          <TabButton active={tab === 'whatsnew'} onClick={() => setTab('whatsnew')} icon={History} label="What's new" />
        </div>

        {tab === 'install' && <InstallPanel />}
        {tab === 'shortcuts' && <ShortcutsPanel />}
        {tab === 'whatsnew' && <WhatsNewPanel />}
      </section>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  icon: Icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ComponentType<{ className?: string }>;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`relative flex items-center gap-1.5 px-3 py-2.5 text-sm -mb-px border-b-2 transition-colors ${
        active
          ? 'border-primary text-foreground font-medium'
          : 'border-transparent text-muted-foreground hover:text-foreground'
      }`}
    >
      <Icon className="w-3.5 h-3.5" />
      {label}
    </button>
  );
}

function InstallPanel() {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
      {INSTALL_STEPS.map((step, i) => (
        <div
          key={step.title}
          className="flex gap-3 rounded-lg border border-border p-4 bg-card/40"
        >
          <div className="w-7 h-7 shrink-0 rounded-md bg-primary/10 text-primary flex items-center justify-center text-xs font-mono">
            {i + 1}
          </div>
          <div className="min-w-0">
            <div className="text-sm font-medium">{step.title}</div>
            <div className="text-xs text-muted-foreground mt-1 font-mono">
              {step.detail}
            </div>
          </div>
        </div>
      ))}
      <div className="md:col-span-2 rounded-lg border border-border bg-muted/30 p-4 flex items-start gap-3">
        <ShieldCheck className="w-4 h-4 mt-0.5 text-emerald-400 shrink-0" />
        <p className="text-xs text-muted-foreground">
          The package is signed and the SHA256 is published next to the download link.
          Your browser sessions stay local — the extension only ever forwards results to your workspace.
        </p>
      </div>
    </div>
  );
}

function ShortcutsPanel() {
  return (
    <div className="divide-y divide-border rounded-lg border border-border overflow-hidden">
      {SHORTCUTS.map(({ combo, action }) => (
        <div
          key={action}
          className="flex items-center justify-between px-4 py-3 text-sm"
        >
          <span>{action}</span>
          <div className="flex gap-1">
            {combo.map((k) => (
              <kbd
                key={k}
                className="px-2 py-0.5 rounded-md border border-border bg-muted/40 text-[11px] font-mono tabular-nums"
              >
                {k}
              </kbd>
            ))}
          </div>
        </div>
      ))}
      <div className="px-4 py-2.5 text-[11px] text-muted-foreground bg-muted/20">
        On Windows/Linux, ⌥ maps to <kbd className="px-1 font-mono">Alt</kbd>.
      </div>
    </div>
  );
}

function WhatsNewPanel() {
  return (
    <div className="space-y-4">
      {CHANGELOG.map((entry) => (
        <div
          key={entry.version}
          className="grid grid-cols-[auto_1fr] gap-4 rounded-lg border border-border p-4"
        >
          <div className="flex flex-col items-start gap-1.5 min-w-[90px]">
            <div className="text-sm font-mono">{entry.version}</div>
            <Badge
              variant={entry.kind === 'Latest' ? 'default' : 'outline'}
              className="text-[10px] h-5"
            >
              {entry.kind}
            </Badge>
            <div className="text-[11px] text-muted-foreground">{entry.date}</div>
          </div>
          <ul className="space-y-1.5 text-sm text-muted-foreground">
            {entry.notes.map((n) => (
              <li key={n} className="flex gap-2">
                <Check className="w-3.5 h-3.5 text-emerald-400 mt-1 shrink-0" />
                <span>{n}</span>
              </li>
            ))}
          </ul>
        </div>
      ))}
      <button
        type="button"
        className="text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1 transition-colors"
      >
        Full changelog
        <ArrowRight className="w-3 h-3" />
      </button>
    </div>
  );
}

function ProfilePreview() {
  return (
    <div className="relative rounded-xl border border-border bg-card/50 overflow-hidden">
      {/* Profile header */}
      <div className="p-5 border-b border-border">
        <div className="flex items-start gap-3">
          <div className="w-14 h-14 rounded-full bg-gradient-to-br from-violet-500 to-indigo-600 flex items-center justify-center text-white font-semibold text-lg shrink-0">
            MO
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold">Maya Okafor</div>
            <div className="text-xs text-muted-foreground">
              VP of Revenue Operations · Atlas BioOps
            </div>
            <div className="text-[11px] text-muted-foreground mt-1">
              San Francisco Bay Area · 1st
            </div>
          </div>
        </div>
      </div>

      {/* Extension overlay */}
      <div className="p-5 space-y-4 bg-muted/10">
        <div className="flex items-start justify-between">
          <div>
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
              TalentAI · live read
            </div>
            <div className="flex items-baseline gap-2 mt-1">
              <div className="text-3xl font-semibold tabular-nums">87</div>
              <div className="text-xs text-muted-foreground">ICP fit</div>
            </div>
          </div>
          <Badge className="bg-emerald-500/15 text-emerald-400 hover:bg-emerald-500/20">
            Strong fit
          </Badge>
        </div>

        <div className="space-y-2">
          <SignalRow label="Hiring BDRs" value="+3 open roles" tone="good" />
          <SignalRow label="Stack matches" value="Salesforce, Outreach" tone="good" />
          <SignalRow label="Budget signals" value="Series C · Dec 2025" tone="good" />
        </div>

        <div className="rounded-md border border-border bg-background/60 p-3">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">
            Why now
          </div>
          <p className="text-xs leading-relaxed">
            Maya just caught the Atlas BioOps hiring thread. Mutual group in Forge &amp; Co., cut her
            RevOps team from 4 to 10 in three months. Likely owns budget for tooling. Worth a
            quick note if it lands in 48h.
          </p>
        </div>

        <div className="flex gap-2">
          <Button size="sm" className="flex-1 gap-1.5">
            <Target className="w-3.5 h-3.5" />
            Add to Sales Cycle
          </Button>
          <Button size="sm" variant="outline" className="flex-1 gap-1.5">
            <Sparkles className="w-3.5 h-3.5" />
            Assign to QAAN agent
          </Button>
        </div>
      </div>
    </div>
  );
}

function SignalRow({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: 'good' | 'warn';
}) {
  return (
    <div className="flex items-center justify-between text-xs">
      <span className="text-muted-foreground">{label}</span>
      <span
        className={`tabular-nums ${tone === 'good' ? 'text-emerald-400' : 'text-amber-400'}`}
      >
        {value}
      </span>
    </div>
  );
}
