'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useCreateAgent, useStartAgent } from '@/hooks/use-agents';
import { useEmailAccounts } from '@/hooks/use-email-settings';
import { useProducts } from '@/hooks/use-products';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { useToast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';
import { Rocket, ChevronDown, ChevronUp } from 'lucide-react';

export function CreateAgentWizard() {
  const router = useRouter();
  const createAgent = useCreateAgent();
  const startAgent = useStartAgent();
  const { toast } = useToast();

  const [mission, setMission] = useState('');
  const [location, setLocation] = useState('');
  const [requiredSkills, setRequiredSkills] = useState('');
  const [launching, setLaunching] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [scoringThreshold, setScoringThreshold] = useState(70);
  const [emailTone, setEmailTone] = useState('professional');
  const [emailAccountId, setEmailAccountId] = useState('');
  const [selectedProductIds, setSelectedProductIds] = useState<string[]>([]);
  const { data: emailAccountsList } = useEmailAccounts();
  const activeEmailAccounts = emailAccountsList?.filter((a) => a.isActive) ?? [];
  const { data: productsList } = useProducts();
  const activeProducts = (productsList ?? []).filter((p) => p.isActive);

  function toggleProduct(id: string, checked: boolean) {
    setSelectedProductIds((prev) =>
      checked ? [...prev, id] : prev.filter((pid) => pid !== id),
    );
  }

  function generateName(text: string): string {
    const words = text.trim().split(/\s+/).slice(0, 5).join(' ');
    return words || 'New Agent';
  }

  async function handleLaunch() {
    if (!mission.trim()) {
      toast({ title: 'Please describe your hiring needs', variant: 'destructive' });
      return;
    }

    setLaunching(true);
    try {
      const name = generateName(mission);
      const locations = location.trim()
        ? location.split(',').map((l) => l.trim()).filter(Boolean)
        : [];
      const skills = requiredSkills.trim()
        ? requiredSkills.split(',').map((s) => s.trim()).filter(Boolean)
        : [];

      const res = await createAgent.mutateAsync({
        name,
        mission: mission.trim(),
        useCase: 'recruitment',
        config: {
          scoringThreshold,
          emailTone,
          ...(locations.length > 0 && { locations }),
          ...(skills.length > 0 && { requiredSkills: skills }),
          ...(emailAccountId && { emailAccountId }),
          ...(selectedProductIds.length > 0 && { productIds: selectedProductIds }),
        },
      });

      await startAgent.mutateAsync(res.id);
      toast({ title: 'Agent launched!', description: 'Your agent is now finding candidates.' });
      router.push(`/agents/${res.id}`);
    } catch {
      toast({ title: 'Failed to launch agent', variant: 'destructive' });
      setLaunching(false);
    }
  }

  return (
    <Card>
      <CardContent className="p-6 space-y-5">
        <div>
          <h2 className="text-lg font-semibold">What are you hiring for?</h2>
          <p className="text-sm text-muted-foreground mt-1">
            Describe what your company needs — the agent will find matching candidates automatically.
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label htmlFor="location">Location</Label>
            <input
              id="location"
              type="text"
              placeholder="e.g. France, Remote, New York"
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="skills">Required Skills</Label>
            <input
              id="skills"
              type="text"
              placeholder="e.g. React, Node.js, TypeScript"
              value={requiredSkills}
              onChange={(e) => setRequiredSkills(e.target.value)}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            />
          </div>
        </div>

        <div className="space-y-2">
          <Label htmlFor="mission">Hiring needs</Label>
          <textarea
            id="mission"
            rows={4}
            placeholder="e.g. web3 dev fullstack react and express js with 3+ years experience"
            value={mission}
            onChange={(e) => setMission(e.target.value)}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 resize-none"
            autoFocus
          />
          <p className="text-xs text-muted-foreground">
            Include role, skills, experience level, and location preferences. The more specific, the better the matches.
          </p>
        </div>

        {/* Product Selection */}
        <div className="space-y-2">
          <Label>Products to promote</Label>
          <p className="text-xs text-muted-foreground">
            Select which products/services this agent should focus on in outreach
          </p>
          {activeProducts.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No products configured.{' '}
              <Link href="/settings/products" className="text-primary underline">
                Add products
              </Link>
            </p>
          ) : (
            <div className="space-y-2 mt-1">
              {activeProducts.map((product) => (
                <label key={product.id} className="flex items-start gap-2 cursor-pointer p-2 rounded-md hover:bg-muted/50 transition-colors">
                  <Checkbox
                    checked={selectedProductIds.includes(product.id)}
                    onCheckedChange={(checked) => toggleProduct(product.id, !!checked)}
                    className="mt-0.5"
                  />
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="text-sm font-medium">{product.name}</span>
                      {product.category && (
                        <Badge variant="secondary" className="text-xs">{product.category}</Badge>
                      )}
                    </div>
                    {product.description && (
                      <p className="text-xs text-muted-foreground mt-0.5 line-clamp-1">{product.description}</p>
                    )}
                  </div>
                </label>
              ))}
            </div>
          )}
        </div>

        {/* Advanced Settings (collapsible) */}
        <button
          type="button"
          onClick={() => setShowAdvanced(!showAdvanced)}
          className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          {showAdvanced ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
          Advanced settings
        </button>

        {showAdvanced && (
          <div className="space-y-4 pl-1">
            <div className="space-y-2">
              <Label htmlFor="threshold">Minimum score threshold: {scoringThreshold}</Label>
              <input
                id="threshold"
                type="range"
                min={0}
                max={100}
                step={5}
                value={scoringThreshold}
                onChange={(e) => setScoringThreshold(parseInt(e.target.value))}
                className="w-full accent-primary"
              />
              <div className="flex justify-between text-xs text-muted-foreground">
                <span>0 — Cast wide net</span>
                <span>100 — Very selective</span>
              </div>
            </div>
            <div className="space-y-2">
              <Label>Email tone</Label>
              <div className="flex gap-2 flex-wrap">
                {['professional', 'friendly', 'direct', 'casual'].map((tone) => (
                  <Button
                    key={tone}
                    variant={emailTone === tone ? 'default' : 'outline'}
                    size="sm"
                    onClick={() => setEmailTone(tone)}
                    className="capitalize"
                  >
                    {tone}
                  </Button>
                ))}
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="emailAccount">Sending email account</Label>
              {activeEmailAccounts.length > 0 ? (
                <select
                  id="emailAccount"
                  value={emailAccountId}
                  onChange={(e) => setEmailAccountId(e.target.value)}
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                >
                  <option value="">Auto-select (highest priority)</option>
                  {activeEmailAccounts.map((account) => (
                    <option key={account.id} value={account.id}>
                      {account.name} ({account.fromEmail})
                    </option>
                  ))}
                </select>
              ) : (
                <p className="text-xs text-muted-foreground">
                  No email accounts configured.{' '}
                  <a href="/settings/email" className="text-primary underline">
                    Settings &gt; Email
                  </a>
                </p>
              )}
            </div>
          </div>
        )}

        <div className="p-4 rounded-lg bg-blue-500/10 border border-blue-500/20">
          <p className="text-sm text-blue-300">
            The agent will run the full pipeline: parse requirements, discover candidates, enrich profiles, score fit, and send outreach emails.
          </p>
        </div>

        <div className="flex justify-end pt-2">
          <Button onClick={handleLaunch} disabled={launching || !mission.trim()} className="gap-2">
            <Rocket className="w-4 h-4" />
            {launching ? 'Launching...' : 'Launch Agent'}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
