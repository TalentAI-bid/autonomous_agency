'use client';

import { useRouter } from 'next/navigation';
import { useCrmBoard, useSeedStages } from '@/hooks/use-crm';
import { DealBoard } from '@/components/crm/deal-board';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Kanban, Settings, Sprout } from 'lucide-react';
import Link from 'next/link';
import type { DealWithContact } from '@/types';

export default function CrmPage() {
  const router = useRouter();
  const { data: columns, isLoading } = useCrmBoard();
  const seedStages = useSeedStages();

  function handleDealClick(deal: DealWithContact) {
    router.push(`/crm/deals/${deal.id}`);
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Kanban className="w-6 h-6" /> CRM Pipeline
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            Track deals through your pipeline stages
          </p>
        </div>
        <div className="flex items-center gap-2">
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
        />
      )}
    </div>
  );
}
