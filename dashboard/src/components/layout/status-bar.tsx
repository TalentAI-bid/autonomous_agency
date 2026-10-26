'use client';

import { useEffect, useState } from 'react';
import { useRealtimeStore } from '@/stores/realtime.store';

import { cn } from '@/lib/utils';
function pad(n: number) {
  return String(n).padStart(2, '0');
}

function nowClock() {
  const d = new Date();
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function StatusBar() {
  const connected = useRealtimeStore((s) => s.connected);
  const events = useRealtimeStore((s) => s.events);
  const [ts, setTs] = useState(() => nowClock());

  useEffect(() => {
    const id = setInterval(() => setTs(nowClock()), 1000);
    return () => clearInterval(id);
  }, []);

  const recent = events.filter((e) => Date.now() - new Date(e.timestamp).getTime() < 10000);
  const evtPerSec = (recent.length / 10).toFixed(1);

  return (
    <div className="status-bar">
      <span className="inline-flex items-center gap-1.5">
        <span
          className={cn('dot', connected ? '!bg-up' : '!bg-ink-4')}
        />
        <span>{connected ? 'WS connected' : 'WS disconnected'}</span>
      </span>
      <span>evt/sec {evtPerSec}</span>
      <span>events 60s: {events.length}</span>
      <span>llm tokens — / — today</span>
      <span className="ml-auto">{ts}</span>
    </div>
  );
}
