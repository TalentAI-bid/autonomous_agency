'use client';

import { useEffect, useMemo, useState } from 'react';
import { useActionPlan, useUpdateActionPlan, useStartAgent } from '@/hooks/use-agents';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { CheckCircle2, ClipboardList, AlertCircle } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';

interface Props {
  masterAgentId: string;
}

export function ActionPlanPanel({ masterAgentId }: Props) {
  const { data, isLoading } = useActionPlan(masterAgentId);
  const update = useUpdateActionPlan(masterAgentId);
  const startAgent = useStartAgent();
  const { toast } = useToast();

  const [answers, setAnswers] = useState<Record<string, string>>({});

  // Seed local state from server answers when the plan loads
  useEffect(() => {
    if (data?.actionPlan?.items) {
      const seed: Record<string, string> = {};
      for (const item of data.actionPlan.items) {
        if (item.answer) seed[item.key] = item.answer;
      }
      setAnswers(seed);
    }
  }, [data?.actionPlan?.generatedAt]);

  const items = data?.actionPlan?.items ?? [];
  const status = data?.actionPlan?.status;

  const completion = useMemo(() => {
    const required = items.filter((i) => i.required);
    if (required.length === 0) return { done: 0, total: 0, percent: 100 };
    const done = required.filter((i) => (answers[i.key] ?? i.answer ?? '').trim()).length;
    return { done, total: required.length, percent: Math.round((done / required.length) * 100) };
  }, [items, answers]);

  if (isLoading) {
    return <Skeleton className="h-64" />;
  }
  if (!data?.actionPlan) {
    return (
      <Card>
        <CardContent className="py-8 text-center space-y-2">
          <ClipboardList className="w-8 h-8 mx-auto text-muted-foreground" />
          <p className="text-sm text-muted-foreground">
            No action plan yet. Start the agent once to generate it.
          </p>
        </CardContent>
      </Card>
    );
  }

  async function handleSave(opts: { skip?: boolean } = {}) {
    try {
      const res = await update.mutateAsync({ answers, skip: opts.skip });
      toast({
        title: opts.skip ? 'Action plan skipped' : 'Action plan saved',
        description: res.status === 'idle'
          ? 'Click Run to (re)start the agent with the new answers.'
          : 'Some required answers are still missing.',
      });
    } catch (err) {
      toast({
        title: 'Failed to save action plan',
        description: err instanceof Error ? err.message : String(err),
        variant: 'destructive',
      });
    }
  }

  async function handleSaveAndRun() {
    try {
      const res = await update.mutateAsync({ answers });
      if (res.status === 'idle') {
        await startAgent.mutateAsync(masterAgentId);
        toast({ title: 'Saved and started', description: 'Agent is now running.' });
      } else {
        toast({
          title: 'Cannot start yet',
          description: 'Fill in all required answers first.',
          variant: 'destructive',
        });
      }
    } catch (err) {
      toast({
        title: 'Failed to save & run',
        description: err instanceof Error ? err.message : String(err),
        variant: 'destructive',
      });
    }
  }

  const isComplete = status === 'completed' || status === 'skipped';

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <ClipboardList className="w-4 h-4" />
              Action Plan
              {isComplete ? (
                <Badge variant="success" className="text-xs">{status === 'skipped' ? 'Skipped' : 'Completed'}</Badge>
              ) : (
                <Badge variant="outline" className="text-xs">{completion.done} / {completion.total} required</Badge>
              )}
            </CardTitle>
            <p className="text-xs text-muted-foreground mt-1">
              The agent needs these answers before it writes any outreach.
              You can update them later — they fold into the agent strategy and email prompts.
            </p>
          </div>
          {!isComplete && (
            <div className="text-right shrink-0">
              <div className="text-xs text-muted-foreground">{completion.percent}%</div>
              <div className="w-24 h-1.5 mt-1 bg-muted rounded-full overflow-hidden">
                <div
                  className="h-full bg-primary rounded-full transition-all"
                  style={{ width: `${completion.percent}%` }}
                />
              </div>
            </div>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {items.map((item) => {
          const value = answers[item.key] ?? '';
          const filled = value.trim().length > 0;
          return (
            <div key={item.key} className="space-y-1.5">
              <div className="flex items-center gap-2">
                {filled ? (
                  <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500 shrink-0" />
                ) : item.required ? (
                  <AlertCircle className="w-3.5 h-3.5 text-amber-500 shrink-0" />
                ) : (
                  <span className="w-3.5 h-3.5 shrink-0" />
                )}
                <label className="text-sm font-medium" htmlFor={`ap-${item.key}`}>
                  {item.question}
                </label>
                {item.required && !filled && (
                  <Badge variant="outline" className="text-[10px] uppercase">required</Badge>
                )}
              </div>
              <Textarea
                id={`ap-${item.key}`}
                value={value}
                rows={2}
                onChange={(e) => setAnswers((prev) => ({ ...prev, [item.key]: e.target.value }))}
                placeholder={item.required ? 'Answer is required to start outreach.' : 'Optional'}
                className="text-sm"
              />
            </div>
          );
        })}

        <div className="flex flex-wrap gap-2 pt-2">
          <Button
            size="sm"
            onClick={handleSaveAndRun}
            disabled={update.isPending || startAgent.isPending || completion.done < completion.total}
          >
            Save & Run
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => handleSave()}
            disabled={update.isPending}
          >
            Save
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => handleSave({ skip: true })}
            disabled={update.isPending}
            title="Skip the plan and start sending outreach with whatever answers exist"
          >
            Skip plan
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
