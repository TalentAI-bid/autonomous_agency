import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const badgeVariants = cva('inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium transition-colors', {
  variants: {
    variant: {
      default: 'border-transparent bg-accent text-white',
      secondary: 'border-transparent bg-bg-soft text-ink-2',
      destructive: 'border-transparent bg-down/10 text-down',
      outline: 'border-line text-ink-2',
      success: 'border-transparent bg-up/10 text-up',
      warning: 'border-transparent bg-warn/10 text-warn-fg',
      error: 'border-transparent bg-down/10 text-down',
      purple: 'border-transparent bg-accent-weak text-accent-fg',
      blue: 'border-transparent bg-info/10 text-info',
    },
  },
  defaultVariants: { variant: 'default' },
});

export interface BadgeProps extends React.HTMLAttributes<HTMLDivElement>, VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
