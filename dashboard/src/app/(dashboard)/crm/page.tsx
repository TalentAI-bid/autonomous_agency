'use client';

import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { useCrmBoard, useSeedStages, useMoveDealStage } from '@/hooks/use-crm';
import { DealBoard } from '@/components/crm/deal-board';
import { NewDealDialog } from '@/components/crm/new-deal-dialog';
import { AddActivityDialog } from '@/components/crm/add-activity-dialog';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useToast } from '@/hooks/use-toast';
import { Kanban, Settings, Sprout, Activity } from 'lucide-react';
import Link from 'next/link';
import type { DealWithContact, BoardColumn } from '@/types';

export default function CrmPage() {
  const router = useRouter();
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data: columns, isLoading } = useCrmBoard();
  const seedStages = useSeedStages();
  const moveDeal = useMoveDealStage();

  function handleDealClick(deal: DealWithContact) {
    router.push(`/crm/deals/${deal.id}`);
  }

  // Optimistic kanban move: snapshot, mutate, rollback on error.
  function handleMoveDeal(dealId: string, targetStageId: string) {
    const prev = qc.getQueryData<BoardColumn[]>(['crm', 'board']);
    if (!prev) {
      moveDeal.mutate({ dealId, stageId: targetStageId });
      return;
    }

    // Optimistic mutation of the cached board
    let movedDeal: DealWithContact | undefined;
    const next = prev.map((col) => {
      const idx = col.deals.findIndex((d) => d.id === dealId);
      if (idx >= 0) {
        movedDeal = col.deals[idx];
        return { ...col, deals: col.deals.filter((d) => d.id !== dealId) };
      }
      return col;
    });
    if (!movedDeal) return;

    const finalNext = next.map((col) =>
      col.id === targetStageId
        ? { ...col, deals: [{ ...movedDeal!, stageId: targetStageId, stage: col }, ...col.deals] }
        : col,
    );
    qc.setQueryData<BoardColumn[]>(['crm', 'board'], finalNext);

    moveDeal.mutate(
      { dealId, stageId: targetStageId },
      {
        onError: (err) => {
          qc.setQueryData(['crm', 'board'], prev);
          toast({
            title: 'Could not move deal',
            description: err instanceof Error ? err.message : 'Reverted.',
            variant: 'destructive',
          });
        },
      },
    );
  }

  const cols = columns ?? [];
  const dealCount = cols.reduce((n, c) => n + c.deals.length, 0);
  const totals = new Map<string, number>();
  for (const d of cols.flatMap((c) => c.deals)) {
    if (d.value == null || d.value === '' || Number.isNaN(Number(d.value))) continue;
    const cur = d.currency ?? 'USD';
    totals.set(cur, (totals.get(cur) ?? 0) + Number(d.value));
  }
  const pipelineValue = [...totals.entries()]
    .map(([currency, v]) => new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: 0 }).format(v))
    .join(' · ');

  return (
    <div className="flex flex-col gap-4 p-5">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-baseline gap-2 px-1 text-2xs font-medium uppercase tracking-[0.09em] text-ink-4">
          <span>Deals</span>
          {!isLoading && cols.length > 0 && (
            <span className="normal-case tracking-normal text-ink-3">
              {dealCount} in pipeline{pipelineValue ? ` · ${pipelineValue}` : ''}
            </span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <AddActivityDialog
            trigger={
              <Button size="sm" type="button" variant="panel">
                <Activity className="mr-1.5 size-3.5" />
                Log activity
              </Button>
            }
          />
          <Button size="sm" asChild variant="panel">
            <Link href="/crm/settings">
              <Settings className="mr-1.5 size-3.5" />
              Stages
            </Link>
          </Button>
          <NewDealDialog />
        </div>
      </div>

      {/* Board */}
      {isLoading ? (
        <div className="flex gap-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-96 w-[284px] shrink-0 rounded-2xl" />
          ))}
        </div>
      ) : cols.length === 0 ? (
        <section className="rounded-2xl border border-line bg-bg-panel p-7 shadow-sm">
          <span className="grid size-9 place-items-center rounded-full bg-accent-weak text-accent">
            <Kanban size={16} />
          </span>
          <h2 className="mb-0 mt-4 font-display text-[26px] font-normal leading-tight tracking-[-0.01em] text-ink">No pipeline stages yet</h2>
          <p className="mb-5 mt-2 max-w-[460px] text-body leading-relaxed text-ink-3">
            Stages are the columns your deals move through, like Lead, Qualified and Won. Start with the defaults and rename them later.
          </p>
          <Button type="button" variant="brand" onClick={() => seedStages.mutate()} disabled={seedStages.isPending}>
            <Sprout className="mr-1.5 size-4" />
            {seedStages.isPending ? 'Creating…' : 'Create default stages'}
          </Button>
        </section>
      ) : (
        <DealBoard columns={cols} onDealClick={handleDealClick} onMoveDeal={handleMoveDeal} />
      )}
    </div>
  );
}
