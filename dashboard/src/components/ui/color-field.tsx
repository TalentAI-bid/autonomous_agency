'use client';

import * as React from 'react';
import { Check } from 'lucide-react';
import { cn } from '@/lib/utils';

export const COLOR_PRESETS = [
  '#6366f1', '#8b5cf6', '#ec4899', '#ef4444', '#f59e0b', '#10b981', '#06b6d4', '#3b82f6', '#64748b',
];

const HEX = /^#[0-9a-f]{6}$/i;

/** Hex text field + native picker swatch. Commits only valid #rrggbb values. */
function HexInput({ value, onChange, id }: { value: string; onChange: (v: string) => void; id?: string }) {
  const [draft, setDraft] = React.useState(value);
  React.useEffect(() => setDraft(value), [value]);

  return (
    <div className="flex h-9 items-center gap-2 rounded-lg border border-line bg-bg-panel pl-1.5 pr-2.5 transition-colors hover:border-line-strong focus-within:border-accent-mid focus-within:ring-2 focus-within:ring-accent-weak">
      <label className="relative size-6 shrink-0 cursor-pointer overflow-hidden rounded-md border border-black/10" style={{ backgroundColor: value }} title="Pick a custom color">
        <input
          type="color"
          value={HEX.test(value) ? value : '#6366f1'}
          onChange={(e) => onChange(e.target.value)}
          aria-label="Pick a custom color"
          className="absolute inset-0 size-full cursor-pointer opacity-0"
        />
      </label>
      <input
        id={id}
        value={draft}
        spellCheck={false}
        maxLength={7}
        onChange={(e) => {
          const v = e.target.value.startsWith('#') ? e.target.value : `#${e.target.value}`;
          setDraft(v);
          if (HEX.test(v)) onChange(v.toLowerCase());
        }}
        onBlur={() => setDraft(value)}
        aria-label="Hex color"
        className="w-[72px] border-0 bg-transparent font-mono text-body uppercase text-ink outline-none placeholder:text-ink-4"
        placeholder="#6366F1"
      />
    </div>
  );
}

export function ColorField({
  value,
  onChange,
  compact,
  id,
  className,
}: {
  value: string;
  onChange: (hex: string) => void;
  /** Hex field only, for tight rows. */
  compact?: boolean;
  id?: string;
  className?: string;
}) {
  if (compact) {
    return (
      <div className={className}>
        <HexInput id={id} value={value} onChange={onChange} />
      </div>
    );
  }

  return (
    <div className={cn('flex flex-wrap items-center gap-x-4 gap-y-2', className)}>
      <div role="radiogroup" aria-label="Preset colors" className="flex flex-wrap items-center gap-2">
        {COLOR_PRESETS.map((c) => {
          const active = c.toLowerCase() === value.toLowerCase();
          return (
            <button
              key={c}
              type="button"
              role="radio"
              aria-checked={active}
              aria-label={c}
              onClick={() => onChange(c)}
              className={cn(
                'grid size-7 place-items-center rounded-full border-0 text-white outline-none transition-transform hover:scale-110 focus-visible:ring-2 focus-visible:ring-accent-weak',
                active && 'ring-2 ring-offset-2 ring-offset-bg-panel',
              )}
              style={{ backgroundColor: c, ...(active ? { ['--tw-ring-color' as string]: c } : null) }}
            >
              {active && <Check size={13} strokeWidth={3} />}
            </button>
          );
        })}
      </div>
      <HexInput id={id} value={value} onChange={onChange} />
    </div>
  );
}
