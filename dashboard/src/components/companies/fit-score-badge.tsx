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
  if (score >= 80) return { color: 'bg-emerald-500/25 text-emerald-200 border-emerald-400/50', star: true };
  if (score >= 60) return { color: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30', star: false };
  if (score >= 40) return { color: 'bg-amber-500/15 text-amber-400 border-amber-500/30', star: false };
  if (score >= 20) return { color: 'bg-orange-500/15 text-orange-400 border-orange-500/30', star: false };
  return { color: 'bg-zinc-500/15 text-zinc-400 border-zinc-500/30', star: false };
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
