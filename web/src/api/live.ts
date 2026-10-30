/**
 * WebSocket client for live grid updates, alert notifications and streaming AI chat.
 * Connects through CloudFront (wss://<app>/ws) and falls back to the direct API Gateway URL.
 */
import { accessToken } from '../auth/amplify';
import { config } from '../lib/config';

export type LiveStatus = 'connecting' | 'open' | 'closed';
type Listener = (msg: any) => void;

class LiveSocket {
  private ws?: WebSocket;
  private listeners = new Set<Listener>();
  private statusListeners = new Set<(s: LiveStatus) => void>();
  private attempt = 0;
  private useDirect = false;
  private stopped = true;
  private pingTimer?: number;
  status: LiveStatus = 'closed';

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    void this.connect();
  }

  stop() {
    this.stopped = true;
    window.clearInterval(this.pingTimer);
    this.ws?.close();
  }

  private setStatus(s: LiveStatus) {
    this.status = s;
    this.statusListeners.forEach((l) => l(s));
  }

  private async connect() {
    if (this.stopped) return;
    this.setStatus('connecting');
    let token: string;
    try { token = await accessToken(); } catch { this.setStatus('closed'); return; }
    const cfg = config();
    const base = this.useDirect && cfg.wsUrlDirect ? cfg.wsUrlDirect : cfg.wsUrl;
    const ws = new WebSocket(`${base}?token=${encodeURIComponent(token)}`);
    this.ws = ws;
    let opened = false;
    ws.onopen = () => {
      opened = true;
      this.attempt = 0;
      this.setStatus('open');
      window.clearInterval(this.pingTimer);
      // API Gateway closes idle connections after 10 minutes.
      this.pingTimer = window.setInterval(() => this.send({ action: 'ping' }), 5 * 60_000);
    };
    ws.onmessage = (ev) => {
      try { const msg = JSON.parse(ev.data); this.listeners.forEach((l) => l(msg)); } catch { /* ignore malformed frames */ }
    };
    ws.onclose = () => {
      window.clearInterval(this.pingTimer);
      this.setStatus('closed');
      if (!opened && !this.useDirect && cfg.wsUrlDirect) this.useDirect = true;
      if (this.stopped) return;
      const delay = Math.min(30_000, 1000 * 2 ** this.attempt++) + Math.random() * 500;
      window.setTimeout(() => void this.connect(), delay);
    };
  }

  send(payload: unknown): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(payload));
    return true;
  }

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  onStatus(l: (s: LiveStatus) => void): () => void {
    this.statusListeners.add(l);
    l(this.status);
    return () => this.statusListeners.delete(l);
  }
}

export const live = new LiveSocket();
