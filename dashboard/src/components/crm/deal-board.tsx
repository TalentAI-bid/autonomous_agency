'use client';

import { cn } from '@/lib/utils';
import { DealCard } from './deal-card';
import type { BoardColumn, DealWithContact } from '@/types';

interface DealBoardProps {
  columns: BoardColumn[];
  onMoveDeal?: (dealId: string, targetStageId: string) => void;
  onDealClick?: (deal: DealWithContact) => void;
  className?: string;
}

export function DealBoard({ columns, onMoveDeal: _onMoveDeal, onDealClick, className }: DealBoardProps) {
  if (columns.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center">
        <p className="text-sm text-muted-foreground">No pipeline stages configured.</p>
        <p className="mt-1 text-xs text-muted-foreground">Seed default stages to get started.</p>
      </div>
    );
  }

  return (
    <div
      className={cn(
        'flex gap-4 overflow-x-auto pb-4',
        className,
      )}
    >
      {columns.map((column) => (
        <BoardColumnPanel
          key={column.id}
          column={column}
          onDealClick={onDealClick}
        />
      ))}
    </div>
  );
}

// ── Internal column component ──────────────────────────────────────────────────

interface BoardColumnPanelProps {
  column: BoardColumn;
  onDealClick?: (deal: DealWithContact) => void;
}

function BoardColumnPanel({ column, onDealClick }: BoardColumnPanelProps) {
  const dealCount = column.deals.length;

  return (
    <div
      className="flex w-72 shrink-0 flex-col rounded-xl border border-border bg-muted/30"
      style={{ borderTopColor: column.color, borderTopWidth: 3 }}
    >
      {/* Column header */}
      <div className="flex items-center justify-between px-3 py-3 border-b border-border">
        <div className="flex items-center gap-2 min-w-0">
          <span
            className="h-2.5 w-2.5 shrink-0 rounded-full"
            style={{ backgroundColor: column.color }}
            aria-hidden
          />
          <h3 className="truncate text-sm font-semibold text-foreground">
            {column.name}
          </h3>
        </div>
        <span className="ml-2 shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
          {dealCount}
        </span>
      </div>

      {/* Cards */}
      <div className="flex flex-col gap-2 p-3 flex-1 overflow-y-auto max-h-[calc(100vh-12rem)]">
        {dealCount === 0 ? (
          <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border py-8 text-center">
            <p className="text-xs text-muted-foreground">No deals</p>
          </div>
        ) : (
          column.deals.map((deal) => (
            <DealCard
              key={deal.id}
              deal={deal}
              onClick={() => onDealClick?.(deal)}
            />
          ))
        )}
      </div>
    </div>
  );
}
