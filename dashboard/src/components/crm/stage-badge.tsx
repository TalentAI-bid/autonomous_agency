'use client';

import { Badge } from '@/components/ui/badge';
import type { CrmStage } from '@/types';

export function StageBadge({ stage }: { stage: CrmStage }) {
  return (
    <Badge
      variant="outline"
      style={{ borderColor: stage.color, color: stage.color }}
      className="text-xs font-medium"
    >
      {stage.name}
    </Badge>
  );
}
