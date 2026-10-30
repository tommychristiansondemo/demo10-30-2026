/**
 * GridSight AI TypeScript SDK.
 *
 *   const token = await GridSightClient.login({ region, clientId, username, password });
 *   const gs = new GridSightClient({ baseUrl: 'https://api.gridsight.awsteach.com', token });
 *   const now = await gs.grid.current();
 *   for await (const ev of gs.chat.stream('What is PRC right now?')) if (ev.type === 'chat.delta') process.stdout.write(ev.text);
 */

export interface GridSightOptions {
  baseUrl: string;
  /** Cognito access token, or a function returning a fresh one. */
  token: string | (() => Promise<string>);
  fetch?: typeof fetch;
}

export class GridSightError extends Error {
  constructor(public status: number, public code: string, message: string, public requestId?: string) {
    super(message);
  }
}

export type Severity = 'INFO' | 'WARNING' | 'CRITICAL';
export type AlertStatus = 'OPEN' | 'ACKNOWLEDGED' | 'RESOLVED';

export interface GridInterval {
  ts: string;
  load_mw: number;
  load_forecast_mw: number;
  net_load_mw: number;
  gen: Record<'gas' | 'coal' | 'nuclear' | 'wind' | 'solar' | 'storage' | 'hydro' | 'other', number>;
  gen_total_mw: number;
  freq: { mean_hz: number; min_hz: number; max_hz: number };
  reserves: { prc_mw: number; regup_mw: number; regdown_mw: number; rrs_mw: number; ecrs_mw: number; nonspin_mw: number };
  system_lambda: number;
  hubs: Record<string, { lmp: number; energy: number; congestion: number; loss: number }>;
  zones: Record<string, { load_mw: number; temp_f: number }>;
  active_events: string[];
  data_quality: 'GOOD' | 'STALE';
  [k: string]: unknown;
}

export interface Alert { id: string; ts: string; type: string; severity: Severity; status: AlertStatus; title: string; message: string; [k: string]: unknown }
export interface QueryResult { sql: string; columns: { name: string; type: string }[]; rows: Record<string, string | number | null>[]; truncated: boolean; stats: { bytesScanned: number; executionMs: number; queryExecutionId: string } }

export type ChatEvent =
  | { type: 'chat.accepted'; requestId: string }
  | { type: 'chat.delta'; requestId: string; text: string }
  | { type: 'chat.tool'; requestId: string; status: 'running' | 'done' | 'error'; id: string; name: string; input?: unknown; summary?: string; durationMs?: number }
  | { type: 'chat.reset'; requestId: string; reason: string }
  | { type: 'chat.done'; requestId: string; sessionId: string; turn: number; text: string; model: string; usage: Record<string, number> }
  | { type: 'chat.error'; requestId: string; code: string; message: string };

export class GridSightClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: GridSightOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.fetchImpl = opts.fetch ?? fetch;
  }

  /** Mint an access token with USER_PASSWORD_AUTH against the GridSight CLI app client. */
  static async login(p: { region: string; clientId: string; username: string; password: string }): Promise<string> {
    const res = await fetch(`https://cognito-idp.${p.region}.amazonaws.com/`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': 'AWSCognitoIdentityProviderService.InitiateAuth' },
      body: JSON.stringify({ AuthFlow: 'USER_PASSWORD_AUTH', ClientId: p.clientId, AuthParameters: { USERNAME: p.username, PASSWORD: p.password } }),
    });
    const body = (await res.json()) as any;
    if (!res.ok) throw new GridSightError(res.status, body.__type ?? 'auth_error', body.message ?? 'Authentication failed');
    if (body.ChallengeName) throw new GridSightError(400, body.ChallengeName, `Complete the ${body.ChallengeName} challenge in the web app first`);
    return body.AuthenticationResult.AccessToken as string;
  }

  private async token(): Promise<string> {
    return typeof this.opts.token === 'function' ? this.opts.token() : this.opts.token;
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: { authorization: `Bearer ${await this.token()}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    const data = text ? JSON.parse(text) : undefined;
    if (!res.ok) throw new GridSightError(res.status, data?.error?.code ?? 'http_error', data?.error?.message ?? res.statusText, data?.error?.requestId);
    return data as T;
  }

  readonly grid = {
    current: () => this.request<GridInterval & { derived: Record<string, unknown> }>('GET', '/v1/grid/current'),
    series: (p: { start?: Date; end?: Date; resolution?: '5m' | '1h' } = {}) => {
      const q = new URLSearchParams();
      if (p.start) q.set('start', p.start.toISOString());
      if (p.end) q.set('end', p.end.toISOString());
      if (p.resolution) q.set('resolution', p.resolution);
      return this.request<{ resolution: string; points: GridInterval[] }>('GET', `/v1/grid/series?${q}`);
    },
    events: () => this.request<{ events: unknown[] }>('GET', '/v1/grid/events'),
  };

  readonly analytics = {
    forecast: (hours = 48) => this.request<{ points: { ts: string; forecast_mw: number; p10_mw: number; p90_mw: number }[]; backtest: { mape_pct: number; naive_mape_pct: number } }>('GET', `/v1/forecast/load?hours=${hours}`),
    anomalies: (hours = 24) => this.request<{ anomalies: unknown[] }>('GET', `/v1/anomalies?hours=${hours}`),
  };

  readonly alerts = {
    list: (status: AlertStatus = 'OPEN', limit = 100) => this.request<{ alerts: Alert[] }>('GET', `/v1/alerts?status=${status}&limit=${limit}`).then((r) => r.alerts),
    acknowledge: (id: string, note?: string) => this.request<Alert>('POST', `/v1/alerts/${encodeURIComponent(id)}/ack`, { note }),
    resolve: (id: string, note?: string) => this.request<Alert>('POST', `/v1/alerts/${encodeURIComponent(id)}/resolve`, { note }),
    create: (a: { title: string; message: string; severity: Severity; zone?: string }) => this.request<Alert>('POST', '/v1/alerts', a),
  };

  readonly query = {
    sql: (sql: string, maxRows = 1000) => this.request<QueryResult>('POST', '/v1/query/sql', { sql, maxRows }),
    ask: (question: string, execute = true) => this.request<{ sql: string; explanation: string; result?: QueryResult; error?: string }>('POST', '/v1/ai/sql', { question, execute }),
  };

  readonly ai = {
    ask: (message: string, sessionId?: string) => this.request<{ sessionId: string; answer: string; model: string; tools: unknown[] }>('POST', '/v1/ai/ask', { message, sessionId }),
    knowledge: (q: string, limit = 5) => this.request<{ passages: { source: string; score: number; text: string }[] }>('GET', `/v1/kb/search?q=${encodeURIComponent(q)}&limit=${limit}`),
  };

  readonly chat = {
    /** Stream an AI turn over WebSocket. Yields events until chat.done or chat.error. */
    stream: (message: string, opts: { sessionId?: string; timeoutMs?: number } = {}) => this.streamChat(message, opts),
  };

  private async *streamChat(message: string, opts: { sessionId?: string; timeoutMs?: number }): AsyncGenerator<ChatEvent> {
    const wsUrl = `${this.baseUrl.replace(/^http/, 'ws')}/ws?token=${encodeURIComponent(await this.token())}`;
    const ws = new WebSocket(wsUrl);
    const requestId = crypto.randomUUID();
    const queue: ChatEvent[] = [];
    let wake: (() => void) | undefined;
    let finished = false;
    let failure: Error | undefined;
    const push = () => { wake?.(); wake = undefined; };

    ws.onopen = () => ws.send(JSON.stringify({ action: 'chat', requestId, message, sessionId: opts.sessionId }));
    ws.onmessage = (ev) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.requestId !== requestId) return;
      queue.push(msg);
      if (msg.type === 'chat.done' || msg.type === 'chat.error') finished = true;
      push();
    };
    ws.onerror = () => { failure = new Error('WebSocket error'); push(); };
    ws.onclose = () => { finished = true; push(); };
    const timer = setTimeout(() => { failure = new Error('Chat timed out'); push(); }, opts.timeoutMs ?? 300_000);

    try {
      for (;;) {
        while (queue.length) yield queue.shift()!;
        if (failure) throw failure;
        if (finished) return;
        await new Promise<void>((r) => (wake = r));
      }
    } finally {
      clearTimeout(timer);
      ws.close();
    }
  }
}
