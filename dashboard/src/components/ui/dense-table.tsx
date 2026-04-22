import { cn } from '@/lib/utils';
import type { HTMLAttributes, TableHTMLAttributes } from 'react';

export function DenseTable({ className, ...props }: TableHTMLAttributes<HTMLTableElement>) {
  return <table className={cn('tbl', className)} {...props} />;
}

export function DenseTableWrap({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('panel', className)} {...props} />;
}
