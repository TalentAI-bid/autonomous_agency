import { cn } from '@/lib/utils';

export function SignalStrip({ children }: { children: React.ReactNode }) {
  return <div className="signal-strip">{children}</div>;
}

export function SignalCell({
  name,
  value,
  sub,
  state = 'idle',
  heartbeat = false,
}: {
  name: string;
  value: string | number;
  sub?: string;
  state?: 'live' | 'warm' | 'idle' | 'warn';
  heartbeat?: boolean;
}) {
  return (
    <div className={cn('signal-cell', state !== 'idle' && `is-${state}`)}>
      <div className="name">{name}</div>
      <div className="num">{value}</div>
      {sub && <div className="sub">{sub}</div>}
      {heartbeat && (
        <div className="heartbeat" aria-hidden>
          <span />
        </div>
      )}
    </div>
  );
}
