'use client';

import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, Users } from 'lucide-react';
import { cn } from '@/lib/utils';

interface AgentFilterProps {
  agents: Array<{ id: string; name: string }>;
  /** '' means all agents */
  value: string;
  onChange: (id: string) => void;
}

/** Dropdown that scopes the Approvals page to one agent. Styled like the workspace switcher. */
export function AgentFilter({ agents, value, onChange }: AgentFilterProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const current = agents.find((a) => a.id === value);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const pick = (id: string) => {
    onChange(id);
    setOpen(false);
  };

  const options = [{ id: '', name: 'All agents' }, ...agents];

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={cn(
          'flex h-8 items-center gap-2 rounded-lg border bg-bg-panel pl-2 pr-2.5 text-body transition-colors hover:bg-bg-soft',
          open ? 'border-accent-mid' : 'border-line',
        )}
      >
        <span className="grid size-5 place-items-center rounded-md bg-accent-weak text-2xs font-semibold text-accent-fg">
          {current ? current.name.charAt(0).toUpperCase() : <Users size={11} />}
        </span>
        <span className="max-w-[160px] truncate font-medium text-ink">{current?.name ?? 'All agents'}</span>
        <ChevronDown className={cn('size-3.5 text-ink-3 transition-transform', open && 'rotate-180')} />
      </button>

      {open && (
        <div
          role="listbox"
          className="absolute left-0 top-full z-50 mt-1.5 max-h-72 w-64 overflow-y-auto rounded-lg border border-line bg-bg-panel p-1 shadow-lg scroll-thin"
        >
          <div className="px-2.5 pb-1.5 pt-2 text-2xs font-medium uppercase tracking-[0.09em] text-ink-4">Show approvals from</div>
          {options.map((o) => {
            const active = o.id === value;
            return (
              <button
                key={o.id || 'all'}
                type="button"
                role="option"
                aria-selected={active}
                onClick={() => pick(o.id)}
                className={cn(
                  'flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-body transition-colors hover:bg-bg-soft',
                  active && 'bg-accent-tint',
                )}
              >
                <span
                  className={cn(
                    'grid size-6 shrink-0 place-items-center rounded-md text-2xs font-semibold',
                    o.id ? 'bg-accent-weak text-accent-fg' : 'bg-bg-soft text-ink-3',
                  )}
                >
                  {o.id ? o.name.charAt(0).toUpperCase() : <Users size={12} />}
                </span>
                <span className={cn('min-w-0 flex-1 truncate', active ? 'font-semibold text-ink' : 'font-medium text-ink-2')}>{o.name}</span>
                {active && <Check className="size-4 shrink-0 text-accent" />}
              </button>
            );
          })}
          {agents.length === 0 && <div className="px-2.5 py-2 text-xs text-ink-3">No agents yet.</div>}
        </div>
      )}
    </div>
  );
}
