'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useCreateAgent, useStartAgent } from '@/hooks/use-agents';
import { useAnalyzePipeline } from '@/hooks/use-pipeline';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useToast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';
import {
  Search, FileText, Mail, Star, MessageSquare, Zap, ArrowLeft,
  CheckCircle, AlertTriangle, Info, Loader2, ChevronDown, ChevronUp,
} from 'lucide-react';
import type { PipelineFormData, PipelineProposal } from '@/types/pipeline';

const AGENT_ICONS: Record<string, React.ElementType> = {
  discovery: Search,
  document: FileText,
  enrichment: Zap,
  scoring: Star,
  outreach: Mail,
  reply: MessageSquare,
  action: CheckCircle,
};

const AGENT_COLORS: Record<string, string> = {
  discovery: 'bg-blue-500/20 text-blue-400 border-blue-500/30',
  document: 'bg-purple-500/20 text-purple-400 border-purple-500/30',
  enrichment: 'bg-green-500/20 text-green-400 border-green-500/30',
  scoring: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30',
  outreach: 'bg-pink-500/20 text-pink-400 border-pink-500/30',
  reply: 'bg-cyan-500/20 text-cyan-400 border-cyan-500/30',
  action: 'bg-orange-500/20 text-orange-400 border-orange-500/30',
};

type ViewState = 'form' | 'analyzing' | 'review';

export function PipelineBuilder() {
  const router = useRouter();
  const createAgent = useCreateAgent();
  const startAgent = useStartAgent();
  const analyzePipeline = useAnalyzePipeline();
  const { toast } = useToast();

  const [view, setView] = useState<ViewState>('form');
  const [launching, setLaunching] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [proposal, setProposal] = useState<PipelineProposal | null>(null);
  const [formData, setFormData] = useState<PipelineFormData>({
    useCase: 'recruitment',
    targetRole: '',
    requiredSkills: '',
    experienceLevel: '',
    locations: '',
    targetIndustry: '',
    companySize: '',
    additionalContext: '',
    scoringThreshold: 70,
    emailTone: 'professional',
    enableOutreach: true,
  });

  function updateForm<K extends keyof PipelineFormData>(key: K, value: PipelineFormData[K]) {
    setFormData((prev) => ({ ...prev, [key]: value }));
  }

  async function handleAnalyze() {
    setView('analyzing');
    try {
      const result = await analyzePipeline.mutateAsync(formData);
      setProposal(result);
      setView('review');
    } catch {
      toast({ title: 'Failed to analyze pipeline', variant: 'destructive' });
      setView('form');
    }
  }

  async function handleApprove() {
    if (!proposal) return;
    setLaunching(true);

    try {
      const missionParts: string[] = [];
      if (formData.useCase === 'recruitment') {
        if (formData.targetRole) missionParts.push(`Hiring: ${formData.targetRole}`);
        if (formData.requiredSkills) missionParts.push(`Skills: ${formData.requiredSkills}`);
        if (formData.experienceLevel) missionParts.push(`Experience: ${formData.experienceLevel}`);
        if (formData.locations) missionParts.push(`Locations: ${formData.locations}`);
      } else if (formData.useCase === 'sales') {
        if (formData.targetIndustry) missionParts.push(`Industry: ${formData.targetIndustry}`);
        if (formData.companySize) missionParts.push(`Company size: ${formData.companySize}`);
      }
      if (formData.additionalContext) missionParts.push(formData.additionalContext);

      const mission = missionParts.join('. ') || 'Custom pipeline';
      const name = mission.split(/\s+/).slice(0, 5).join(' ');

      const res = await createAgent.mutateAsync({
        name,
        mission,
        useCase: formData.useCase,
        config: {
          scoringThreshold: formData.scoringThreshold,
          emailTone: formData.emailTone,
          enableOutreach: formData.enableOutreach,
          pipeline: proposal.pipeline,
        },
      });

      await startAgent.mutateAsync(res.id);
      toast({ title: 'Pipeline launched!', description: proposal.summary });
      router.push(`/agents/${res.id}`);
    } catch {
      toast({ title: 'Failed to launch pipeline', variant: 'destructive' });
      setLaunching(false);
    }
  }

  // --- Form View ---
  if (view === 'form') {
    return (
      <Card>
        <CardContent className="p-6 space-y-5">
          <div>
            <h2 className="text-lg font-semibold">AI Pipeline Builder</h2>
            <p className="text-sm text-muted-foreground mt-1">
              Describe your needs and AI will design the optimal agent pipeline.
            </p>
          </div>

          {/* Use Case Selector */}
          <div className="space-y-2">
            <Label>Use case</Label>
            <div className="flex gap-2">
              {(['recruitment', 'sales', 'custom'] as const).map((uc) => (
                <Button
                  key={uc}
                  variant={formData.useCase === uc ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => updateForm('useCase', uc)}
                  className="capitalize"
                >
                  {uc}
                </Button>
              ))}
            </div>
          </div>

          {/* Recruitment Fields */}
          {formData.useCase === 'recruitment' && (
            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="targetRole">Target role</Label>
                <Input
                  id="targetRole"
                  placeholder="e.g. Senior Full-Stack Developer"
                  value={formData.targetRole}
                  onChange={(e) => updateForm('targetRole', e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="requiredSkills">Required skills (comma-separated)</Label>
                <Input
                  id="requiredSkills"
                  placeholder="e.g. React, Node.js, TypeScript, PostgreSQL"
                  value={formData.requiredSkills}
                  onChange={(e) => updateForm('requiredSkills', e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="experienceLevel">Experience level</Label>
                <Input
                  id="experienceLevel"
                  placeholder="e.g. 3+ years, Senior, Junior"
                  value={formData.experienceLevel}
                  onChange={(e) => updateForm('experienceLevel', e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="locations">Locations (comma-separated)</Label>
                <Input
                  id="locations"
                  placeholder="e.g. San Francisco, Remote, Europe"
                  value={formData.locations}
                  onChange={(e) => updateForm('locations', e.target.value)}
                />
              </div>
            </div>
          )}

          {/* Sales Fields */}
          {formData.useCase === 'sales' && (
            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="targetIndustry">Target industry</Label>
                <Input
                  id="targetIndustry"
                  placeholder="e.g. SaaS, FinTech, Healthcare"
                  value={formData.targetIndustry}
                  onChange={(e) => updateForm('targetIndustry', e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="companySize">Company size</Label>
                <Input
                  id="companySize"
                  placeholder="e.g. 50-200 employees, Series A, Enterprise"
                  value={formData.companySize}
                  onChange={(e) => updateForm('companySize', e.target.value)}
                />
              </div>
            </div>
          )}

          {/* Shared: Additional Context */}
          <div className="space-y-2">
            <Label htmlFor="additionalContext">Additional context</Label>
            <textarea
              id="additionalContext"
              rows={3}
              placeholder="Any extra details about what you're looking for..."
              value={formData.additionalContext}
              onChange={(e) => updateForm('additionalContext', e.target.value)}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 resize-none"
            />
          </div>

          {/* Advanced Settings */}
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
                <Label htmlFor="threshold">Minimum score threshold: {formData.scoringThreshold}</Label>
                <input
                  id="threshold"
                  type="range"
                  min={0}
                  max={100}
                  step={5}
                  value={formData.scoringThreshold}
                  onChange={(e) => updateForm('scoringThreshold', parseInt(e.target.value))}
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
                      variant={formData.emailTone === tone ? 'default' : 'outline'}
                      size="sm"
                      onClick={() => updateForm('emailTone', tone)}
                      className="capitalize"
                    >
                      {tone}
                    </Button>
                  ))}
                </div>
              </div>
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  role="switch"
                  aria-checked={formData.enableOutreach}
                  onClick={() => updateForm('enableOutreach', !formData.enableOutreach)}
                  className={cn(
                    'relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors',
                    formData.enableOutreach ? 'bg-primary' : 'bg-muted',
                  )}
                >
                  <span
                    className={cn(
                      'pointer-events-none block h-4 w-4 rounded-full bg-background shadow-lg ring-0 transition-transform',
                      formData.enableOutreach ? 'translate-x-4' : 'translate-x-0',
                    )}
                  />
                </button>
                <Label className="cursor-pointer" onClick={() => updateForm('enableOutreach', !formData.enableOutreach)}>
                  Enable email outreach
                </Label>
              </div>
            </div>
          )}

          <div className="flex justify-end pt-2">
            <Button onClick={handleAnalyze} disabled={analyzePipeline.isPending} className="gap-2">
              <Zap className="w-4 h-4" />
              Analyze &amp; Build Pipeline
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  // --- Analyzing View ---
  if (view === 'analyzing') {
    return (
      <Card>
        <CardContent className="p-12 flex flex-col items-center justify-center gap-4">
          <Loader2 className="w-10 h-10 animate-spin text-primary" />
          <p className="text-lg font-medium">AI is designing the optimal pipeline...</p>
          <p className="text-sm text-muted-foreground">Analyzing your requirements against available agent capabilities</p>
        </CardContent>
      </Card>
    );
  }

  // --- Review View ---
  if (view === 'review' && proposal) {
    return (
      <Card>
        <CardContent className="p-6 space-y-5">
          <div>
            <h2 className="text-lg font-semibold">Pipeline Preview</h2>
            <p className="text-sm text-muted-foreground mt-1">{proposal.summary}</p>
          </div>

          {/* Pipeline Steps */}
          <div className="space-y-3">
            {proposal.pipeline.map((step, i) => {
              const Icon = AGENT_ICONS[step.agentType] || Zap;
              const color = AGENT_COLORS[step.agentType] || 'bg-gray-500/20 text-gray-400 border-gray-500/30';
              return (
                <div key={i} className="flex items-start gap-3">
                  <div className="flex flex-col items-center">
                    <div className={cn('w-9 h-9 rounded-lg border flex items-center justify-center', color)}>
                      <Icon className="w-4 h-4" />
                    </div>
                    {i < proposal.pipeline.length - 1 && (
                      <div className="w-px h-6 bg-border mt-1" />
                    )}
                  </div>
                  <div className="pt-1">
                    <p className="text-sm font-medium capitalize">
                      Step {step.order}: {step.agentType} Agent
                    </p>
                    <p className="text-xs text-muted-foreground mt-0.5">{step.description}</p>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Missing Capabilities Warning */}
          {proposal.missingCapabilities.length > 0 && (
            <div className="p-4 rounded-lg bg-yellow-500/10 border border-yellow-500/20 flex gap-3">
              <AlertTriangle className="w-5 h-5 text-yellow-400 shrink-0 mt-0.5" />
              <div>
                <p className="text-sm font-medium text-yellow-300">Missing Capabilities</p>
                <ul className="text-xs text-yellow-200/80 mt-1 list-disc list-inside space-y-0.5">
                  {proposal.missingCapabilities.map((cap, i) => (
                    <li key={i}>{cap}</li>
                  ))}
                </ul>
              </div>
            </div>
          )}

          {/* Warnings */}
          {proposal.warnings.length > 0 && (
            <div className="p-4 rounded-lg bg-orange-500/10 border border-orange-500/20 flex gap-3">
              <AlertTriangle className="w-5 h-5 text-orange-400 shrink-0 mt-0.5" />
              <div>
                <p className="text-sm font-medium text-orange-300">Warnings</p>
                <ul className="text-xs text-orange-200/80 mt-1 list-disc list-inside space-y-0.5">
                  {proposal.warnings.map((warn, i) => (
                    <li key={i}>{warn}</li>
                  ))}
                </ul>
              </div>
            </div>
          )}

          {/* Estimated Duration */}
          <div className="p-4 rounded-lg bg-blue-500/10 border border-blue-500/20 flex gap-3">
            <Info className="w-5 h-5 text-blue-400 shrink-0 mt-0.5" />
            <div>
              <p className="text-sm text-blue-300">
                Estimated duration: <span className="font-medium">{proposal.estimatedDuration}</span>
              </p>
            </div>
          </div>

          {/* Actions */}
          <div className="flex justify-between pt-2">
            <Button variant="outline" onClick={() => setView('form')} className="gap-2">
              <ArrowLeft className="w-4 h-4" />
              Back to Edit
            </Button>
            <Button onClick={handleApprove} disabled={launching} className="gap-2">
              <CheckCircle className="w-4 h-4" />
              {launching ? 'Launching...' : 'Approve & Launch'}
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  return null;
}
