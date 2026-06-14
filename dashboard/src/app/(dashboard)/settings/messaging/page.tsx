'use client';

import { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useToast } from '@/hooks/use-toast';
import { Save, Mail, Sparkles } from 'lucide-react';
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

export default function MessagingSettingsPage() {
  const { toast } = useToast();
  const { data, isLoading } = useMessagingConfig();
  const save = useSaveMessagingConfig();
  const [form, setForm] = useState<MessagingConfig>(EMPTY);
  const [savedPreview, setSavedPreview] = useState<string | null>(null);

  useEffect(() => {
    if (data?.data) {
      setForm({ ...EMPTY, ...data.data });
    }
  }, [data]);

  function update<K extends keyof MessagingConfig>(key: K, value: MessagingConfig[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function handleSave() {
    try {
      const res = await save.mutateAsync(form);
      const snippet = (res.data.value_prop ?? '').slice(0, 120);
      setSavedPreview(snippet ? `Your messages will now use: "${snippet}${snippet.length >= 120 ? '…' : ''}"` : null);
      toast({ title: 'Messaging configuration saved' });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Save failed';
      toast({ title: 'Save failed', description: msg, variant: 'destructive' });
    }
  }

  return (
    <div className="space-y-6 max-w-3xl">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <Mail className="w-6 h-6 text-muted-foreground" />
          Messaging Configuration
        </h1>
        <p className="text-muted-foreground text-sm mt-1">
          Configure the sender identity + value proposition used by every message generated in the{' '}
          <a href="/studio" className="text-blue-400 hover:underline">Studio</a>.
        </p>
      </div>

      {isLoading ? (
        <div className="space-y-4">
          <Skeleton className="h-32 w-full" />
          <Skeleton className="h-48 w-full" />
        </div>
      ) : (
        <>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Sender Identity</CardTitle>
              <CardDescription>Who the message comes from. Used as the sender block in every channel prompt.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <Label className="text-xs">Sender Name *</Label>
                  <Input value={form.sender_name ?? ''} onChange={(e) => update('sender_name', e.target.value)} placeholder="Hatem Azaiez" />
                </div>
                <div>
                  <Label className="text-xs">Sender Title</Label>
                  <Input value={form.sender_title ?? ''} onChange={(e) => update('sender_title', e.target.value)} placeholder="Founder &amp; CTO" />
                </div>
                <div>
                  <Label className="text-xs">Sender Company *</Label>
                  <Input value={form.sender_company ?? ''} onChange={(e) => update('sender_company', e.target.value)} placeholder="TalentAI Labs" />
                </div>
                <div>
                  <Label className="text-xs">Sender Location</Label>
                  <Input value={form.sender_location ?? ''} onChange={(e) => update('sender_location', e.target.value)} placeholder="Vilnius, Lithuania" />
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Messaging Context</CardTitle>
              <CardDescription>What the AI uses to write relevant messages.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <Label className="text-xs">Value Proposition *</Label>
                <Textarea
                  value={form.value_prop ?? ''}
                  onChange={(e) => update('value_prop', e.target.value)}
                  placeholder="We're an AI-native recruitment agency placing senior engineers via a 5% success-fee model."
                  rows={3}
                />
                <p className="text-xs text-muted-foreground mt-1">Used in every generated message. Required.</p>
              </div>
              <div>
                <Label className="text-xs">Target ICP</Label>
                <Textarea
                  value={form.target_icp ?? ''}
                  onChange={(e) => update('target_icp', e.target.value)}
                  placeholder="EU fintech, AI, and Web3 companies hiring senior engineers, typically Series A-C."
                  rows={2}
                />
                <p className="text-xs text-muted-foreground mt-1">Helps the AI write relevant pitches.</p>
              </div>
              <div>
                <Label className="text-xs">Differentiator</Label>
                <Textarea
                  value={form.differentiator ?? ''}
                  onChange={(e) => update('differentiator', e.target.value)}
                  placeholder="5% success-fee (vs 20-25% traditional agencies), no upfront cost, AI-powered candidate matching."
                  rows={2}
                />
                <p className="text-xs text-muted-foreground mt-1">What makes you different from competitors.</p>
              </div>
              <div>
                <Label className="text-xs">Pricing Summary</Label>
                <Input
                  value={form.pricing_summary ?? ''}
                  onChange={(e) => update('pricing_summary', e.target.value)}
                  placeholder="5% of first-year salary, success-fee only."
                />
              </div>
              <div>
                <Label className="text-xs">Brand Voice Notes (optional)</Label>
                <Textarea
                  value={form.brand_voice_notes ?? ''}
                  onChange={(e) => update('brand_voice_notes', e.target.value)}
                  placeholder="Founder-to-founder voice. Direct. No corporate speak. No 'leverage' or 'streamline'."
                  rows={2}
                />
              </div>
            </CardContent>
          </Card>

          {savedPreview && (
            <div className="rounded-lg border border-emerald-700/50 bg-emerald-950/30 p-3 text-sm text-emerald-200 flex items-start gap-2">
              <Sparkles className="w-4 h-4 mt-0.5 shrink-0" />
              <span>{savedPreview}</span>
            </div>
          )}

          <div className="flex justify-end gap-2">
            <Button onClick={handleSave} disabled={save.isPending}>
              {save.isPending ? <Skeleton className="h-4 w-4 mr-2 rounded-full" /> : <Save className="w-4 h-4 mr-2" />}
              Save Configuration
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
