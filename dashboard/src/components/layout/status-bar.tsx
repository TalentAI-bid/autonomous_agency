'use client';

import { useEffect, useState } from 'react';
import { useRealtimeStore } from '@/stores/realtime.store';

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
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
        <span
          className="dot"
          style={{
            background: connected ? 'oklch(0.78 0.15 145)' : 'var(--ink-4)',
          }}
        />
        <span>{connected ? 'WS connected' : 'WS disconnected'}</span>
      </span>
      <span>evt/sec {evtPerSec}</span>
      <span>events 60s: {events.length}</span>
      <span>llm tokens — / — today</span>
      <span style={{ marginLeft: 'auto' }}>{ts}</span>
    </div>
  );
}
