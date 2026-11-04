'use client';

import { Star } from 'lucide-react';
import { Badge, type BadgeProps } from '@/components/ui/badge';

interface FitScoreBadgeProps {
  score: number | undefined | null;
  explanation?: string;
}

// Color buckets: 60+ green (80+ gets a star), 20-59 amber, below 20 neutral.
function bucket(score: number): { variant: BadgeProps['variant']; star: boolean } {
  if (score >= 80) return { variant: 'up', star: true };
  if (score >= 60) return { variant: 'up', star: false };
  if (score >= 20) return { variant: 'warn', star: false };
  return { variant: 'muted', star: false };
}

export function FitScoreBadge({ score, explanation }: FitScoreBadgeProps) {
  if (score == null) {
    return (
      <Badge variant="outline" title="Not scored yet">
        — fit
      </Badge>
    );
  }
  const b = bucket(score);
  return (
    <Badge variant={b.variant} title={explanation}>
      {b.star && <Star className="size-3 fill-current" />}
      Fit {score}
    </Badge>
  );
}
