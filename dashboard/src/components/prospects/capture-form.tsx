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

import { Select } from '@/components/ui/select';
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

  const tags = form.tagsRaw.split(',').map((t) => t.trim()).filter(Boolean);

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <FormCard title="Who is it" hint="Where you found them and how to reach them.">
        <Field id="sourceType" label="Source" required>
          <Select
            id="sourceType"
            value={form.sourceType ?? 'manual_linkedin'}
            onChange={(e) => update('sourceType', e.target.value)}
            className="w-full"
            required
          >
            {SOURCE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </Select>
        </Field>

        <Field id="name" label="Name" required>
          <Input
            id="name"
            value={form.name ?? ''}
            onChange={(e) => update('name', e.target.value)}
            placeholder="Mantas Kazlauskas"
            required
          />
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field id="email" label="Email">
            <Input
              id="email"
              type="email"
              value={form.email ?? ''}
              onChange={(e) => update('email', e.target.value)}
              placeholder="mantas@hoppacard.eu"
            />
          </Field>
          <Field id="linkedinUrl" label="LinkedIn URL" hint="We auto-enrich the profile when this is set.">
            <Input
              id="linkedinUrl"
              value={form.linkedinUrl ?? ''}
              onChange={(e) => update('linkedinUrl', e.target.value)}
              placeholder="linkedin.com/in/mantas-kazlauskas"
            />
          </Field>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field id="phone" label="Phone">
            <Input id="phone" value={form.phone ?? ''} onChange={(e) => update('phone', e.target.value)} />
          </Field>
          <Field id="whatsapp" label="WhatsApp">
            <Input id="whatsapp" value={form.whatsapp ?? ''} onChange={(e) => update('whatsapp', e.target.value)} />
          </Field>
        </div>
      </FormCard>

      <FormCard title="Role" hint="Helps agents pitch the right angle.">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field id="company" label="Company">
            <Input id="company" value={form.company ?? ''} onChange={(e) => update('company', e.target.value)} />
          </Field>
          <Field id="title" label="Title">
            <Input id="title" value={form.title ?? ''} onChange={(e) => update('title', e.target.value)} />
          </Field>
        </div>
        <Field id="location" label="Location">
          <Input id="location" value={form.location ?? ''} onChange={(e) => update('location', e.target.value)} />
        </Field>
      </FormCard>

      <FormCard title="Context" hint="Anything you want the timeline to start with.">
        <Field id="tags" label="Tags" hint="Comma-separated.">
          <Input
            id="tags"
            value={form.tagsRaw}
            onChange={(e) => update('tagsRaw', e.target.value)}
            placeholder="hot, vilnius, ceo"
          />
          {tags.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {tags.map((t, i) => (
                <span key={`${t}-${i}`} className="inline-flex items-center rounded-tag bg-bg-soft px-2 py-1 text-xs text-ink-2">
                  {t}
                </span>
              ))}
            </div>
          )}
        </Field>
        <Field id="initialNote" label="Initial note">
          <Textarea
            id="initialNote"
            rows={3}
            value={form.initialNote ?? ''}
            onChange={(e) => update('initialNote', e.target.value)}
            placeholder="Met at FintechCon — they mentioned hiring 4 devops in Q2."
          />
        </Field>
      </FormCard>

      <div className="flex items-center justify-between gap-3 rounded-2xl border border-line bg-bg-panel px-5 py-3.5 shadow-sm">
        <span className="text-xs text-ink-3">
          {rateLimited ? 'Daily capture limit reached. Try again tomorrow.' : <><span className="text-down">*</span> Required</>}
        </span>
        <div className="flex items-center gap-2">
          <Button type="button" variant="outline" size="sm" onClick={() => router.back()} disabled={submitting}>
            Cancel
          </Button>
          <Button type="submit" variant="brand" size="sm" disabled={!canSubmit}>
            {submitting ? 'Adding…' : 'Add to pipeline'}
          </Button>
        </div>
      </div>
    </form>
  );
}

function FormCard({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-line bg-bg-panel shadow-sm">
      <header className="border-b border-line px-5 py-3.5">
        <h2 className="m-0 text-body font-semibold text-ink">{title}</h2>
        {hint && <p className="m-0 mt-0.5 text-xs text-ink-3">{hint}</p>}
      </header>
      <div className="flex flex-col gap-4 p-5">{children}</div>
    </section>
  );
}

function Field({
  id,
  label,
  hint,
  required,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>
        {label} {required && <span className="text-down">*</span>}
      </Label>
      {children}
      {hint && <p className="m-0 text-xs text-ink-3">{hint}</p>}
    </div>
  );
}
