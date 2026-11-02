import type { ReactNode } from 'react';
import { Label } from '@/components/ui/label';

/** Card with a title and one-line description, used by the simple settings tabs. */
export function Panel({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return (
    <section className="overflow-hidden rounded-2xl border border-line bg-bg-panel shadow-sm">
      <header className="border-b border-line px-5 py-3.5">
        <h2 className="m-0 text-body font-semibold text-ink">{title}</h2>
        <p className="mb-0 mt-0.5 text-xs text-ink-3">{description}</p>
      </header>
      <div className="p-5">{children}</div>
    </section>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-3xs font-medium uppercase tracking-[0.09em] text-ink-4">{label}</Label>
      {children}
    </div>
  );
}

export const readOnlyInput = 'h-9 rounded-lg border-line bg-bg-sub text-body text-ink-2';
