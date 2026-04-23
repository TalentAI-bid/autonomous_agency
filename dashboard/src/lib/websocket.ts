import type { AgentEvent } from '@/types';
import { useAuthStore } from '@/stores/auth.store';

type EventHandler = (event: AgentEvent) => void;

const WS_URL = process.env.NEXT_PUBLIC_WS_URL || 'ws://localhost:4000';
const MAX_RECONNECT_DELAY = 30000;

class WebSocketManager {
  private ws: WebSocket | null = null;
  private handlers = new Map<string, Set<EventHandler>>();
  private token: string | null = null;
  private reconnectDelay = 1000;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private manualClose = false;

  connect(token: string): void {
    this.token = token;
    this.manualClose = false;
    this.openConnection();
  }

  disconnect(): void {
    this.manualClose = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.reconnectDelay = 1000;
  }

  subscribe(event: string, handler: EventHandler): void {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, new Set());
    }
    this.handlers.get(event)!.add(handler);
  }

  unsubscribe(event: string, handler: EventHandler): void {
    this.handlers.get(event)?.delete(handler);
  }

  get isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  private openConnection(): void {
    try {
      this.ws = new WebSocket(`${WS_URL}/ws/realtime`);

      this.ws.onopen = () => {
        this.reconnectDelay = 1000;
        const liveToken = useAuthStore.getState().token ?? this.token;
        if (liveToken) {
          this.token = liveToken;
          this.ws!.send(JSON.stringify({ type: 'auth', token: liveToken }));
        }
        this.dispatchInternal('ws:connected', {});
      };

      this.ws.onmessage = (event) => {
        try {
          const parsed = JSON.parse(event.data as string) as AgentEvent;
          this.dispatch(parsed);
        } catch {
          // ignore malformed messages
        }
      };

      this.ws.onclose = () => {
        this.ws = null;
        this.dispatchInternal('ws:disconnected', {});
        if (!this.manualClose) {
          this.scheduleReconnect();
        }
      };

      this.ws.onerror = () => {
        this.ws?.close();
      };
    } catch {
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    this.reconnectTimer = setTimeout(() => {
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, MAX_RECONNECT_DELAY);
      this.openConnection();
    }, this.reconnectDelay);
  }

  private dispatch(event: AgentEvent): void {
    // dispatch to wildcard handlers
    this.handlers.get('*')?.forEach((h) => h(event));
    // dispatch to specific event handlers
    this.handlers.get(event.event)?.forEach((h) => h(event));
  }

  private dispatchInternal(eventName: string, data: Record<string, unknown>): void {
    this.handlers.get(eventName)?.forEach((h) =>
      h({ event: eventName, data, timestamp: new Date().toISOString() }),
    );
  }
}

// Singleton
export const wsManager = new WebSocketManager();
