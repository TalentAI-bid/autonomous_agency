'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import axios from 'axios';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { toast } from '@/hooks/use-toast';
import { captureProspect, type CaptureInput } from '@/lib/api/prospects';

// Source labels match the option values that the agentcore captureSchema
// accepts. Adding a new option here without updating SOURCE_TYPES in
// contact.routes.ts will still work — the backend logs and accepts the
// new value — but only listed values are guaranteed UX-tested.
const SOURCE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'manual_linkedin', label: 'LinkedIn (manual search)' },
  { value: 'referral', label: 'Referral' },
  { value: 'event', label: 'Event' },
  { value: 'inbound', label: 'Inbound' },
  { value: 'news_article', label: 'News article' },
  { value: 'manual_other', label: 'Other' },
];

export function CaptureForm() {
  const router = useRouter();
  const [submitting, setSubmitting] = React.useState(false);
  const [rateLimited, setRateLimited] = React.useState(false);

  const [form, setForm] = React.useState<CaptureInput & { tagsRaw: string }>({
    sourceType: 'manual_linkedin',
    name: '',
    email: '',
    linkedinUrl: '',
    phone: '',
    whatsapp: '',
    company: '',
    title: '',
    location: '',
    initialNote: '',
    tagsRaw: '',
  });

  function update<K extends keyof (CaptureInput & { tagsRaw: string })>(
    key: K,
    value: (CaptureInput & { tagsRaw: string })[K],
  ) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  const canSubmit = !submitting && !rateLimited && (form.name?.trim().length ?? 0) > 0;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      const tags = form.tagsRaw
        ? form.tagsRaw.split(',').map((t) => t.trim()).filter(Boolean)
        : undefined;
      const payload: CaptureInput = {
        name: form.name?.trim() || undefined,
        email: form.email?.trim() || undefined,
        linkedinUrl: form.linkedinUrl?.trim() || undefined,
        company: form.company?.trim() || undefined,
        title: form.title?.trim() || undefined,
        location: form.location?.trim() || undefined,
        phone: form.phone?.trim() || undefined,
        whatsapp: form.whatsapp?.trim() || undefined,
        sourceType: form.sourceType,
        tags,
        initialNote: form.initialNote?.trim() || undefined,
      };
      const result = await captureProspect(payload);

      if (result.isDuplicate) {
        toast({
          title: 'Already in your pipeline',
          description: result.existingStage
            ? `Stage: ${result.existingStage}. Opening existing record.`
            : 'Opening existing record.',
        });
      } else {
        toast({
          title: 'Prospect added',
          description: 'Captured and ready in the pipeline.',
          variant: 'success',
        });
      }

      router.push(`/prospects/${encodeURIComponent(result.contactId)}`);
    } catch (err: unknown) {
      const status = axios.isAxiosError(err) ? err.response?.status : undefined;
      const code = axios.isAxiosError(err)
        ? (err.response?.data as { error?: { code?: string; message?: string } } | undefined)?.error?.code
        : undefined;
      const message = axios.isAxiosError(err)
        ? (err.response?.data as { error?: { message?: string } } | undefined)?.error?.message
          ?? err.message
        : err instanceof Error
          ? err.message
          : 'Capture failed';

      if (status === 429 || code === 'CAPTURE_RATE_LIMIT') {
        setRateLimited(true);
        toast({
          title: 'Daily capture limit reached',
          description: 'You have hit the 100/day cap. Try again tomorrow.',
          variant: 'destructive',
        });
      } else {
        toast({
          title: 'Could not add prospect',
          description: message,
          variant: 'destructive',
        });
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4 max-w-xl">
      <div className="grid gap-2">
        <Label htmlFor="sourceType">Source <span className="text-red-500">*</span></Label>
        <select
          id="sourceType"
          value={form.sourceType ?? 'manual_linkedin'}
          onChange={(e) => update('sourceType', e.target.value)}
          className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          required
        >
          {SOURCE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      </div>

      <div className="grid gap-2">
        <Label htmlFor="name">Name <span className="text-red-500">*</span></Label>
        <Input
          id="name"
          value={form.name ?? ''}
          onChange={(e) => update('name', e.target.value)}
          placeholder="Mantas Kazlauskas"
          required
        />
      </div>

      <div className="grid gap-2">
        <Label htmlFor="email">Email</Label>
        <Input
          id="email"
          type="email"
          value={form.email ?? ''}
          onChange={(e) => update('email', e.target.value)}
          placeholder="mantas@hoppacard.eu"
        />
      </div>

      <div className="grid gap-2">
        <Label htmlFor="linkedinUrl">LinkedIn URL</Label>
        <Input
          id="linkedinUrl"
          value={form.linkedinUrl ?? ''}
          onChange={(e) => update('linkedinUrl', e.target.value)}
          placeholder="https://www.linkedin.com/in/mantas-kazlauskas/"
        />
        <p className="text-xs text-muted-foreground">We&apos;ll auto-enrich if provided.</p>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="grid gap-2">
          <Label htmlFor="phone">Phone</Label>
          <Input id="phone" value={form.phone ?? ''} onChange={(e) => update('phone', e.target.value)} />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="whatsapp">WhatsApp</Label>
          <Input id="whatsapp" value={form.whatsapp ?? ''} onChange={(e) => update('whatsapp', e.target.value)} />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="grid gap-2">
          <Label htmlFor="company">Company</Label>
          <Input id="company" value={form.company ?? ''} onChange={(e) => update('company', e.target.value)} />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="title">Title</Label>
          <Input id="title" value={form.title ?? ''} onChange={(e) => update('title', e.target.value)} />
        </div>
      </div>

      <div className="grid gap-2">
        <Label htmlFor="location">Location</Label>
        <Input id="location" value={form.location ?? ''} onChange={(e) => update('location', e.target.value)} />
      </div>

      <div className="grid gap-2">
        <Label htmlFor="tags">Tags</Label>
        <Input
          id="tags"
          value={form.tagsRaw}
          onChange={(e) => update('tagsRaw', e.target.value)}
          placeholder="hot, vilnius, ceo"
        />
        <p className="text-xs text-muted-foreground">Comma-separated.</p>
      </div>

      <div className="grid gap-2">
        <Label htmlFor="initialNote">Initial note</Label>
        <Textarea
          id="initialNote"
          rows={3}
          value={form.initialNote ?? ''}
          onChange={(e) => update('initialNote', e.target.value)}
          placeholder="Met at FintechCon — they mentioned hiring 4 devops in Q2."
        />
      </div>

      <div className="flex items-center gap-2 pt-2">
        <Button type="submit" disabled={!canSubmit}>
          {submitting ? 'Adding…' : 'Add to Pipeline'}
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={() => router.back()}
          disabled={submitting}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}
