'use client';

import { useState, useEffect } from 'react';
import { useCompanyProfile, useUpdateCompanyProfile } from '@/hooks/use-company-profile';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Skeleton } from '@/components/ui/skeleton';
import { useToast } from '@/hooks/use-toast';
import {
  Building2, Target, TrendingUp, Award, Send, Loader2, Save, Sparkles,
} from 'lucide-react';
import { CopilotPanel } from '@/components/copilot/copilot-panel';
import type { CompanyProfile } from '@/types';

const COMPANY_SIZES = ['1-10', '11-50', '51-200', '201-500', '501-1000', '1000+'];

function splitTags(val: string): string[] {
  return val.split(',').map(s => s.trim()).filter(Boolean);
}

function joinTags(arr?: string[]): string {
  return (arr ?? []).join(', ');
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
    setForm(prev => ({ ...prev, [key]: value }));
  }

  function updateIcp(key: string, value: string[]) {
    setForm(prev => ({
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
      <div className="space-y-6">
        <Skeleton className="h-8 w-48" />
        {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-48" />)}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold">Company Profile</h1>
          <p className="text-muted-foreground text-sm mt-1">
            Set up your company identity and sales positioning. Agents use this to personalize outreach.
          </p>
        </div>
        <Button variant="outline" onClick={() => setCopilotOpen(true)} className="gap-2">
          <Sparkles className="w-4 h-4" />
          Setup with AI
        </Button>
      </div>

      <CopilotPanel open={copilotOpen} onClose={() => setCopilotOpen(false)} />

      {/* Card 1: Company Identity */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Building2 className="w-4 h-4" /> Company Identity
          </CardTitle>
          <CardDescription>Basic information about your company</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="companyName">Company Name *</Label>
              <Input
                id="companyName"
                value={form.companyName ?? ''}
                onChange={e => updateField('companyName', e.target.value)}
                placeholder="Acme Corp"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="website">Website</Label>
              <Input
                id="website"
                value={form.website ?? ''}
                onChange={e => updateField('website', e.target.value)}
                placeholder="https://acme.com"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="industry">Industry</Label>
              <Input
                id="industry"
                value={form.industry ?? ''}
                onChange={e => updateField('industry', e.target.value)}
                placeholder="e.g., Technology, Healthcare"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="companySize">Company Size</Label>
              <select
                id="companySize"
                value={form.companySize ?? ''}
                onChange={e => updateField('companySize', e.target.value)}
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <option value="">Select size</option>
                {COMPANY_SIZES.map(s => <option key={s} value={s}>{s} employees</option>)}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="foundedYear">Founded Year</Label>
              <Input
                id="foundedYear"
                type="number"
                value={form.foundedYear ?? ''}
                onChange={e => updateField('foundedYear', e.target.value ? parseInt(e.target.value) : null)}
                placeholder="2020"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="headquarters">Headquarters</Label>
              <Input
                id="headquarters"
                value={form.headquarters ?? ''}
                onChange={e => updateField('headquarters', e.target.value)}
                placeholder="e.g., Paris, France"
              />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Card 2: Sales Positioning */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <TrendingUp className="w-4 h-4" /> Sales Positioning
          </CardTitle>
          <CardDescription>How you present your company to prospects</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="valueProposition">Value Proposition *</Label>
            <Input
              id="valueProposition"
              value={form.valueProposition ?? ''}
              onChange={e => updateField('valueProposition', e.target.value)}
              placeholder="One-line description of the value you deliver"
              maxLength={500}
            />
            <p className="text-xs text-muted-foreground">
              {(form.valueProposition ?? '').length}/500
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="elevatorPitch">Elevator Pitch</Label>
            <Textarea
              id="elevatorPitch"
              value={form.elevatorPitch ?? ''}
              onChange={e => updateField('elevatorPitch', e.target.value)}
              placeholder="2-3 sentence pitch that explains what you do and why it matters"
              rows={3}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="targetMarket">Target Market Description</Label>
            <Textarea
              id="targetMarket"
              value={form.targetMarketDescription ?? ''}
              onChange={e => updateField('targetMarketDescription', e.target.value)}
              placeholder="Describe your ideal target market and why they need your solution"
              rows={3}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="differentiators">Key Differentiators</Label>
            <Input
              id="differentiators"
              value={joinTags(form.differentiators)}
              onChange={e => updateField('differentiators', splitTags(e.target.value))}
              placeholder="Comma-separated: AI-powered, 24/7 support, No-code platform"
            />
            {(form.differentiators ?? []).length > 0 && (
              <div className="flex flex-wrap gap-1 mt-1">
                {form.differentiators!.map((d, i) => (
                  <Badge key={i} variant="secondary" className="text-xs">{d}</Badge>
                ))}
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Card 3: ICP */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Target className="w-4 h-4" /> Ideal Customer Profile (ICP)
          </CardTitle>
          <CardDescription>Define who your best customers are — agents use this to find the right prospects</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <Label>Target Industries</Label>
            <Input
              value={joinTags(form.icp?.targetIndustries)}
              onChange={e => updateIcp('targetIndustries', splitTags(e.target.value))}
              placeholder="Comma-separated: Fintech, Healthcare, E-commerce"
            />
            {(form.icp?.targetIndustries ?? []).length > 0 && (
              <div className="flex flex-wrap gap-1 mt-1">
                {form.icp!.targetIndustries!.map((t, i) => (
                  <Badge key={i} variant="outline" className="text-xs">{t}</Badge>
                ))}
              </div>
            )}
          </div>
          <div className="space-y-1.5">
            <Label>Target Company Sizes</Label>
            <div className="flex flex-wrap gap-3 mt-1">
              {COMPANY_SIZES.map(size => (
                <label key={size} className="flex items-center gap-1.5 cursor-pointer text-sm">
                  <Checkbox
                    checked={(form.icp?.companySizes ?? []).includes(size)}
                    onCheckedChange={(checked) => {
                      const current = form.icp?.companySizes ?? [];
                      const next = checked
                        ? [...current, size]
                        : current.filter(s => s !== size);
                      updateIcp('companySizes', next);
                    }}
                  />
                  {size}
                </label>
              ))}
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>Decision Maker Roles</Label>
            <Input
              value={joinTags(form.icp?.decisionMakerRoles)}
              onChange={e => updateIcp('decisionMakerRoles', splitTags(e.target.value))}
              placeholder="Comma-separated: CTO, VP Engineering, Head of DevOps"
            />
          </div>
          <div className="space-y-1.5">
            <Label>Target Regions</Label>
            <Input
              value={joinTags(form.icp?.regions)}
              onChange={e => updateIcp('regions', splitTags(e.target.value))}
              placeholder="Comma-separated: France, UK, DACH, US East Coast"
            />
          </div>
          <div className="space-y-1.5">
            <Label>Pain Points You Solve</Label>
            <Input
              value={joinTags(form.icp?.painPointsAddressed)}
              onChange={e => updateIcp('painPointsAddressed', splitTags(e.target.value))}
              placeholder="Comma-separated: Slow deployments, Legacy infrastructure, Hiring bottleneck"
            />
            {(form.icp?.painPointsAddressed ?? []).length > 0 && (
              <div className="flex flex-wrap gap-1 mt-1">
                {form.icp!.painPointsAddressed!.map((p, i) => (
                  <Badge key={i} variant="warning" className="text-xs">{p}</Badge>
                ))}
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Card 4: Social Proof */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Award className="w-4 h-4" /> Social Proof
          </CardTitle>
          <CardDescription>Case studies, notable clients, and credibility signals</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-1.5">
            <Label htmlFor="socialProof">Notable Clients & Case Studies</Label>
            <Textarea
              id="socialProof"
              value={form.socialProof ?? ''}
              onChange={e => updateField('socialProof', e.target.value)}
              placeholder="e.g., Helped Company X reduce deployment time by 60%. Trusted by 200+ SaaS companies including..."
              rows={4}
            />
          </div>
        </CardContent>
      </Card>

      {/* Card 5: Outreach Defaults */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Send className="w-4 h-4" /> Outreach Defaults
          </CardTitle>
          <CardDescription>Default sender identity and call-to-action for emails</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="senderName">Default Sender Name</Label>
              <Input
                id="senderName"
                value={form.defaultSenderName ?? ''}
                onChange={e => updateField('defaultSenderName', e.target.value)}
                placeholder="e.g., John from Acme"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="senderTitle">Default Sender Title</Label>
              <Input
                id="senderTitle"
                value={form.defaultSenderTitle ?? ''}
                onChange={e => updateField('defaultSenderTitle', e.target.value)}
                placeholder="e.g., Head of Partnerships"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="calendlyUrl">Calendly URL</Label>
              <Input
                id="calendlyUrl"
                value={form.calendlyUrl ?? ''}
                onChange={e => updateField('calendlyUrl', e.target.value)}
                placeholder="https://calendly.com/your-link"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cta">Default Call to Action</Label>
              <Input
                id="cta"
                value={form.callToAction ?? ''}
                onChange={e => updateField('callToAction', e.target.value)}
                placeholder="e.g., Book a 15-min call"
              />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Save */}
      <div className="flex justify-end">
        <Button onClick={handleSave} disabled={updateProfile.isPending}>
          {updateProfile.isPending ? (
            <Loader2 className="w-4 h-4 mr-2 animate-spin" />
          ) : (
            <Save className="w-4 h-4 mr-2" />
          )}
          {updateProfile.isPending ? 'Saving...' : 'Save Company Profile'}
        </Button>
      </div>
    </div>
  );
}
