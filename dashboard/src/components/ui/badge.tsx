import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * The one label/pill/chip component. Tones carry meaning:
 * soft/muted = neutral, accent = brand, up = good, warn = attention, down = bad, info = FYI.
 * Older names (secondary, purple, success, warning, error, destructive, blue) are aliases.
 */
const badgeVariants = cva('inline-flex items-center gap-1.5 whitespace-nowrap rounded-tag font-medium transition-colors', {
  variants: {
    variant: {
      default: 'bg-accent text-white',
      soft: 'bg-bg-soft text-ink-2',
      secondary: 'bg-bg-soft text-ink-2',
      muted: 'bg-bg-soft text-ink-3',
      accent: 'bg-accent-weak text-accent-fg',
      purple: 'bg-accent-weak text-accent-fg',
      up: 'bg-up/10 text-up',
      success: 'bg-up/10 text-up',
      warn: 'bg-warn/15 text-warn-fg',
      warning: 'bg-warn/15 text-warn-fg',
      down: 'bg-down/10 text-down',
      destructive: 'bg-down/10 text-down',
      error: 'bg-down/10 text-down',
      info: 'bg-info/10 text-info',
      blue: 'bg-info/10 text-info',
      outline: 'text-ink-2 ring-1 ring-inset ring-line',
    },
    size: {
      md: 'px-2 py-1 text-xs',
      sm: 'px-1.5 py-0.5 text-2xs',
    },
  },
  defaultVariants: { variant: 'soft', size: 'md' },
});

export interface BadgeProps extends Omit<React.HTMLAttributes<HTMLSpanElement>, 'children'>, VariantProps<typeof badgeVariants> {
  children?: React.ReactNode;
  /** Leading status dot in the badge's own color. */
  dot?: boolean;
  /** Shows a trailing × button that calls this. */
  onRemove?: () => void;
  /** Accessible name for the × button. Defaults to "Remove". */
  removeLabel?: string;
}

function Badge({ className, variant, size, dot, onRemove, removeLabel = 'Remove', children, ...props }: BadgeProps) {
  return (
    <span className={cn(badgeVariants({ variant, size }), onRemove && 'pr-1', className)} {...props}>
      {dot && <span className="size-1.5 shrink-0 rounded-full bg-current" />}
      {children}
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          aria-label={removeLabel}
          className="grid size-4 shrink-0 place-items-center rounded-full border-0 bg-transparent p-0 text-current opacity-60 transition hover:bg-black/10 hover:opacity-100"
        >
          <X size={11} />
        </button>
      )}
    </span>
  );
}

export { Badge, badgeVariants };
