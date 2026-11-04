import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

/**
 * The one button. Pick a variant for emphasis and a size for density; avoid
 * overriding height, radius or padding through className.
 *
 *  brand / default  primary action (violet)      panel     secondary action on a surface
 *  outline          quiet bordered                ghost     toolbar / icon actions
 *  destructive      irreversible action           secondary soft grey fill
 *  ink              high-contrast dark            link      inline text action
 */
const buttonVariants = cva(
  'inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-weak disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        default: 'border border-accent bg-accent font-semibold text-white hover:bg-accent/90',
        brand: 'border border-accent bg-accent font-semibold text-white hover:bg-accent/90',
        destructive: 'border border-down bg-down font-semibold text-white hover:bg-down/90',
        outline: 'border border-line bg-transparent text-ink hover:border-line-strong hover:bg-hover',
        panel: 'border border-line bg-bg-panel text-ink hover:border-line-strong hover:bg-hover',
        secondary: 'border border-transparent bg-bg-soft text-ink hover:bg-hover',
        ghost: 'border border-transparent text-ink-2 hover:bg-hover hover:text-ink',
        ink: 'border border-ink bg-ink text-bg hover:bg-ink/90',
        link: 'text-accent underline-offset-4 hover:underline',
      },
      size: {
        default: 'h-9 px-4 text-body',
        lg: 'h-10 px-5 text-body',
        sm: 'h-8 px-3 text-xs',
        dense: 'h-7 px-3 text-xs',
        xs: 'h-6 px-2 text-xs',
        icon: 'h-9 w-9',
        iconSm: 'size-7',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button';
    return (
      <Comp className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props} />
    );
  },
);
Button.displayName = 'Button';

export { Button, buttonVariants };
