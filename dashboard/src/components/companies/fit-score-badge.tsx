'use client';

import { Badge } from '@/components/ui/badge';
import { Star } from 'lucide-react';

interface FitScoreBadgeProps {
  score: number | undefined | null;
  explanation?: string;
}

// Spec color buckets — wider band coverage now that we never reject:
//   80-100 bright green (star)
//   60-79  green
//   40-59  yellow
//   20-39  orange
//   0-19   gray
function bucket(score: number) {
  if (score >= 80) return { color: 'bg-up/25 text-up border-up/50', star: true };
  if (score >= 60) return { color: 'bg-up/15 text-up border-up/30', star: false };
  if (score >= 40) return { color: 'bg-warn/15 text-warn-fg border-warn/30', star: false };
  if (score >= 20) return { color: 'bg-warn/15 text-warn-fg border-warn/30', star: false };
  return { color: 'bg-ink-3/15 text-ink-3 border-line-2', star: false };
}

export function FitScoreBadge({ score, explanation }: FitScoreBadgeProps) {
  if (score == null) {
    return (
      <Badge variant="outline" className="text-xs text-muted-foreground" title="Not scored yet">
        — fit
      </Badge>
    );
  }
  const b = bucket(score);
  return (
    <Badge className={`text-xs border ${b.color}`} title={explanation}>
      {b.star && <Star className="w-3 h-3 mr-0.5 fill-current" />}
      Fit {score}
    </Badge>
  );
}
