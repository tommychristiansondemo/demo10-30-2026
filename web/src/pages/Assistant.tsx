import { useCallback, useState } from 'react';
import { api } from '../api/client';
import type { ToolTrace } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { ChatPanel } from '../components/ChatPanel';
import { Card, ErrorBox } from '../components/ui';
import { ago } from '../lib/format';
import { useAsync } from '../lib/hooks';

interface SessionMeta { sessionId: string; title: string; updatedAt: string; turns: number; model: string }
interface SessionDetail extends Omit<SessionMeta, 'turns'> { turns: { user: string; assistant: string; tools: ToolTrace[] }[] }

export function Assistant() {
  const { me } = useAuth();
  const sessions = useAsync(() => api.get<{ sessions: SessionMeta[] }>('/v1/ai/sessions'), []);
  const [active, setActive] = useState<{ id?: string; messages?: any[] }>({});
  const [loadErr, setLoadErr] = useState<Error>();

  const open = async (id: string) => {
    setLoadErr(undefined);
    try {
      const s = await api.get<SessionDetail>(`/v1/ai/sessions/${id}`);
      const messages = s.turns.flatMap((t) => [
        { role: 'user', text: t.user, tools: [] },
        { role: 'assistant', text: t.assistant, tools: (t.tools ?? []).map((x: ToolTrace) => ({ ...x, status: x.ok ? 'done' : 'error' })) },
      ]);
      setActive({ id, messages });
    } catch (e) { setLoadErr(e as Error); }
  };
  const onSession = useCallback(() => void sessions.reload(), [sessions]);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>AI assistant</h1>
          <p>Claude on Amazon Bedrock with grid tools: live snapshot, metrics, SQL over the lake, load forecasting, anomaly detection, alerts and RAG over operating documents. Model: <span className="mono">{me?.config.ai.chatModelId}</span>, prompt profile: {me?.config.ai.promptVariant}.</p>
        </div>
      </div>
      <div className="grid" style={{ gridTemplateColumns: 'minmax(220px, 280px) minmax(0, 1fr)', alignItems: 'start' }}>
        <Card title="Conversations" actions={<button className="small" onClick={() => setActive({})}>New chat</button>} flush>
          {sessions.error && <ErrorBox error={sessions.error} />}
          <div className="list">
            {(sessions.data?.sessions ?? []).map((s) => (
              <button key={s.sessionId} className="ghost list-item" style={{ textAlign: 'left', width: '100%', borderRadius: 0, background: active.id === s.sessionId ? 'var(--accent-soft)' : undefined }} onClick={() => void open(s.sessionId)}>
                <div>
                  <div className="title" style={{ fontWeight: 500 }}>{s.title}</div>
                  <div className="meta">{s.turns} turns · {ago(s.updatedAt)}</div>
                </div>
              </button>
            ))}
            {sessions.data?.sessions.length === 0 && <div className="empty">No conversations yet</div>}
          </div>
        </Card>
        <section className="card" style={{ height: 'calc(100vh - 190px)', minHeight: 480, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          {loadErr && <ErrorBox error={loadErr} />}
          <ChatPanel sessionId={active.id} initialMessages={active.messages} onSession={onSession} />
        </section>
      </div>
    </>
  );
}
