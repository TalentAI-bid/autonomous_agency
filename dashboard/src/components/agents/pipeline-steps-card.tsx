'use client';

import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import {
  Linkedin, Globe, Brain, ShieldCheck, AtSign, Star, Workflow,
} from 'lucide-react';

const TOOL_ICONS: Record<string, React.ElementType> = {
  LINKEDIN_EXTENSION: Linkedin,
  CRAWL4AI: Globe,
  LLM_ANALYSIS: Brain,
  REACHER: ShieldCheck,
  EMAIL_PATTERN: AtSign,
  SCORING: Star,
};

const TOOL_COLORS: Record<string, string> = {
  LINKEDIN_EXTENSION: 'bg-blue-500/20 text-blue-400 border-blue-500/30',
  CRAWL4AI: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30',
  LLM_ANALYSIS: 'bg-purple-500/20 text-purple-400 border-purple-500/30',
  REACHER: 'bg-amber-500/20 text-amber-400 border-amber-500/30',
  EMAIL_PATTERN: 'bg-cyan-500/20 text-cyan-400 border-cyan-500/30',
  SCORING: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30',
};

const TOOL_LABELS: Record<string, string> = {
  LINKEDIN_EXTENSION: 'LinkedIn Extension',
  CRAWL4AI: 'Web Crawler',
  LLM_ANALYSIS: 'LLM Analysis',
  REACHER: 'Email Verifier',
  EMAIL_PATTERN: 'Email Pattern',
  SCORING: 'Scoring',
};

interface PipelineStep {
  id: string;
  tool: string;
  action: string;
  dependsOn: string[];
  params?: Record<string, unknown>;
}

interface PipelineStepsCardProps {
  steps: PipelineStep[];
  message?: string;
}

export function PipelineStepsCard({ steps, message }: PipelineStepsCardProps) {
  return (
    <Card className="border-primary/20 bg-background/50">
      <CardContent className="p-4 space-y-3">
        <div className="flex items-center gap-2">
          <div className="w-6 h-6 rounded-md bg-primary/10 flex items-center justify-center">
            <Workflow className="w-3.5 h-3.5 text-primary" />
          </div>
          <h4 className="text-xs font-semibold">Execution Pipeline</h4>
          <Badge variant="secondary" className="text-[10px] ml-auto">{steps.length} steps</Badge>
        </div>

        {message && (
          <p className="text-xs text-muted-foreground leading-relaxed">{message}</p>
        )}

        <div className="space-y-0">
          {steps.map((step, i) => {
            const Icon = TOOL_ICONS[step.tool] ?? Workflow;
            const color = TOOL_COLORS[step.tool] ?? 'bg-gray-500/20 text-gray-400 border-gray-500/30';
            const label = TOOL_LABELS[step.tool] ?? step.tool;

            return (
              <div key={step.id} className="flex items-start gap-2.5">
                <div className="flex flex-col items-center">
                  <div className={cn('w-7 h-7 rounded-md border flex items-center justify-center shrink-0', color)}>
                    <Icon className="w-3.5 h-3.5" />
                  </div>
                  {i < steps.length - 1 && (
                    <div className="w-px h-5 bg-border mt-0.5" />
                  )}
                </div>
                <div className="pt-0.5 min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <p className="text-xs font-medium">{label}</p>
                    {step.dependsOn.length > 0 && (
                      <span className="text-[9px] text-muted-foreground">
                        after {step.dependsOn.join(', ')}
                      </span>
                    )}
                  </div>
                  <p className="text-[11px] text-muted-foreground truncate">
                    {step.action.replace(/_/g, ' ')}
                  </p>
                </div>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
