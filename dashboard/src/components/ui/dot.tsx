import { cn } from '@/lib/utils';

export function Dot({
  state = 'idle',
  className,
  title,
}: {
  state?: 'live' | 'paused' | 'warn' | 'idle';
  className?: string;
  title?: string;
}) {
  return (
    <span
      className={cn(
        'dot',
        state === 'live' && 'is-live',
        state === 'paused' && 'is-paused',
        state === 'warn' && 'is-warn',
        className,
      )}
      title={title}
    />
  );
}
