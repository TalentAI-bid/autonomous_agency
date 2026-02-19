'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useCreateAgent, useStartAgent } from '@/hooks/use-agents';
import { apiUpload } from '@/lib/api';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { UploadZone } from '@/components/documents/upload-zone';
import { useToast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';
import { Check, Bot, FileText, Settings, Rocket, ChevronRight } from 'lucide-react';

const STEPS = [
  { id: 1, label: 'Mission', icon: Bot },
  { id: 2, label: 'Documents', icon: FileText },
  { id: 3, label: 'Configure', icon: Settings },
  { id: 4, label: 'Launch', icon: Rocket },
];

const USE_CASES = [
  { value: 'talent_acquisition', label: 'Talent Acquisition', desc: 'Find and recruit top candidates' },
  { value: 'lead_generation', label: 'Lead Generation', desc: 'Discover and qualify sales leads' },
  { value: 'market_research', label: 'Market Research', desc: 'Research companies and contacts' },
  { value: 'partnership', label: 'Partnership Outreach', desc: 'Find strategic partners' },
];

interface AgentForm {
  name: string;
  mission: string;
  useCase: string;
  description: string;
  scoringThreshold: number;
  emailTone: string;
}

export function CreateAgentWizard() {
  const router = useRouter();
  const createAgent = useCreateAgent();
  const startAgent = useStartAgent();
  const { toast } = useToast();

  const [step, setStep] = useState(1);
  const [agentId, setAgentId] = useState<string | null>(null);
  const [uploadedFiles, setUploadedFiles] = useState<File[]>([]);
  const [uploading, setUploading] = useState(false);
  const [launching, setLaunching] = useState(false);

  const [form, setForm] = useState<AgentForm>({
    name: '',
    mission: '',
    useCase: 'talent_acquisition',
    description: '',
    scoringThreshold: 70,
    emailTone: 'professional',
  });

  function update(field: keyof AgentForm, value: string | number) {
    setForm((f) => ({ ...f, [field]: value }));
  }

  async function handleCreateAgent() {
    if (!form.name || !form.mission) {
      toast({ title: 'Please fill in all required fields', variant: 'destructive' });
      return;
    }
    try {
      const res = await createAgent.mutateAsync({
        name: form.name,
        mission: form.mission,
        useCase: form.useCase,
        description: form.description,
        config: { scoringThreshold: form.scoringThreshold, emailTone: form.emailTone },
      });
      setAgentId(res.id);
      setStep(2);
    } catch {
      toast({ title: 'Failed to create agent', variant: 'destructive' });
    }
  }

  async function handleUploadDocuments() {
    if (!agentId) return;
    if (uploadedFiles.length === 0) {
      setStep(3);
      return;
    }
    setUploading(true);
    try {
      for (const file of uploadedFiles) {
        const formData = new FormData();
        formData.append('file', file);
        formData.append('masterAgentId', agentId);
        formData.append('type', 'job_spec');
        await apiUpload('/documents', formData);
      }
      toast({ title: `${uploadedFiles.length} document${uploadedFiles.length > 1 ? 's' : ''} uploaded` });
      setStep(3);
    } catch {
      toast({ title: 'Some documents failed to upload', variant: 'destructive' });
    } finally {
      setUploading(false);
    }
  }

  async function handleLaunch() {
    if (!agentId) return;
    setLaunching(true);
    try {
      await startAgent.mutateAsync(agentId);
      toast({ title: 'Agent launched!', description: 'Your agent is now processing the mission.' });
      router.push(`/agents/${agentId}`);
    } catch {
      toast({ title: 'Failed to launch agent', variant: 'destructive' });
      setLaunching(false);
    }
  }

  return (
    <div className="space-y-6">
      {/* Step indicator */}
      <div className="flex items-center">
        {STEPS.map((s, i) => {
          const Icon = s.icon;
          const isCompleted = step > s.id;
          const isCurrent = step === s.id;
          return (
            <div key={s.id} className="flex items-center flex-1">
              <div className={cn(
                'flex items-center gap-2 text-sm font-medium transition-colors',
                isCompleted ? 'text-primary' : isCurrent ? 'text-foreground' : 'text-muted-foreground',
              )}>
                <div className={cn(
                  'flex items-center justify-center w-8 h-8 rounded-full border-2 transition-colors',
                  isCompleted ? 'bg-primary border-primary text-primary-foreground' : isCurrent ? 'border-primary text-primary' : 'border-muted-foreground/30',
                )}>
                  {isCompleted ? <Check className="w-4 h-4" /> : <Icon className="w-4 h-4" />}
                </div>
                <span className="hidden sm:block">{s.label}</span>
              </div>
              {i < STEPS.length - 1 && (
                <div className={cn('flex-1 h-0.5 mx-3', step > s.id ? 'bg-primary' : 'bg-muted')} />
              )}
            </div>
          );
        })}
      </div>

      {/* Step 1: Mission */}
      {step === 1 && (
        <Card>
          <CardContent className="p-6 space-y-5">
            <div>
              <h2 className="text-lg font-semibold">Define your mission</h2>
              <p className="text-sm text-muted-foreground mt-1">Tell the AI what you want to achieve</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="name">Agent name <span className="text-destructive">*</span></Label>
              <Input id="name" placeholder="e.g. Senior React Engineer Search" value={form.name} onChange={(e) => update('name', e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="mission">Mission <span className="text-destructive">*</span></Label>
              <textarea
                id="mission"
                rows={4}
                placeholder="e.g. Find senior React engineers with 5+ years of experience in fintech companies in London or remote. Focus on candidates with TypeScript and AWS experience."
                value={form.mission}
                onChange={(e) => update('mission', e.target.value)}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 resize-none"
              />
              <p className="text-xs text-muted-foreground">Be specific about role, experience level, location, and key skills.</p>
            </div>
            <div className="space-y-2">
              <Label>Use case</Label>
              <div className="grid grid-cols-2 gap-2">
                {USE_CASES.map((uc) => (
                  <button
                    key={uc.value}
                    type="button"
                    onClick={() => update('useCase', uc.value)}
                    className={cn(
                      'text-left p-3 rounded-lg border-2 transition-colors',
                      form.useCase === uc.value ? 'border-primary bg-primary/5' : 'border-border hover:border-border/80',
                    )}
                  >
                    <p className="text-sm font-medium">{uc.label}</p>
                    <p className="text-xs text-muted-foreground mt-0.5">{uc.desc}</p>
                  </button>
                ))}
              </div>
            </div>
            <div className="flex justify-end pt-2">
              <Button onClick={handleCreateAgent} disabled={createAgent.isPending}>
                {createAgent.isPending ? 'Creating...' : 'Continue'}
                <ChevronRight className="w-4 h-4 ml-1" />
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Step 2: Documents */}
      {step === 2 && (
        <Card>
          <CardContent className="p-6 space-y-5">
            <div>
              <h2 className="text-lg font-semibold">Upload documents</h2>
              <p className="text-sm text-muted-foreground mt-1">Add job specs, CVs, or company profiles to train the agent (optional)</p>
            </div>
            <UploadZone
              onFilesAdded={(files) => setUploadedFiles((prev) => [...prev, ...files])}
              accept={{ 'application/pdf': ['.pdf'], 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx'] }}
            />
            {uploadedFiles.length > 0 && (
              <div className="space-y-2">
                <p className="text-sm font-medium">Files to upload ({uploadedFiles.length})</p>
                {uploadedFiles.map((f, i) => (
                  <div key={i} className="flex items-center justify-between p-2 rounded-lg bg-muted/50 text-sm">
                    <span className="truncate">{f.name}</span>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 px-2 text-xs text-destructive"
                      onClick={() => setUploadedFiles((prev) => prev.filter((_, j) => j !== i))}
                    >
                      Remove
                    </Button>
                  </div>
                ))}
              </div>
            )}
            <div className="flex justify-between pt-2">
              <Button variant="ghost" onClick={() => setStep(1)}>Back</Button>
              <Button onClick={handleUploadDocuments} disabled={uploading}>
                {uploading ? 'Uploading...' : uploadedFiles.length === 0 ? 'Skip' : 'Upload & Continue'}
                <ChevronRight className="w-4 h-4 ml-1" />
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Step 3: Configure */}
      {step === 3 && (
        <Card>
          <CardContent className="p-6 space-y-5">
            <div>
              <h2 className="text-lg font-semibold">Configuration</h2>
              <p className="text-sm text-muted-foreground mt-1">Fine-tune the agent's behavior</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="threshold">Minimum score threshold: {form.scoringThreshold}</Label>
              <input
                id="threshold"
                type="range"
                min={0}
                max={100}
                step={5}
                value={form.scoringThreshold}
                onChange={(e) => update('scoringThreshold', parseInt(e.target.value))}
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
                    variant={form.emailTone === tone ? 'default' : 'outline'}
                    size="sm"
                    onClick={() => update('emailTone', tone)}
                    className="capitalize"
                  >
                    {tone}
                  </Button>
                ))}
              </div>
            </div>
            <div className="p-4 rounded-lg bg-muted/50 space-y-2">
              <p className="text-sm font-medium">Configuration summary</p>
              <ul className="text-sm text-muted-foreground space-y-1">
                <li>Agent: <span className="text-foreground">{form.name}</span></li>
                <li>Use case: <span className="text-foreground capitalize">{form.useCase.replace('_', ' ')}</span></li>
                <li>Score threshold: <span className="text-foreground">{form.scoringThreshold}+</span></li>
                <li>Email tone: <span className="text-foreground capitalize">{form.emailTone}</span></li>
              </ul>
            </div>
            <div className="flex justify-between pt-2">
              <Button variant="ghost" onClick={() => setStep(2)}>Back</Button>
              <Button onClick={() => setStep(4)}>
                Review & Launch
                <ChevronRight className="w-4 h-4 ml-1" />
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Step 4: Launch */}
      {step === 4 && (
        <Card>
          <CardContent className="p-6 space-y-5">
            <div>
              <h2 className="text-lg font-semibold">Ready to launch</h2>
              <p className="text-sm text-muted-foreground mt-1">Review your agent configuration before launching</p>
            </div>
            <div className="p-5 rounded-lg border bg-muted/30 space-y-3">
              <div className="flex items-center gap-3">
                <div className="p-2.5 rounded-lg bg-blue-500/10">
                  <Bot className="w-5 h-5 text-blue-400" />
                </div>
                <div>
                  <p className="font-semibold">{form.name}</p>
                  <p className="text-sm text-muted-foreground capitalize">{form.useCase.replace('_', ' ')}</p>
                </div>
              </div>
              <div className="border-t border-border pt-3">
                <p className="text-sm font-medium mb-2">Mission</p>
                <p className="text-sm text-muted-foreground">{form.mission}</p>
              </div>
              {uploadedFiles.length > 0 && (
                <div className="border-t border-border pt-3">
                  <p className="text-sm font-medium mb-1">Documents ({uploadedFiles.length})</p>
                  {uploadedFiles.map((f, i) => (
                    <p key={i} className="text-xs text-muted-foreground">{f.name}</p>
                  ))}
                </div>
              )}
              <div className="border-t border-border pt-3 grid grid-cols-2 gap-2 text-sm">
                <div><span className="text-muted-foreground">Score threshold:</span> {form.scoringThreshold}+</div>
                <div><span className="text-muted-foreground">Email tone:</span> {form.emailTone}</div>
              </div>
            </div>
            <div className="p-4 rounded-lg bg-blue-500/10 border border-blue-500/20">
              <p className="text-sm text-blue-300">
                The agent will run the full pipeline: discovery → enrichment → scoring → outreach. This may take several hours depending on search volume.
              </p>
            </div>
            <div className="flex justify-between pt-2">
              <Button variant="ghost" onClick={() => setStep(3)}>Back</Button>
              <Button onClick={handleLaunch} disabled={launching} className="gap-2">
                <Rocket className="w-4 h-4" />
                {launching ? 'Launching...' : 'Launch Agent'}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
