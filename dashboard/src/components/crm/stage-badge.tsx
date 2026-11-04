'use client';

import type { CSSProperties } from 'react';
import { Badge } from '@/components/ui/badge';
import type { CrmStage } from '@/types';

export function StageBadge({ stage }: { stage: CrmStage }) {
  // Outline badges draw their edge with a ring, so the stage color goes there.
  const style = { color: stage.color, ['--tw-ring-color' as string]: stage.color } as CSSProperties;
  return (
    <Badge variant="outline" style={style} dot>
      {stage.name}
    </Badge>
  );
}
