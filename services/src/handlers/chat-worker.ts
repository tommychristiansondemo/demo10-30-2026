/** Runs an agent turn and streams deltas, tool activity and the final result over WebSocket. */
import { chatTurn } from '../ai/chat-session.js';
import type { Role } from '../lib/auth.js';
import { HttpError } from '../lib/http.js';
import { flushMetrics, logger } from '../lib/observability.js';
import { postToConnection } from '../lib/ws.js';

interface WorkerEvent {
  connectionId: string;
  sub: string;
  username?: string;
  role: Role;
  requestId: string;
  sessionId?: string;
  message: string;
  sourceIp?: string;
}

export const handler = async (e: WorkerEvent) => {
  const send = (payload: Record<string, unknown>) => postToConnection(e.connectionId, { requestId: e.requestId, ...payload }).catch((err) => logger.warn('post failed', { err }));

  // Coalesce token deltas into ~100 ms frames to limit PostToConnection calls.
  let buffer = '';
  let timer: NodeJS.Timeout | undefined;
  const flush = async () => {
    if (timer) { clearTimeout(timer); timer = undefined; }
    if (buffer) { const text = buffer; buffer = ''; await send({ type: 'chat.delta', text }); }
  };

  try {
    const result = await chatTurn({
      principal: { sub: e.sub, username: e.username ?? e.sub, email: e.username, groups: [e.role], role: e.role },
      sessionId: e.sessionId,
      message: e.message,
      requestId: e.requestId,
      sourceIp: e.sourceIp,
      channel: 'websocket',
      onEvent: async (ev) => {
        if (ev.type === 'delta') {
          buffer += ev.text;
          timer ??= setTimeout(() => void flush(), 100);
          return;
        }
        await flush();
        if (ev.type === 'reset') await send({ type: 'chat.reset', reason: ev.reason });
        if (ev.type === 'tool_start') await send({ type: 'chat.tool', status: 'running', id: ev.id, name: ev.name, input: ev.input });
        if (ev.type === 'tool_end') await send({ type: 'chat.tool', status: ev.ok ? 'done' : 'error', id: ev.id, name: ev.name, summary: ev.summary, durationMs: ev.durationMs });
      },
    });
    await flush();
    await send({ type: 'chat.done', sessionId: result.sessionId, turn: result.turn, text: result.text, model: result.model, usage: result.usage, tools: result.tools });
  } catch (err) {
    await flush();
    const code = err instanceof HttpError ? err.code : 'internal_error';
    const message = err instanceof HttpError ? err.message : 'The assistant hit an error. Try again, or check the audit log for details.';
    logger.error('chat worker failed', err as Error);
    await send({ type: 'chat.error', code, message });
  } finally {
    flushMetrics();
  }
};
