'use client';

import * as React from 'react';
import { useCrmStages, useCreateStage, useUpdateStage, useDeleteStage, useFollowupCadence, useUpdateFollowupCadence } from '@/hooks/use-crm';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { useToast } from '@/hooks/use-toast';
import { ArrowLeft, Plus, Save, X, BellRing, BellOff } from 'lucide-react';
import { cn } from '@/lib/utils';
import { HomeSection, StatusPill } from '@/components/home/home-parts';
import Link from 'next/link';
import type { CrmStage, CadenceStrategy } from '@/types';

const CADENCE_LABELS: Record<CadenceStrategy, string> = {
  fast: 'Fast',
  mid: 'Mid',
  slow: 'Slow',
};

export default function CrmSettingsPage() {
  const { data: stages, isLoading } = useCrmStages();
  const createStage = useCreateStage();
  const updateStage = useUpdateStage();
  const deleteStage = useDeleteStage();
  const { data: cadence } = useFollowupCadence();
  const updateCadence = useUpdateFollowupCadence();
  const { toast } = useToast();

  async function handleCadenceChange(strategy: CadenceStrategy) {
    try {
      await updateCadence.mutateAsync({ strategy });
      toast({ title: `Follow-up cadence set to ${CADENCE_LABELS[strategy]}` });
    } catch {
      toast({ title: 'Failed to update cadence', variant: 'destructive' });
    }
  }

  async function handleToggleFollowUp(stage: CrmStage) {
    try {
      await updateStage.mutateAsync({ id: stage.id, followUpEligible: !stage.followUpEligible });
      toast({
        title: `Follow-ups ${stage.followUpEligible ? 'disabled' : 'enabled'} for "${stage.name}"`,
      });
    } catch {
      toast({ title: 'Failed to update stage', variant: 'destructive' });
    }
  }

  const [showAdd, setShowAdd] = React.useState(false);
  const [editingId, setEditingId] = React.useState<string | null>(null);

  // Add form state
  const [newName, setNewName] = React.useState('');
  const [newSlug, setNewSlug] = React.useState('');
  const [newColor, setNewColor] = React.useState('#6366f1');
  const [newPosition, setNewPosition] = React.useState(0);

  // Edit form state
  const [editName, setEditName] = React.useState('');
  const [editSlug, setEditSlug] = React.useState('');
  const [editColor, setEditColor] = React.useState('');
  const [editPosition, setEditPosition] = React.useState(0);

  function resetAddForm() {
    setNewName('');
    setNewSlug('');
    setNewColor('#6366f1');
    setNewPosition((stages?.length ?? 0) + 1);
    setShowAdd(false);
  }

  function startEdit(stage: CrmStage) {
    setEditingId(stage.id);
    setEditName(stage.name);
    setEditSlug(stage.slug);
    setEditColor(stage.color);
    setEditPosition(stage.position);
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!newName.trim()) return;
    try {
      await createStage.mutateAsync({
        name: newName.trim(),
        slug: newSlug.trim() || newName.trim().toLowerCase().replace(/\s+/g, '-'),
        color: newColor,
        position: newPosition,
      });
      toast({ title: 'Stage created' });
      resetAddForm();
    } catch {
      toast({ title: 'Failed to create stage', variant: 'destructive' });
    }
  }

  async function handleUpdate(id: string) {
    try {
      await updateStage.mutateAsync({
        id,
        name: editName.trim(),
        slug: editSlug.trim(),
        color: editColor,
        position: editPosition,
      });
      toast({ title: 'Stage updated' });
      setEditingId(null);
    } catch {
      toast({ title: 'Failed to update stage', variant: 'destructive' });
    }
  }

  async function handleDelete(stage: CrmStage) {
    if (!confirm(`Delete the "${stage.name}" stage? Deals in it may need to be moved first.`)) return;
    const id = stage.id;
    try {
      await deleteStage.mutateAsync(id);
      toast({ title: 'Stage deleted' });
    } catch {
      toast({ title: 'Failed to delete stage', variant: 'destructive' });
    }
  }

  const sorted = React.useMemo(
    () => [...(stages ?? [])].sort((a, b) => a.position - b.position),
    [stages],
  );

  const colorInput = 'h-9 w-11 shrink-0 cursor-pointer rounded-lg border border-line bg-bg-panel p-1';

  return (
    <div className="mx-auto flex max-w-[940px] flex-col gap-4 p-5">
      {/* Top bar */}
      <div className="flex items-center justify-between gap-3">
        <Link href="/crm" className="inline-flex items-center gap-1.5 text-body font-medium text-ink-2 no-underline hover:text-accent">
          <ArrowLeft size={14} /> Back to pipeline
        </Link>
        <Button
          type="button"
          variant="brand"
          size="dense"
          onClick={() => {
            setShowAdd(true);
            setNewPosition((stages?.length ?? 0) + 1);
          }}
          className="h-8 rounded-lg px-3.5 text-body font-semibold"
        >
          <Plus className="mr-1.5 size-4" /> Add stage
        </Button>
      </div>

      {/* Follow-up cadence */}
      <HomeSection title="Follow-up cadence" meta="Applies to follow-up-eligible stages">
        <div className="border-t border-line p-4">
          <p className="mb-3 mt-0 max-w-[640px] text-xs leading-relaxed text-ink-3">
            How long to wait between follow-up touches for leads sitting in a follow-up-eligible stage. Due follow-ups show up in your Approvals
            with a drafted message. Nothing is sent automatically.
          </p>
          <div className="grid gap-2 sm:grid-cols-3" role="radiogroup" aria-label="Follow-up cadence">
            {(['fast', 'mid', 'slow'] as CadenceStrategy[]).map((st) => {
              const days = cadence?.intervals?.[st] ?? [];
              const active = cadence?.strategy === st;
              return (
                <button
                  key={st}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => handleCadenceChange(st)}
                  disabled={updateCadence.isPending || active}
                  className={cn(
                    'rounded-xl border px-4 py-3 text-left transition-colors',
                    active ? 'border-accent-mid bg-accent-weak' : 'border-line bg-bg-panel hover:border-line-strong hover:bg-hover',
                  )}
                >
                  <div className="flex items-center justify-between">
                    <span className={cn('text-body font-semibold', active ? 'text-accent-fg' : 'text-ink')}>{CADENCE_LABELS[st]}</span>
                    {active && <span className="text-2xs font-medium text-accent-fg">Selected</span>}
                  </div>
                  <div className="mt-1 font-mono text-xs text-ink-3">{days.length > 0 ? `day ${days.join(', ')}` : '—'}</div>
                </button>
              );
            })}
          </div>
        </div>
      </HomeSection>

      {/* Add stage */}
      {showAdd && (
        <HomeSection title="New stage">
          <form onSubmit={handleCreate} className="flex flex-wrap items-end gap-3 border-t border-line p-4">
            <div className="min-w-[180px] flex-1 space-y-1.5">
              <Label>Name</Label>
              <Input placeholder="e.g. Negotiation" value={newName} onChange={(e) => setNewName(e.target.value)} required autoFocus />
            </div>
            <div className="min-w-[160px] flex-1 space-y-1.5">
              <Label>Slug</Label>
              <Input placeholder="auto-generated" value={newSlug} onChange={(e) => setNewSlug(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>Color</Label>
              <input type="color" value={newColor} onChange={(e) => setNewColor(e.target.value)} className={colorInput} />
            </div>
            <div className="w-20 space-y-1.5">
              <Label>Position</Label>
              <Input type="number" min={0} value={newPosition} onChange={(e) => setNewPosition(Number(e.target.value))} />
            </div>
            <div className="flex gap-2">
              <Button type="submit" variant="brand" size="sm" disabled={createStage.isPending}>
                {createStage.isPending ? 'Creating…' : 'Create stage'}
              </Button>
              <Button type="button" variant="outline" size="sm" onClick={resetAddForm}>
                Cancel
              </Button>
            </div>
          </form>
        </HomeSection>
      )}

      {/* Stages */}
      <HomeSection title="Stages" meta={`${sorted.length} ${sorted.length === 1 ? 'stage' : 'stages'} · in board order`}>
        {isLoading ? (
          <div className="space-y-2 border-t border-line p-4">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-11 w-full rounded-lg" />
            ))}
          </div>
        ) : sorted.length === 0 ? (
          <div className="border-t border-line px-4 py-8 text-center text-body text-ink-3">
            No stages yet. Add one, or create the defaults from the pipeline board.
          </div>
        ) : (
          sorted.map((stage) => {
            const terminal = stage.isWon || stage.isLost;
            const followOn = stage.followUpEligible && !terminal;
            return (
              <div key={stage.id} className="flex flex-wrap items-center gap-3 border-t border-line px-4 py-3">
                {editingId === stage.id ? (
                  <>
                    <input type="color" value={editColor} onChange={(e) => setEditColor(e.target.value)} className={colorInput} />
                    <Input className="w-40" value={editName} onChange={(e) => setEditName(e.target.value)} aria-label="Stage name" />
                    <Input className="w-36" value={editSlug} onChange={(e) => setEditSlug(e.target.value)} aria-label="Slug" />
                    <Input className="w-20" type="number" min={0} value={editPosition} onChange={(e) => setEditPosition(Number(e.target.value))} aria-label="Position" />
                    <div className="ml-auto flex items-center gap-1.5">
                      <Button type="button" variant="brand" size="dense" onClick={() => handleUpdate(stage.id)} disabled={updateStage.isPending} className="h-8 rounded-lg px-3 text-xs font-semibold">
                        <Save className="mr-1.5 size-3.5" /> Save
                      </Button>
                      <Button type="button" variant="panel" size="dense" onClick={() => setEditingId(null)} className="h-8 rounded-lg px-3 text-xs">
                        <X className="mr-1.5 size-3.5" /> Cancel
                      </Button>
                    </div>
                  </>
                ) : (
                  <>
                    <span className="size-3 shrink-0 rounded-full" style={{ backgroundColor: stage.color, boxShadow: `0 0 0 3px ${stage.color}22` }} />
                    <div className="min-w-0 flex-1 basis-40">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="text-body font-medium text-ink">{stage.name}</span>
                        {stage.isDefault && <StatusPill tone="muted">Default</StatusPill>}
                        {stage.isWon && <StatusPill tone="up">Won</StatusPill>}
                        {stage.isLost && <StatusPill tone="down">Lost</StatusPill>}
                      </div>
                      <div className="font-mono text-2xs text-ink-4">
                        {stage.slug} · #{stage.position}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => handleToggleFollowUp(stage)}
                      disabled={terminal || updateStage.isPending}
                      title={
                        terminal
                          ? 'Terminal stage — never follow up'
                          : stage.followUpEligible
                            ? 'Leads in this stage get follow-up reminders in Approvals. Click to disable.'
                            : 'No follow-up reminders for this stage. Click to enable.'
                      }
                      className={cn(
                        'inline-flex shrink-0 items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs font-medium transition-colors',
                        terminal
                          ? 'cursor-not-allowed border-line text-ink-4 opacity-50'
                          : followOn
                            ? 'border-up/30 bg-up/10 text-up'
                            : 'border-line bg-bg-panel text-ink-3 hover:border-line-strong hover:bg-hover',
                      )}
                    >
                      {followOn ? <BellRing className="size-3" /> : <BellOff className="size-3" />}
                      Follow-ups {followOn ? 'on' : 'off'}
                      {followOn && stage.followUpClassifiedBy && (
                        <span className="font-normal opacity-70">· {stage.followUpClassifiedBy === 'ai' ? 'AI' : 'manual'}</span>
                      )}
                    </button>
                    <div className="flex shrink-0 items-center gap-1">
                      <Button type="button" variant="panel" size="dense" onClick={() => startEdit(stage)} className="h-7 rounded-lg px-3 text-xs">
                        Edit
                      </Button>
                      <button
                        type="button"
                        onClick={() => handleDelete(stage)}
                        disabled={deleteStage.isPending}
                        className="h-7 rounded-lg px-2 text-xs font-medium text-ink-3 transition-colors hover:bg-hover hover:text-down disabled:opacity-50"
                      >
                        Delete
                      </button>
                    </div>
                  </>
                )}
              </div>
            );
          })
        )}
      </HomeSection>
    </div>
  );
}
