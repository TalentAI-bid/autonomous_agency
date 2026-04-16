// ─── WebSocket client with exponential backoff + heartbeat ─────────────────
// Used by the service worker to stay connected to the TalentAI backend.

export class TalentAIWebSocket {
  constructor({ serverUrl, apiKey, onMessage, onStatus }) {
    this.serverUrl = serverUrl;
    this.apiKey = apiKey;
    this.onMessage = onMessage;
    this.onStatus = onStatus;
    this.ws = null;
    this.reconnectAttempts = 0;
    this.reconnectTimer = null;
    this.pingTimer = null;
    this.pongTimer = null;
    this.closed = false;
    this.missedPongs = 0;
  }

  connect() {
    this.closed = false;
    this._open();
  }

  _open() {
    try {
      const base = this.serverUrl.replace(/^http/, 'ws').replace(/\/$/, '');
      const url = `${base}/ws/extension?apiKey=${encodeURIComponent(this.apiKey)}`;
      this.ws = new WebSocket(url);
      this._emitStatus('connecting');

      this.ws.addEventListener('open', () => {
        this.reconnectAttempts = 0;
        this.missedPongs = 0;
        this._emitStatus('connected');
        this._startHeartbeat();
      });

      this.ws.addEventListener('message', (ev) => {
        try {
          const msg = JSON.parse(ev.data);
          if (msg.type === 'pong') {
            this.missedPongs = 0;
            return;
          }
          this.onMessage?.(msg);
        } catch (err) {
          console.error('[TalentAI] bad message', err, ev.data);
        }
      });

      this.ws.addEventListener('close', (ev) => {
        this._stopHeartbeat();
        this.ws = null;
        if (ev.code === 4401) {
          this._emitStatus('unauthorized');
          this.closed = true; // don't reconnect if key is bad/revoked
          return;
        }
        this._emitStatus('disconnected');
        if (!this.closed) this._scheduleReconnect();
      });

      this.ws.addEventListener('error', () => {
        // close handler will run next; nothing to do here
      });
    } catch (err) {
      console.error('[TalentAI] WS open failed', err);
      this._scheduleReconnect();
    }
  }

  _scheduleReconnect() {
    if (this.reconnectTimer) return;
    const attempts = this.reconnectAttempts++;
    const base = Math.min(30_000, 1000 * Math.pow(2, Math.min(attempts, 5)));
    const jitter = Math.floor(Math.random() * 500);
    const delay = base + jitter;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.closed) this._open();
    }, delay);
  }

  _startHeartbeat() {
    this._stopHeartbeat();
    this.pingTimer = setInterval(() => {
      if (this.ws?.readyState !== WebSocket.OPEN) return;
      this.missedPongs += 1;
      if (this.missedPongs >= 2) {
        console.warn('[TalentAI] missed 2 pongs — closing');
        try { this.ws.close(4000, 'heartbeat_timeout'); } catch (_) {}
        return;
      }
      this.send({ type: 'ping' });
    }, 30_000);
  }

  _stopHeartbeat() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.pongTimer) clearTimeout(this.pongTimer);
    this.pingTimer = null;
    this.pongTimer = null;
  }

  send(obj) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj));
      return true;
    }
    return false;
  }

  close() {
    this.closed = true;
    this._stopHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    try { this.ws?.close(1000, 'client_close'); } catch (_) {}
    this.ws = null;
    this._emitStatus('disconnected');
  }

  _emitStatus(status) {
    try { this.onStatus?.(status); } catch (_) {}
  }
}
