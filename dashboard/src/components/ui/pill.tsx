import { cn } from '@/lib/utils';
import type { ReactNode } from 'react';

type PillVariant = 'default' | 'up' | 'down' | 'warn' | 'accent';

export function Pill({
  children,
  variant = 'default',
  className,
}: {
  children: ReactNode;
  variant?: PillVariant;
  className?: string;
}) {
  return (
    <span
      className={cn(
        'pill',
        variant === 'up' && 'is-up',
        variant === 'down' && 'is-down',
        variant === 'warn' && 'is-warn',
        variant === 'accent' && 'is-accent',
        className,
      )}
    >
      {children}
    </span>
  );
}
