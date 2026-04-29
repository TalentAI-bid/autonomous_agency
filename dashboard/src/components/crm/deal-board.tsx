'use client';

import * as React from 'react';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  useDraggable,
  useDroppable,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { cn } from '@/lib/utils';
import { DealCard } from './deal-card';
import type { BoardColumn, DealWithContact } from '@/types';

interface DealBoardProps {
  columns: BoardColumn[];
  /** Fired when a card is dropped into a different column. */
  onMoveDeal?: (dealId: string, targetStageId: string) => void;
  onDealClick?: (deal: DealWithContact) => void;
  className?: string;
}

export function DealBoard({ columns, onMoveDeal, onDealClick, className }: DealBoardProps) {
  // 8px activation distance prevents drag from firing on plain clicks.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));

  const [activeDeal, setActiveDeal] = React.useState<DealWithContact | null>(null);

  function handleDragStart(e: DragStartEvent) {
    const dealId = String(e.active.id);
    const deal = columns.flatMap((c) => c.deals).find((d) => d.id === dealId) ?? null;
    setActiveDeal(deal);
  }

  function handleDragEnd(e: DragEndEvent) {
    setActiveDeal(null);
    if (!e.over || !onMoveDeal) return;
    const dealId = String(e.active.id);
    const targetStageId = String(e.over.id);
    const sourceColumn = columns.find((c) => c.deals.some((d) => d.id === dealId));
    if (!sourceColumn || sourceColumn.id === targetStageId) return;
    onMoveDeal(dealId, targetStageId);
  }

  if (columns.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center">
        <p className="text-sm text-muted-foreground">No pipeline stages configured.</p>
        <p className="mt-1 text-xs text-muted-foreground">Seed default stages to get started.</p>
      </div>
    );
  }

  return (
    <DndContext
      sensors={sensors}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={() => setActiveDeal(null)}
    >
      <div className={cn('flex gap-4 overflow-x-auto pb-4', className)}>
        {columns.map((column) => (
          <BoardColumnPanel
            key={column.id}
            column={column}
            onDealClick={onDealClick}
          />
        ))}
      </div>
      <DragOverlay dropAnimation={null}>
        {activeDeal ? (
          <div className="rotate-1 cursor-grabbing">
            <DealCard deal={activeDeal} />
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}

// ── Internal column component ──────────────────────────────────────────────────

interface BoardColumnPanelProps {
  column: BoardColumn;
  onDealClick?: (deal: DealWithContact) => void;
}

function BoardColumnPanel({ column, onDealClick }: BoardColumnPanelProps) {
  const dealCount = column.deals.length;
  const { setNodeRef, isOver } = useDroppable({ id: column.id });

  return (
    <div
      ref={setNodeRef}
      className={cn(
        'flex w-72 shrink-0 flex-col rounded-xl border bg-muted/30 transition-colors',
        isOver ? 'border-primary bg-primary/5' : 'border-border',
      )}
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
            <DraggableDealCard
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

// ── Draggable card wrapper ─────────────────────────────────────────────────────

function DraggableDealCard({ deal, onClick }: { deal: DealWithContact; onClick: () => void }) {
  const { setNodeRef, attributes, listeners, isDragging, transform } = useDraggable({ id: deal.id });

  // Hide the original card while dragging (DragOverlay shows the visual).
  const style: React.CSSProperties = {
    opacity: isDragging ? 0 : 1,
    transform: transform ? `translate3d(${transform.x}px, ${transform.y}px, 0)` : undefined,
  };

  return (
    <div ref={setNodeRef} style={style} {...attributes} {...listeners}>
      <DealCard deal={deal} onClick={onClick} />
    </div>
  );
}
