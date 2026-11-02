'use client';

import { AlertCircle, CheckCircle2, Info } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import {
  Toast,
  ToastClose,
  ToastDescription,
  ToastProvider,
  ToastTitle,
  ToastViewport,
} from '@/components/ui/toast';

const ICONS = {
  success: <CheckCircle2 size={16} className="text-up" />,
  destructive: <AlertCircle size={16} className="text-down" />,
  default: <Info size={16} className="text-accent" />,
} as const;

export function Toaster() {
  const { toasts } = useToast();

  return (
    <ToastProvider>
      {toasts.map(({ id, title, description, variant }) => (
        <Toast key={id} variant={variant}>
          <span className="mt-0.5 shrink-0">{ICONS[variant ?? 'default']}</span>
          <div className="grid min-w-0 gap-0.5">
            {title && <ToastTitle>{title}</ToastTitle>}
            {description && <ToastDescription>{description}</ToastDescription>}
          </div>
          <ToastClose />
        </Toast>
      ))}
      <ToastViewport />
    </ToastProvider>
  );
}
