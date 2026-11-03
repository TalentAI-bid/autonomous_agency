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
    return null;
  }

  return (
    <DndContext
      sensors={sensors}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={() => setActiveDeal(null)}
    >
      <div className={cn('scroll-thin flex items-start gap-3 overflow-x-auto pb-4', className)}>
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

function money(deals: DealWithContact[]): string | null {
  const byCurrency = new Map<string, number>();
  for (const d of deals) {
    if (d.value == null || d.value === '' || Number.isNaN(Number(d.value))) continue;
    const c = d.currency ?? 'USD';
    byCurrency.set(c, (byCurrency.get(c) ?? 0) + Number(d.value));
  }
  if (byCurrency.size === 0) return null;
  return [...byCurrency.entries()]
    .map(([currency, v]) => new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: 0 }).format(v))
    .join(' · ');
}

function BoardColumnPanel({ column, onDealClick }: BoardColumnPanelProps) {
  const dealCount = column.deals.length;
  const { setNodeRef, isOver } = useDroppable({ id: column.id });
  const total = money(column.deals);

  return (
    <div
      ref={setNodeRef}
      className={cn(
        'flex w-[284px] shrink-0 flex-col rounded-2xl border transition-colors',
        isOver ? 'border-accent-mid bg-accent-weak' : 'border-line bg-bg-soft',
      )}
    >
      {/* Column header */}
      <div className="flex items-center justify-between gap-2 px-3.5 pb-2 pt-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: column.color }} aria-hidden />
          <h3 className="m-0 truncate text-body font-semibold text-ink">{column.name}</h3>
        </div>
        <span className="shrink-0 rounded-tag bg-bg-panel px-2 py-0.5 font-mono text-2xs font-medium text-ink-2">{dealCount}</span>
      </div>
      {total && <div className="px-3.5 pb-1 font-mono text-2xs text-ink-3">{total}</div>}

      {/* Cards */}
      <div className="scroll-thin flex max-h-[calc(100vh-16rem)] flex-1 flex-col gap-2 overflow-y-auto p-2.5">
        {dealCount === 0 ? (
          <div className="grid place-items-center rounded-xl border border-dashed border-line-strong py-8 text-center">
            <p className="m-0 text-xs text-ink-4">{isOver ? 'Drop here' : 'No deals'}</p>
          </div>
        ) : (
          column.deals.map((deal) => <DraggableDealCard key={deal.id} deal={deal} onClick={() => onDealClick?.(deal)} />)
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
