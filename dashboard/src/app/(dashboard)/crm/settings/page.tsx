'use client';

import * as React from 'react';
import { useCrmStages, useCreateStage, useUpdateStage, useDeleteStage, useFollowupCadence, useUpdateFollowupCadence } from '@/hooks/use-crm';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { useToast } from '@/hooks/use-toast';
import { ArrowLeft, Plus, Pencil, Trash2, Settings, Save, X, BellRing, BellOff, Timer } from 'lucide-react';
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

  async function handleDelete(id: string) {
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

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-4">
        <Link href="/crm">
          <Button variant="ghost" size="icon">
            <ArrowLeft className="w-4 h-4" />
          </Button>
        </Link>
        <div className="flex-1 min-w-0">
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Settings className="w-6 h-6" /> Pipeline Stages
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            Manage stages in your CRM pipeline
          </p>
        </div>
        <Button size="sm" onClick={() => { setShowAdd(true); setNewPosition((stages?.length ?? 0) + 1); }}>
          <Plus className="w-4 h-4 mr-2" /> Add Stage
        </Button>
      </div>

      {/* Follow-up cadence */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Timer className="w-4 h-4" /> Follow-up cadence
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground mb-3">
            How long to wait between follow-up touches for leads sitting in a
            follow-up-eligible stage. Due follow-ups show up in your Daily Queue
            with a drafted message — nothing is sent automatically.
          </p>
          <div className="flex flex-wrap gap-2">
            {(['fast', 'mid', 'slow'] as CadenceStrategy[]).map((s) => {
              const days = cadence?.intervals?.[s] ?? [];
              const active = cadence?.strategy === s;
              return (
                <Button
                  key={s}
                  size="sm"
                  variant={active ? 'default' : 'outline'}
                  onClick={() => handleCadenceChange(s)}
                  disabled={updateCadence.isPending || active}
                >
                  {CADENCE_LABELS[s]}
                  {days.length > 0 && (
                    <span className={`ml-1.5 text-xs ${active ? 'opacity-80' : 'text-muted-foreground'}`}>
                      day {days.join(', ')}
                    </span>
                  )}
                </Button>
              );
            })}
          </div>
        </CardContent>
      </Card>

      {/* Add Stage Form */}
      {showAdd && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">New Stage</CardTitle>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleCreate} className="flex flex-wrap items-end gap-3">
              <div className="space-y-1.5">
                <Label>Name</Label>
                <Input
                  placeholder="e.g. Negotiation"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  required
                />
              </div>
              <div className="space-y-1.5">
                <Label>Slug</Label>
                <Input
                  placeholder="auto-generated"
                  value={newSlug}
                  onChange={(e) => setNewSlug(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label>Color</Label>
                <input
                  type="color"
                  value={newColor}
                  onChange={(e) => setNewColor(e.target.value)}
                  className="h-9 w-14 cursor-pointer rounded border border-input"
                />
              </div>
              <div className="space-y-1.5 w-20">
                <Label>Position</Label>
                <Input
                  type="number"
                  min={0}
                  value={newPosition}
                  onChange={(e) => setNewPosition(Number(e.target.value))}
                />
              </div>
              <Button type="submit" size="sm" disabled={createStage.isPending}>
                {createStage.isPending ? 'Creating…' : 'Create'}
              </Button>
              <Button type="button" variant="ghost" size="sm" onClick={resetAddForm}>
                Cancel
              </Button>
            </form>
          </CardContent>
        </Card>
      )}

      {/* Stages List */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Stages ({sorted.length})</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-3">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : sorted.length === 0 ? (
            <p className="text-sm text-muted-foreground py-6 text-center">
              No stages yet. Add one or use &ldquo;Seed Stages&rdquo; from the board.
            </p>
          ) : (
            <div className="space-y-2">
              {sorted.map((stage) => (
                <div
                  key={stage.id}
                  className="flex items-center gap-3 rounded-lg border border-border p-3"
                >
                  {editingId === stage.id ? (
                    /* Inline edit mode */
                    <div className="flex flex-wrap items-center gap-3 flex-1">
                      <input
                        type="color"
                        value={editColor}
                        onChange={(e) => setEditColor(e.target.value)}
                        className="h-8 w-10 cursor-pointer rounded border border-input"
                      />
                      <Input
                        className="w-36"
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                      />
                      <Input
                        className="w-32"
                        value={editSlug}
                        onChange={(e) => setEditSlug(e.target.value)}
                      />
                      <Input
                        className="w-20"
                        type="number"
                        min={0}
                        value={editPosition}
                        onChange={(e) => setEditPosition(Number(e.target.value))}
                      />
                      <Button
                        size="icon"
                        variant="ghost"
                        onClick={() => handleUpdate(stage.id)}
                        disabled={updateStage.isPending}
                      >
                        <Save className="w-4 h-4" />
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        onClick={() => setEditingId(null)}
                      >
                        <X className="w-4 h-4" />
                      </Button>
                    </div>
                  ) : (
                    /* Read mode */
                    <>
                      <div
                        className="w-4 h-4 rounded-full shrink-0"
                        style={{ backgroundColor: stage.color }}
                      />
                      <span className="font-medium text-sm min-w-[120px]">{stage.name}</span>
                      <span className="text-xs text-muted-foreground min-w-[100px]">{stage.slug}</span>
                      <span className="text-xs text-muted-foreground w-12 text-center">#{stage.position}</span>
                      <div className="flex gap-1 flex-1 items-center">
                        {stage.isDefault && <Badge variant="secondary" className="text-xs">Default</Badge>}
                        {stage.isWon && <Badge className="text-xs bg-green-600">Won</Badge>}
                        {stage.isLost && <Badge variant="destructive" className="text-xs">Lost</Badge>}
                      </div>
                      <button
                        type="button"
                        onClick={() => handleToggleFollowUp(stage)}
                        disabled={stage.isWon || stage.isLost || updateStage.isPending}
                        title={
                          stage.isWon || stage.isLost
                            ? 'Terminal stage — never follow up'
                            : stage.followUpEligible
                              ? 'Leads in this stage get follow-up reminders in the Daily Queue. Click to disable.'
                              : 'No follow-up reminders for this stage. Click to enable.'
                        }
                        className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs shrink-0 transition-colors ${
                          stage.isWon || stage.isLost
                            ? 'opacity-40 cursor-not-allowed border-border text-muted-foreground'
                            : stage.followUpEligible
                              ? 'border-emerald-500/50 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                              : 'border-border text-muted-foreground hover:bg-accent'
                        }`}
                      >
                        {stage.followUpEligible && !stage.isWon && !stage.isLost
                          ? <BellRing className="w-3 h-3" />
                          : <BellOff className="w-3 h-3" />}
                        Follow-ups {stage.followUpEligible && !stage.isWon && !stage.isLost ? 'on' : 'off'}
                        {stage.followUpClassifiedBy && !stage.isWon && !stage.isLost && (
                          <span className="opacity-60">· {stage.followUpClassifiedBy === 'ai' ? 'AI' : 'manual'}</span>
                        )}
                      </button>
                      <div className="flex gap-1 shrink-0">
                        <Button size="icon" variant="ghost" onClick={() => startEdit(stage)}>
                          <Pencil className="w-3.5 h-3.5" />
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          onClick={() => handleDelete(stage.id)}
                          disabled={deleteStage.isPending}
                        >
                          <Trash2 className="w-3.5 h-3.5 text-destructive" />
                        </Button>
                      </div>
                    </>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
