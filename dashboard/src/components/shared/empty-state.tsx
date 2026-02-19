import { cn } from '@/lib/utils';
import { type LucideIcon } from 'lucide-react';

interface EmptyStateProps {
  icon?: LucideIcon;
  title: string;
  description?: string;
  action?: React.ReactNode;
  className?: string;
}

export function EmptyState({ icon: Icon, title, description, action, className }: EmptyStateProps) {
  return (
    <div className={cn('flex flex-col items-center justify-center py-16 gap-3 text-center', className)}>
      {Icon && (
        <div className="p-4 rounded-full bg-muted">
          <Icon className="w-8 h-8 text-muted-foreground" />
        </div>
      )}
      <div>
        <h3 className="font-semibold">{title}</h3>
        {description && <p className="text-sm text-muted-foreground mt-1 max-w-sm">{description}</p>}
      </div>
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
