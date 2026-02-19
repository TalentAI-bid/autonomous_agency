import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

interface LoadingProps {
  className?: string;
}

export function PageLoading({ className }: LoadingProps) {
  return (
    <div className={cn('space-y-6', className)}>
      <Skeleton className="h-8 w-48" />
      <div className="grid grid-cols-4 gap-4">
        {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-28" />)}
      </div>
      <Skeleton className="h-64" />
    </div>
  );
}

export function CardLoading({ rows = 5 }: { rows?: number }) {
  return (
    <div className="space-y-2">
      {Array.from({ length: rows }).map((_, i) => <Skeleton key={i} className="h-12" />)}
    </div>
  );
}

export function SpinnerLoading({ className }: LoadingProps) {
  return (
    <div className={cn('flex items-center justify-center', className)}>
      <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
    </div>
  );
}
