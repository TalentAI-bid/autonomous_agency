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

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Kanban className="w-6 h-6" /> CRM Pipeline
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            Track deals through your pipeline stages
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <NewDealDialog />
          <AddActivityDialog
            trigger={
              <Button variant="outline" size="sm">
                <Activity className="w-4 h-4 mr-2" />
                Log Activity
              </Button>
            }
          />
          <Button
            variant="outline"
            size="sm"
            onClick={() => seedStages.mutate()}
            disabled={seedStages.isPending}
          >
            <Sprout className="w-4 h-4 mr-2" />
            {seedStages.isPending ? 'Seeding…' : 'Seed Stages'}
          </Button>
          <Link href="/crm/settings">
            <Button variant="outline" size="sm">
              <Settings className="w-4 h-4 mr-2" />
              Stages
            </Button>
          </Link>
        </div>
      </div>

      {/* Board */}
      {isLoading ? (
        <div className="flex gap-4">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="w-72 h-96 shrink-0 rounded-xl" />
          ))}
        </div>
      ) : (
        <DealBoard
          columns={columns ?? []}
          onDealClick={handleDealClick}
          onMoveDeal={handleMoveDeal}
        />
      )}
    </div>
  );
}
