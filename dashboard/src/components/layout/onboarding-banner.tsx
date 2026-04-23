'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Sparkles, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { CopilotPanel } from '@/components/copilot/copilot-panel';
import { useCompanyProfile } from '@/hooks/use-company-profile';
import { useProducts } from '@/hooks/use-products';

const DISMISS_KEY = 'agentcore-onboarding-dismissed';

export function OnboardingBanner() {
  const router = useRouter();
  const { data: profile, isLoading: profileLoading } = useCompanyProfile();
  const { data: products, isLoading: productsLoading } = useProducts();
  const [copilotOpen, setCopilotOpen] = useState(false);
  const [dismissed, setDismissed] = useState(true);

  const hasCompany = !!profile?.companyName?.trim();
  const hasProducts = (products ?? []).length > 0;
  const configured = hasCompany || hasProducts;

  useEffect(() => {
    if (typeof window === 'undefined') return;
    // Auto-clear dismissal once the user has configured something
    if (configured) {
      localStorage.removeItem(DISMISS_KEY);
      setDismissed(false);
      return;
    }
    setDismissed(localStorage.getItem(DISMISS_KEY) === '1');
  }, [configured]);

  function handleDismiss() {
    localStorage.setItem(DISMISS_KEY, '1');
    setDismissed(true);
  }

  if (profileLoading || productsLoading) return null;
  if (configured) return null;
  if (dismissed) return null;

  return (
    <>
      <div className="flex items-center gap-3 px-4 py-2.5 border-b border-border bg-primary/5 text-sm">
        <Sparkles className="w-4 h-4 text-primary shrink-0" />
        <div className="flex-1 min-w-0">
          <span className="font-medium">Finish setup</span>
          <span className="text-muted-foreground ml-2">
            Describe your company to the AI assistant — it&apos;ll fill in your profile and products.
          </span>
        </div>
        <Button size="sm" onClick={() => setCopilotOpen(true)} className="gap-1.5 shrink-0">
          <Sparkles className="w-3.5 h-3.5" />
          Setup with AI
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => router.push('/settings/company')}
          className="shrink-0"
        >
          Configure manually
        </Button>
        <Button
          size="icon"
          variant="ghost"
          onClick={handleDismiss}
          className="h-8 w-8 shrink-0"
          aria-label="Dismiss"
        >
          <X className="w-4 h-4" />
        </Button>
      </div>

      <CopilotPanel open={copilotOpen} onClose={() => setCopilotOpen(false)} />
    </>
  );
}
