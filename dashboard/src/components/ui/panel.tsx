import { cn } from '@/lib/utils';
import type { HTMLAttributes } from 'react';

export function Panel({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('panel', className)} {...props} />;
}

export function PanelHead({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('panel-head', className)} {...props} />;
}

export function PanelBody({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('panel-body', className)} {...props} />;
}
