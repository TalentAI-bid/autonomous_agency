import * as React from 'react';
import { cn } from '@/lib/utils';

export interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {}

/** Native <select> styled to match Input. Size/width overrides go through className. */
const Select = React.forwardRef<HTMLSelectElement, SelectProps>(({ className, ...props }, ref) => {
  return (
    <select
      className={cn(
        'h-9 rounded-lg border border-line bg-bg-panel px-3 text-body text-ink transition-colors hover:border-line-strong focus-visible:border-accent-mid focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-weak disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      ref={ref}
      {...props}
    />
  );
});
Select.displayName = 'Select';

export { Select };
