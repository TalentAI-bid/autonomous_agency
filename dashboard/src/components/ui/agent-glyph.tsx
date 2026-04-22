import { cn } from '@/lib/utils';

export type AgentType =
  | 'master'
  | 'discovery'
  | 'enrichment'
  | 'scoring'
  | 'outreach'
  | 'reply'
  | 'action'
  | 'document'
  | 'strategist';

export function AgentGlyph({
  type,
  size = 18,
  className,
  label,
}: {
  type: AgentType | string;
  size?: number;
  className?: string;
  label?: string;
}) {
  const letter = (label ?? type).charAt(0).toUpperCase();
  const style = {
    width: size,
    height: size,
    fontSize: Math.max(8, Math.floor(size * 0.55)),
  };
  return (
    <div className={cn('agent-glyph', type, className)} style={style}>
      {letter}
    </div>
  );
}
