'use client';

import * as React from 'react';
import { AlertTriangle } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';

export interface ConfirmOptions {
  title: React.ReactNode;
  description?: React.ReactNode;
  /** Label of the confirm button. Defaults to "Confirm". */
  confirmLabel?: string;
  cancelLabel?: string;
  /** `destructive` (default) styles the action red; `default` uses the brand color. */
  tone?: 'destructive' | 'default';
}

type ConfirmFn = (options: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = React.createContext<ConfirmFn | null>(null);

/**
 * Replacement for `window.confirm`. Mount once near the app root; call
 * `const confirm = useConfirm()` anywhere below it and `await confirm({ ... })`.
 */
export function ConfirmProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = React.useState<{ options: ConfirmOptions; resolve: (v: boolean) => void } | null>(null);

  const confirm = React.useCallback<ConfirmFn>(
    (options) =>
      new Promise<boolean>((resolve) => {
        setState((prev) => {
          prev?.resolve(false); // a newer prompt supersedes an unanswered one
          return { options, resolve };
        });
      }),
    [],
  );

  function settle(value: boolean) {
    state?.resolve(value);
    setState(null);
  }

  const o = state?.options;
  const destructive = (o?.tone ?? 'destructive') === 'destructive';

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <Dialog open={!!state} onOpenChange={(v) => !v && settle(false)}>
        <DialogContent className="gap-0 overflow-hidden rounded-2xl border-line p-0 sm:max-w-[420px]">
          <div className="flex items-start gap-3.5 px-5 pb-5 pt-5 pr-10">
            <span
              className={`grid size-10 shrink-0 place-items-center rounded-full ${destructive ? 'bg-down/10 text-down' : 'bg-accent-weak text-accent'}`}
            >
              <AlertTriangle size={18} />
            </span>
            <div className="min-w-0">
              <DialogTitle className="text-[15px] font-semibold leading-snug text-ink">{o?.title}</DialogTitle>
              {o?.description && (
                <DialogDescription className="mt-1.5 whitespace-pre-line text-body leading-relaxed text-ink-3">
                  {o.description}
                </DialogDescription>
              )}
            </div>
          </div>
          <DialogFooter className="items-center gap-2 border-t border-line bg-bg-sub px-5 py-3 sm:space-x-0">
            <Button type="button" variant="outline" size="sm" onClick={() => settle(false)}>
              {o?.cancelLabel ?? 'Cancel'}
            </Button>
            <Button type="button" variant={destructive ? 'destructive' : 'brand'} size="sm" onClick={() => settle(true)} autoFocus>
              {o?.confirmLabel ?? 'Confirm'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </ConfirmContext.Provider>
  );
}

export function useConfirm(): ConfirmFn {
  const ctx = React.useContext(ConfirmContext);
  if (!ctx) throw new Error('useConfirm must be used inside <ConfirmProvider>');
  return ctx;
}
