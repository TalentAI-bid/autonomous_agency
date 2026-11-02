import * as React from 'react';
import { cn } from '@/lib/utils';

export interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {}

const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(({ className, ...props }, ref) => {
  return (
    <textarea
      className={cn(
        'flex min-h-[60px] w-full rounded-lg border border-line bg-bg-panel px-3 py-2 text-body text-ink transition-colors placeholder:text-ink-4 hover:border-line-strong focus-visible:border-accent-mid focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-weak disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      ref={ref}
      {...props}
    />
  );
});
Textarea.displayName = 'Textarea';

export { Textarea };
