'use client';

import { Badge } from '@/components/ui/badge';
import { Star } from 'lucide-react';

interface FitScoreBadgeProps {
  score: number | undefined | null;
  explanation?: string;
}

function bucket(score: number) {
  if (score >= 81) return { color: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40', star: true };
  if (score >= 61) return { color: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30', star: false };
  if (score >= 31) return { color: 'bg-amber-500/15 text-amber-400 border-amber-500/30', star: false };
  return { color: 'bg-zinc-500/15 text-zinc-400 border-zinc-500/30', star: false };
}

export function FitScoreBadge({ score, explanation }: FitScoreBadgeProps) {
  if (score == null) {
    return (
      <Badge variant="outline" className="text-xs text-muted-foreground" title="Not triaged">
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
