import * as React from 'react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface CardProps extends React.HTMLAttributes<HTMLElement> {
  /** Element to render. Defaults to a div; use "section" for titled regions. */
  as?: 'div' | 'section' | 'article';
}

/** The one card shell: every white bordered panel in the app starts here. */
const Card = React.forwardRef<HTMLDivElement, CardProps>(({ className, as: Comp = 'div', ...props }, ref) => (
  <Comp
    ref={ref as React.Ref<HTMLDivElement>}
    className={cn('rounded-2xl border border-line bg-bg-panel text-ink shadow-sm', className)}
    {...props}
  />
));
Card.displayName = 'Card';

const CardHeader = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => <div ref={ref} className={cn('flex flex-col space-y-1 p-5', className)} {...props} />,
);
CardHeader.displayName = 'CardHeader';

const CardTitle = React.forwardRef<HTMLHeadingElement, React.HTMLAttributes<HTMLHeadingElement>>(
  ({ className, ...props }, ref) => <h3 ref={ref} className={cn('m-0 text-body font-semibold leading-tight text-ink', className)} {...props} />,
);
CardTitle.displayName = 'CardTitle';

const CardDescription = React.forwardRef<HTMLParagraphElement, React.HTMLAttributes<HTMLParagraphElement>>(
  ({ className, ...props }, ref) => <p ref={ref} className={cn('m-0 text-xs leading-relaxed text-ink-3', className)} {...props} />,
);
CardDescription.displayName = 'CardDescription';

const CardContent = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => <div ref={ref} className={cn('p-5 pt-0', className)} {...props} />,
);
CardContent.displayName = 'CardContent';

const CardFooter = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => <div ref={ref} className={cn('flex items-center p-5 pt-0', className)} {...props} />,
);
CardFooter.displayName = 'CardFooter';

/**
 * Titled card. `layout` picks how the body is laid out:
 *  - padded (default): bordered header, padded body. For forms and prose.
 *  - bare: bordered header, body untouched. For tables and row lists that manage their own padding.
 *  - rows: compact borderless header, body untouched. Rows bring their own `border-t`.
 */
interface CardSectionProps {
  title: React.ReactNode;
  description?: React.ReactNode;
  /** Optional icon shown in a tinted tile before the title. */
  icon?: LucideIcon;
  /** Right-hand slot in the header (count, status pill, action). */
  meta?: React.ReactNode;
  layout?: 'padded' | 'bare' | 'rows';
  className?: string;
  bodyClassName?: string;
  children: React.ReactNode;
}

function CardSection({ title, description, icon: Icon, meta, layout = 'padded', className, bodyClassName, children }: CardSectionProps) {
  const rows = layout === 'rows';
  return (
    <Card as="section" className={cn('overflow-hidden', className)}>
      <header
        className={cn(
          'flex items-center justify-between gap-3',
          rows ? 'h-11 px-4' : 'border-b border-line px-5 py-3.5',
        )}
      >
        <div className="flex min-w-0 items-center gap-3">
          {Icon && (
            <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-accent-weak text-accent">
              <Icon size={15} />
            </span>
          )}
          <div className="min-w-0">
            <h2 className="m-0 text-body font-semibold text-ink">{title}</h2>
            {description && <p className="mb-0 mt-0.5 text-xs text-ink-3">{description}</p>}
          </div>
        </div>
        {meta && <div className="shrink-0 text-xs text-ink-3">{meta}</div>}
      </header>
      {layout === 'padded' ? <div className={cn('p-5', bodyClassName)}>{children}</div> : <div className={bodyClassName}>{children}</div>}
    </Card>
  );
}

export { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter, CardSection };
