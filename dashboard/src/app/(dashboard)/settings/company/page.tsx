'use client';

import * as React from 'react';
import { CardSection } from '@/components/ui/card';
import { useState, useEffect } from 'react';
import { useCompanyProfile, useUpdateCompanyProfile } from '@/hooks/use-company-profile';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { useToast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';
import { Building2, Target, TrendingUp, Award, Send, Loader2, Save, Sparkles, X } from 'lucide-react';
import { CopilotPanel } from '@/components/copilot/copilot-panel';
import type { CompanyProfile } from '@/types';

const COMPANY_SIZES = ['1-10', '11-50', '51-200', '201-500', '501-1000', '1000+'];

type Tone = 'accent' | 'warn' | 'neutral';

const TONE_CLASS: Record<Tone, string> = {
  accent: 'bg-accent-weak text-accent-fg',
  warn: 'bg-warn/15 text-warn-fg',
  neutral: 'bg-bg-soft text-ink-2',
};

function Field({ label, hint, htmlFor, children }: { label: string; hint?: React.ReactNode; htmlFor?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {hint && <p className="m-0 text-xs text-ink-3">{hint}</p>}
    </div>
  );
}

/** Chip input: Enter or comma adds, × or Backspace removes. */
function TagInput({
  id,
  value,
  onChange,
  placeholder,
  tone = 'neutral',
}: {
  id?: string;
  value: string[];
  onChange: (next: string[]) => void;
  placeholder: string;
  tone?: Tone;
}) {
  const [draft, setDraft] = useState('');

  function commit(raw: string) {
    const parts = raw.split(',').map((s) => s.trim()).filter(Boolean);
    if (parts.length === 0) return;
    const next = [...value];
    for (const p of parts) if (!next.some((v) => v.toLowerCase() === p.toLowerCase())) next.push(p);
    onChange(next);
    setDraft('');
  }

  return (
    <div className="flex min-h-10 flex-wrap items-center gap-1.5 rounded-lg border border-line bg-bg-panel px-2 py-1.5 transition-colors focus-within:border-accent-mid focus-within:ring-2 focus-within:ring-accent-weak hover:border-line-strong">
      {value.map((t, i) => (
        <span key={`${t}-${i}`} className={cn('inline-flex items-center gap-1.5 rounded-tag px-2 py-1 text-xs', TONE_CLASS[tone])}>
          {tone === 'warn' && <span className="size-1.5 rounded-full bg-current opacity-70" />}
          {t}
          <button
            type="button"
            onClick={() => onChange(value.filter((_, j) => j !== i))}
            aria-label={`Remove ${t}`}
            className="-mr-0.5 grid size-4 place-items-center rounded-full opacity-60 transition hover:bg-black/10 hover:opacity-100"
          >
            <X size={11} />
          </button>
        </span>
      ))}
      <input
        id={id}
        value={draft}
        onChange={(e) => {
          const v = e.target.value;
          if (v.includes(',')) commit(v);
          else setDraft(v);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit(draft);
          } else if (e.key === 'Backspace' && !draft && value.length > 0) {
            onChange(value.slice(0, -1));
          }
        }}
        onBlur={() => commit(draft)}
        placeholder={value.length === 0 ? placeholder : 'Add another…'}
        className="min-w-[140px] flex-1 border-0 bg-transparent px-1 py-1 text-body text-ink outline-none placeholder:text-ink-4"
      />
    </div>
  );
}

export default function CompanyProfilePage() {
  const { data: profile, isLoading } = useCompanyProfile();
  const updateProfile = useUpdateCompanyProfile();
  const { toast } = useToast();

  const [form, setForm] = useState<Partial<CompanyProfile>>({});
  const [copilotOpen, setCopilotOpen] = useState(false);

  useEffect(() => {
    if (profile && Object.keys(profile).length > 0) {
      setForm(profile);
    }
  }, [profile]);

  function updateField<K extends keyof CompanyProfile>(key: K, value: CompanyProfile[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  function updateIcp(key: string, value: string[]) {
    setForm((prev) => ({
      ...prev,
      icp: { ...(prev.icp ?? {}), [key]: value },
    }));
  }

  async function handleSave() {
    if (!form.companyName?.trim()) {
      toast({ title: 'Company name is required', variant: 'destructive' });
      return;
    }
    if (!form.valueProposition?.trim()) {
      toast({ title: 'Value proposition is required', variant: 'destructive' });
      return;
    }

    try {
      await updateProfile.mutateAsync(form as CompanyProfile);
      toast({ title: 'Company profile saved', variant: 'success' });
    } catch {
      toast({ title: 'Failed to save profile', variant: 'destructive' });
    }
  }

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-20 rounded-2xl" />
        {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-48 rounded-2xl" />)}
      </div>
    );
  }

  const sizes = form.icp?.companySizes ?? [];

  return (
    <div className="space-y-4">
      {/* AI setup banner */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-accent-mid bg-accent-weak px-5 py-4">
        <div className="flex items-center gap-3">
          <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-bg-panel text-accent">
            <Sparkles size={16} />
          </span>
          <div>
            <div className="text-body font-semibold text-ink">Set this up with AI</div>
            <div className="text-xs text-ink-2">Answer a few questions and the copilot fills in your profile. Agents use it to personalize outreach.</div>
          </div>
        </div>
        <Button type="button" variant="panel" size="sm" onClick={() => setCopilotOpen(true)} className="gap-1.5">
          <Sparkles size={13} /> Setup with AI
        </Button>
      </div>

      <CopilotPanel open={copilotOpen} onClose={() => setCopilotOpen(false)} />

      <CardSection bodyClassName="space-y-4" icon={Building2} title="Company identity" description="Basic information about your company">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Company name *" htmlFor="companyName">
            <Input id="companyName" value={form.companyName ?? ''} onChange={(e) => updateField('companyName', e.target.value)} placeholder="Acme Corp" />
          </Field>
          <Field label="Website" htmlFor="website">
            <Input id="website" value={form.website ?? ''} onChange={(e) => updateField('website', e.target.value)} placeholder="https://acme.com" />
          </Field>
          <Field label="Industry" htmlFor="industry">
            <Input id="industry" value={form.industry ?? ''} onChange={(e) => updateField('industry', e.target.value)} placeholder="e.g., Technology, Healthcare" />
          </Field>
          <Field label="Company size" htmlFor="companySize">
            <Select id="companySize" value={form.companySize ?? ''} onChange={(e) => updateField('companySize', e.target.value)} className="w-full">
              <option value="">Select size</option>
              {COMPANY_SIZES.map((s) => <option key={s} value={s}>{s} employees</option>)}
            </Select>
          </Field>
          <Field label="Founded year" htmlFor="foundedYear">
            <Input
              id="foundedYear"
              type="number"
              value={form.foundedYear ?? ''}
              onChange={(e) => updateField('foundedYear', e.target.value ? parseInt(e.target.value) : null)}
              placeholder="2020"
            />
          </Field>
          <Field label="Headquarters" htmlFor="headquarters">
            <Input id="headquarters" value={form.headquarters ?? ''} onChange={(e) => updateField('headquarters', e.target.value)} placeholder="e.g., Paris, France" />
          </Field>
        </div>
      </CardSection>

      <CardSection bodyClassName="space-y-4" icon={TrendingUp} title="Sales positioning" description="How you present your company to prospects">
        <Field
          label="Value proposition *"
          htmlFor="valueProposition"
          hint={<span className="tabular-nums">{(form.valueProposition ?? '').length}/500</span>}
        >
          <Input
            id="valueProposition"
            value={form.valueProposition ?? ''}
            onChange={(e) => updateField('valueProposition', e.target.value)}
            placeholder="One-line description of the value you deliver"
            maxLength={500}
          />
        </Field>
        <Field label="Elevator pitch" htmlFor="elevatorPitch">
          <Textarea
            id="elevatorPitch"
            value={form.elevatorPitch ?? ''}
            onChange={(e) => updateField('elevatorPitch', e.target.value)}
            placeholder="2-3 sentence pitch that explains what you do and why it matters"
            rows={3}
          />
        </Field>
        <Field label="Target market" htmlFor="targetMarket">
          <Textarea
            id="targetMarket"
            value={form.targetMarketDescription ?? ''}
            onChange={(e) => updateField('targetMarketDescription', e.target.value)}
            placeholder="Describe your ideal target market and why they need your solution"
            rows={3}
          />
        </Field>
        <Field label="Key differentiators" htmlFor="differentiators" hint="Type and press Enter or comma to add.">
          <TagInput
            id="differentiators"
            value={form.differentiators ?? []}
            onChange={(v) => updateField('differentiators', v)}
            placeholder="AI-powered, 24/7 support, No-code platform"
            tone="accent"
          />
        </Field>
      </CardSection>

      <CardSection bodyClassName="space-y-4" icon={Target} title="Ideal customer profile" description="Who your best customers are. Agents use this to find the right prospects.">
        <Field label="Target industries" hint="Type and press Enter or comma to add.">
          <TagInput value={form.icp?.targetIndustries ?? []} onChange={(v) => updateIcp('targetIndustries', v)} placeholder="Fintech, Healthcare, E-commerce" tone="accent" />
        </Field>
        <Field label="Target company sizes">
          <div className="flex flex-wrap gap-1.5">
            {COMPANY_SIZES.map((size) => {
              const on = sizes.includes(size);
              return (
                <button
                  key={size}
                  type="button"
                  aria-pressed={on}
                  onClick={() => updateIcp('companySizes', on ? sizes.filter((s) => s !== size) : [...sizes, size])}
                  className={cn(
                    'rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors',
                    on
                      ? 'border-accent-mid bg-accent-weak text-accent-fg'
                      : 'border-line bg-bg-panel text-ink-2 hover:border-line-strong hover:bg-hover',
                  )}
                >
                  {size}
                </button>
              );
            })}
          </div>
        </Field>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Decision-maker roles">
            <TagInput value={form.icp?.decisionMakerRoles ?? []} onChange={(v) => updateIcp('decisionMakerRoles', v)} placeholder="CTO, VP Engineering" />
          </Field>
          <Field label="Target regions">
            <TagInput value={form.icp?.regions ?? []} onChange={(v) => updateIcp('regions', v)} placeholder="France, UK, DACH" />
          </Field>
        </div>
        <Field label="Pain points you solve">
          <TagInput
            value={form.icp?.painPointsAddressed ?? []}
            onChange={(v) => updateIcp('painPointsAddressed', v)}
            placeholder="Slow deployments, Legacy infrastructure"
            tone="warn"
          />
        </Field>
      </CardSection>

      <CardSection bodyClassName="space-y-4" icon={Award} title="Social proof" description="Case studies, notable clients and credibility signals">
        <Field label="Notable clients & case studies" htmlFor="socialProof">
          <Textarea
            id="socialProof"
            value={form.socialProof ?? ''}
            onChange={(e) => updateField('socialProof', e.target.value)}
            placeholder="e.g., Helped Company X reduce deployment time by 60%. Trusted by 200+ SaaS companies including..."
            rows={4}
          />
        </Field>
      </CardSection>

      <CardSection bodyClassName="space-y-4" icon={Send} title="Outreach defaults" description="Default sender identity and call to action for emails">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Default sender name" htmlFor="senderName">
            <Input id="senderName" value={form.defaultSenderName ?? ''} onChange={(e) => updateField('defaultSenderName', e.target.value)} placeholder="e.g., John from Acme" />
          </Field>
          <Field label="Default sender title" htmlFor="senderTitle">
            <Input id="senderTitle" value={form.defaultSenderTitle ?? ''} onChange={(e) => updateField('defaultSenderTitle', e.target.value)} placeholder="e.g., Head of Partnerships" />
          </Field>
          <Field label="Calendly URL" htmlFor="calendlyUrl">
            <Input id="calendlyUrl" value={form.calendlyUrl ?? ''} onChange={(e) => updateField('calendlyUrl', e.target.value)} placeholder="https://calendly.com/your-link" />
          </Field>
          <Field label="Default call to action" htmlFor="cta">
            <Input id="cta" value={form.callToAction ?? ''} onChange={(e) => updateField('callToAction', e.target.value)} placeholder="e.g., Book a 15-min call" />
          </Field>
        </div>
      </CardSection>

      {/* Save bar */}
      <div className="sticky bottom-0 z-10 -mx-1 flex items-center justify-between gap-3 rounded-2xl border border-line bg-bg-panel/95 px-5 py-3 shadow-md backdrop-blur">
        <span className="text-xs text-ink-3">Fields marked * are required.</span>
        <Button type="button" variant="brand" size="sm" onClick={handleSave} disabled={updateProfile.isPending}>
          {updateProfile.isPending ? <Loader2 className="mr-2 size-4 animate-spin" /> : <Save className="mr-2 size-4" />}
          {updateProfile.isPending ? 'Saving…' : 'Save company profile'}
        </Button>
      </div>
    </div>
  );
}
