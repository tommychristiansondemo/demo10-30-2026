import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { api } from '../api/client';
import { live } from '../api/live';
import type { ToolTrace } from '../api/types';
import { Icon } from './ui';

interface Msg { role: 'user' | 'assistant'; text: string; tools: ToolTrace[]; streaming?: boolean; error?: string; meta?: string }

const SUGGESTIONS = [
  'What is the current state of the grid? Flag anything unusual.',
  'Forecast load for the next 24 hours. When is the peak and how confident are you?',
  'Which hours last week had the highest system lambda, and what was PRC then?',
  'Summarize all open alerts and recommend what an operator should look at first.',
  'What does PRC mean, and what happens operationally when it falls below 2,500 MW?',
  'Compare average HB_WEST and HB_HOUSTON prices by hour of day over the last 7 days.',
];

const TOOL_LABEL: Record<string, string> = {
  get_grid_snapshot: 'Reading live grid snapshot',
  get_recent_metrics: 'Fetching recent metrics',
  query_grid_data: 'Running SQL on the data lake',
  forecast_load: 'Running load forecast',
  detect_anomalies: 'Scanning for anomalies',
  search_knowledge_base: 'Searching knowledge base',
  list_alerts: 'Listing alerts',
};

export function ChatPanel({ sessionId: initialSession, initialMessages, onSession }: { sessionId?: string; initialMessages?: Msg[]; onSession?: (id: string) => void }) {
  const [sessionId, setSessionId] = useState(initialSession);
  const [messages, setMessages] = useState<Msg[]>(initialMessages ?? []);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const pending = useRef<string>();
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => { setSessionId(initialSession); setMessages(initialMessages ?? []); }, [initialSession, initialMessages]);
  useEffect(() => { logRef.current?.scrollTo({ top: logRef.current.scrollHeight }); }, [messages]);

  const patchLast = (fn: (m: Msg) => Msg) => setMessages((ms) => [...ms.slice(0, -1), fn(ms[ms.length - 1])]);

  useEffect(() => live.subscribe((msg) => {
    if (!msg.requestId || msg.requestId !== pending.current) return;
    switch (msg.type) {
      case 'chat.delta': patchLast((m) => ({ ...m, text: m.text + msg.text })); break;
      case 'chat.reset': patchLast((m) => ({ ...m, text: '', meta: msg.reason })); break;
      case 'chat.tool':
        patchLast((m) => {
          const tools = m.tools.filter((t) => t.id !== msg.id);
          const prev = m.tools.find((t) => t.id === msg.id);
          return { ...m, tools: [...tools, { ...prev, ...msg }].sort((a, b) => m.tools.findIndex((t) => t.id === a.id) - m.tools.findIndex((t) => t.id === b.id)) };
        });
        break;
      case 'chat.done':
        patchLast((m) => ({ ...m, text: msg.text || m.text, streaming: false, meta: `${msg.model} · ${msg.usage.inputTokens.toLocaleString()} in / ${msg.usage.outputTokens.toLocaleString()} out tokens` }));
        setSessionId(msg.sessionId);
        onSession?.(msg.sessionId);
        pending.current = undefined;
        setBusy(false);
        break;
      case 'chat.error':
        patchLast((m) => ({ ...m, streaming: false, error: msg.message }));
        pending.current = undefined;
        setBusy(false);
        break;
    }
  }), [onSession]);

  async function send(text: string) {
    const message = text.trim();
    if (!message || busy) return;
    setInput('');
    setBusy(true);
    setMessages((ms) => [...ms, { role: 'user', text: message, tools: [] }, { role: 'assistant', text: '', tools: [], streaming: true }]);
    const requestId = crypto.randomUUID();
    pending.current = requestId;
    if (live.send({ action: 'chat', requestId, sessionId, message })) return;
    // WebSocket unavailable: fall back to the synchronous REST endpoint (no streaming).
    try {
      const r = await api.post<{ sessionId: string; answer: string; model: string; tools: ToolTrace[] }>('/v1/ai/ask', { message, sessionId });
      patchLast((m) => ({ ...m, text: r.answer, tools: r.tools.map((t) => ({ ...t, status: t.ok ? 'done' : 'error' })), streaming: false, meta: `${r.model} · via REST` }));
      setSessionId(r.sessionId);
      onSession?.(r.sessionId);
    } catch (e) {
      patchLast((m) => ({ ...m, streaming: false, error: (e as Error).message }));
    } finally {
      pending.current = undefined;
      setBusy(false);
    }
  }

  return (
    <div className="chat">
      <div className="chat-log" ref={logRef} aria-live="polite">
        {messages.length === 0 && (
          <div className="msg assistant">
            <div className="bubble">
              <p><strong>Ask about the grid.</strong> I can read live and historical data, run SQL on the lake, forecast load, scan for anomalies and search operating documents. All data here is synthetic.</p>
            </div>
            <div className="suggestions">
              {SUGGESTIONS.map((s) => <button key={s} className="small" onClick={() => void send(s)}>{s}</button>)}
            </div>
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`msg ${m.role}`}>
            {m.tools.map((t) => (
              <div key={t.id} className="tool-chip">
                <span className={t.status === 'error' ? 'sev-CRITICAL' : t.status === 'done' ? 'sev-GOOD' : 'sev-INFO'}>
                  <Icon name={t.status === 'error' ? 'critical' : t.status === 'done' ? 'good' : 'refresh'} size={14} />
                </span>
                <details>
                  <summary>
                    <span className="name">{t.name}</span> · {t.status === 'running' ? `${TOOL_LABEL[t.name] ?? 'Running'}…` : t.summary}
                    {t.durationMs !== undefined && <span className="note"> ({(t.durationMs / 1000).toFixed(1)}s)</span>}
                  </summary>
                  {t.input !== undefined && <pre>{typeof (t.input as any)?.sql === 'string' ? (t.input as any).sql : JSON.stringify(t.input, null, 2)}</pre>}
                </details>
              </div>
            ))}
            {(m.text || m.role === 'user' || m.streaming) && (
              <div className={`bubble${m.streaming && !m.text ? ' cursor' : ''}`}>
                {m.role === 'assistant' ? <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.text}</ReactMarkdown> : m.text}
                {m.streaming && m.text && <span className="cursor" />}
              </div>
            )}
            {m.error && <div className="error-box">{m.error}</div>}
            {m.meta && !m.streaming && <span className="note">{m.meta}</span>}
          </div>
        ))}
      </div>
      <form className="chat-input" onSubmit={(e) => { e.preventDefault(); void send(input); }}>
        <textarea
          aria-label="Message the GridSight assistant"
          placeholder="Ask about load, reserves, prices, alerts, procedures…"
          value={input}
          rows={2}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(input); } }}
        />
        <button className="primary" disabled={busy || !input.trim()} aria-label="Send"><Icon name="send" /></button>
      </form>
    </div>
  );
}
