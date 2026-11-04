import type { ReactNode } from 'react';
import { Label } from '@/components/ui/label';

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-3xs font-medium uppercase tracking-[0.09em] text-ink-4">{label}</Label>
      {children}
    </div>
  );
}

export const readOnlyInput = 'h-9 rounded-lg border-line bg-bg-sub text-body text-ink-2';
