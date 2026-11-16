'use client';

import { useRealtimeStore } from '@/stores/realtime.store';

/**
 * Refetch interval for data the server also pushes over the WebSocket.
 * While the socket is up, `useWebSocket` invalidates the query on each event, so we
 * only keep a slow safety-net refetch; if the socket is down, poll at the fast rate.
 */
export function usePollInterval(fastMs: number, connectedMs: number): number {
  const connected = useRealtimeStore((s) => s.connected);
  return connected ? connectedMs : fastMs;
}
