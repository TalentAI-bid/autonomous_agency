'use client';

import * as React from 'react';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowUpRight, FileText, Loader2, Save, Sparkles, UserRound, type LucideIcon } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useToast } from '@/hooks/use-toast';
import { useMessagingConfig, useSaveMessagingConfig, type MessagingConfig } from '@/hooks/use-studio';

const EMPTY: MessagingConfig = {
  sender_name: '',
  sender_title: '',
  sender_location: '',
  sender_company: '',
  value_prop: '',
  target_icp: '',
  differentiator: '',
  pricing_summary: '',
  brand_voice_notes: '',
};

function Panel({ icon: Icon, title, description, children }: { icon: LucideIcon; title: string; description: string; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-line bg-bg-panel shadow-sm">
      <header className="flex items-center gap-3 border-b border-line px-5 py-3.5">
        <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-accent-weak text-accent">
          <Icon size={15} />
        </span>
        <div className="min-w-0">
          <h2 className="m-0 text-body font-semibold text-ink">{title}</h2>
          <p className="mb-0 mt-0.5 text-xs text-ink-3">{description}</p>
        </div>
      </header>
      <div className="space-y-4 p-5">{children}</div>
    </section>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      {children}
      {hint && <p className="m-0 text-xs text-ink-3">{hint}</p>}
    </div>
  );
}

export default function MessagingSettingsPage() {
  const { toast } = useToast();
  const { data, isLoading } = useMessagingConfig();
  const save = useSaveMessagingConfig();
  const [form, setForm] = useState<MessagingConfig>(EMPTY);
  const [savedPreview, setSavedPreview] = useState<string | null>(null);

  useEffect(() => {
    if (data) {
      setForm({ ...EMPTY, ...data });
    }
  }, [data]);

  function update<K extends keyof MessagingConfig>(key: K, value: MessagingConfig[K]) {
    setForm((f) => ({ ...f, [key]: value }));
    if (savedPreview) setSavedPreview(null);
  }

  async function handleSave() {
    try {
      const res = await save.mutateAsync(form);
      const snippet = (res.value_prop ?? '').slice(0, 120);
      setSavedPreview(snippet ? `Your messages will now use: "${snippet}${snippet.length >= 120 ? '…' : ''}"` : null);
      toast({ title: 'Messaging configuration saved' });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Save failed';
      toast({ title: 'Save failed', description: msg, variant: 'destructive' });
    }
  }

  return (
    <div className="space-y-4">
      {/* Intro */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-accent-mid bg-accent-weak px-5 py-4">
        <div className="flex items-center gap-3">
          <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-bg-panel text-accent">
            <Sparkles size={16} />
          </span>
          <div>
            <div className="text-body font-semibold text-ink">How the AI writes your messages</div>
            <div className="text-xs text-ink-2">The sender identity and pitch used for every message generated in Studio, outreach drafts and the inbox copilot.</div>
          </div>
        </div>
        <Button asChild type="button" variant="panel" size="sm" className="gap-1.5">
          <Link href="/studio">
            Open Studio <ArrowUpRight size={13} />
          </Link>
        </Button>
      </div>

      {isLoading ? (
        <div className="space-y-4">
          <Skeleton className="h-44 rounded-2xl" />
          <Skeleton className="h-72 rounded-2xl" />
        </div>
      ) : (
        <>
          <Panel icon={UserRound} title="Sender identity" description="Who the message comes from. Used as the sender block in every channel.">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="Sender name *">
                <Input value={form.sender_name ?? ''} onChange={(e) => update('sender_name', e.target.value)} placeholder="Hatem Azaiez" />
              </Field>
              <Field label="Sender title">
                <Input value={form.sender_title ?? ''} onChange={(e) => update('sender_title', e.target.value)} placeholder="Founder & CTO" />
              </Field>
              <Field label="Sender company *">
                <Input value={form.sender_company ?? ''} onChange={(e) => update('sender_company', e.target.value)} placeholder="TalentAI Labs" />
              </Field>
              <Field label="Sender location">
                <Input value={form.sender_location ?? ''} onChange={(e) => update('sender_location', e.target.value)} placeholder="Vilnius, Lithuania" />
              </Field>
            </div>
          </Panel>

          <Panel icon={FileText} title="Messaging context" description="What the AI uses to write relevant messages.">
            <Field label="Value proposition *" hint="Used in every generated message. Required.">
              <Textarea
                value={form.value_prop ?? ''}
                onChange={(e) => update('value_prop', e.target.value)}
                placeholder="We're an AI-native recruitment agency placing senior engineers via a 5% success-fee model."
                rows={3}
              />
            </Field>
            <Field label="Target ICP" hint="Helps the AI write relevant pitches.">
              <Textarea
                value={form.target_icp ?? ''}
                onChange={(e) => update('target_icp', e.target.value)}
                placeholder="EU fintech, AI, and Web3 companies hiring senior engineers, typically Series A-C."
                rows={2}
              />
            </Field>
            <Field label="Differentiator" hint="What makes you different from competitors.">
              <Textarea
                value={form.differentiator ?? ''}
                onChange={(e) => update('differentiator', e.target.value)}
                placeholder="5% success-fee (vs 20-25% traditional agencies), no upfront cost, AI-powered candidate matching."
                rows={2}
              />
            </Field>
            <Field label="Pricing summary">
              <Input
                value={form.pricing_summary ?? ''}
                onChange={(e) => update('pricing_summary', e.target.value)}
                placeholder="5% of first-year salary, success-fee only."
              />
            </Field>
            <Field label="Brand voice notes (optional)" hint="How it should sound. The AI follows this tone.">
              <Textarea
                value={form.brand_voice_notes ?? ''}
                onChange={(e) => update('brand_voice_notes', e.target.value)}
                placeholder="Founder-to-founder voice. Direct. No corporate speak. No 'leverage' or 'streamline'."
                rows={2}
              />
            </Field>
          </Panel>

          {savedPreview && (
            <div className="flex items-start gap-2 rounded-lg border border-up/25 bg-up/10 px-3 py-2.5 text-xs text-up">
              <Sparkles size={14} className="mt-px shrink-0" />
              <span>{savedPreview}</span>
            </div>
          )}

          <div className="sticky bottom-0 z-10 -mx-1 flex items-center justify-between gap-3 rounded-2xl border border-line bg-bg-panel/95 px-5 py-3 shadow-md backdrop-blur">
            <span className="text-xs text-ink-3">Fields marked * are required.</span>
            <Button type="button" variant="brand" size="sm" onClick={handleSave} disabled={save.isPending}>
              {save.isPending ? <Loader2 className="mr-2 size-4 animate-spin" /> : <Save className="mr-2 size-4" />}
              {save.isPending ? 'Saving…' : 'Save configuration'}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
