/** One conversational turn: load history → run agent → persist turn → audit. */
import type Anthropic from '@anthropic-ai/sdk';
import { randomUUID } from 'node:crypto';
import type { Principal } from '../lib/auth.js';
import { getConfig } from '../lib/config.js';
import { HttpError } from '../lib/http.js';
import { metrics, MetricUnit } from '../lib/observability.js';
import { appendTurn, getSessionMeta, loadTurns, writeAudit } from '../lib/repo.js';
import { runAgent, type AgentEvent, type AgentResult } from './agent.js';

export interface ChatTurnInput {
  principal: Principal;
  sessionId?: string;
  message: string;
  requestId: string;
  sourceIp?: string;
  channel: 'websocket' | 'rest';
  maxIterations?: number;
  onEvent?: (e: AgentEvent) => void | Promise<void>;
}

export async function chatTurn(input: ChatTurnInput): Promise<AgentResult & { sessionId: string; turn: number }> {
  const { config } = await getConfig();
  if (!config.ai.enabled || !config.features.aiChat) throw new HttpError(503, 'ai_disabled', 'The AI assistant is disabled by an administrator');

  const sessionId = input.sessionId ?? randomUUID();
  let history: Anthropic.MessageParam[] = [];
  let turnNo = 1;
  if (input.sessionId) {
    const meta = await getSessionMeta(input.principal.sub, input.sessionId);
    if (!meta) throw new HttpError(404, 'session_not_found', 'Chat session not found');
    if (meta.turns >= config.ai.maxSessionTurns) {
      throw new HttpError(409, 'session_full', `This conversation reached ${config.ai.maxSessionTurns} turns. Start a new chat.`);
    }
    const turns = await loadTurns(sessionId);
    history = turns.flatMap((t) => t.messages as Anthropic.MessageParam[]);
    turnNo = turns.length + 1;
  }

  const started = Date.now();
  try {
    const result = await runAgent({
      history,
      userText: input.message,
      config,
      principal: input.principal,
      onEvent: input.onEvent,
      maxIterations: input.maxIterations,
      trace: { requestId: input.requestId, sessionId },
    });
    await appendTurn(
      input.principal.sub,
      sessionId,
      {
        turn: turnNo,
        at: new Date().toISOString(),
        messages: result.newMessages,
        display: { user: input.message, assistant: result.text, tools: result.tools },
      },
      input.message.slice(0, 80),
      result.model,
    );
    await writeAudit({
      actor: input.principal.sub,
      actorEmail: input.principal.email,
      role: input.principal.role,
      action: 'ai.chat',
      resource: `session/${sessionId}`,
      outcome: 'SUCCESS',
      requestId: input.requestId,
      sourceIp: input.sourceIp,
      details: {
        channel: input.channel,
        turn: turnNo,
        model: result.model,
        prompt: input.message.slice(0, 2000),
        response_chars: result.text.length,
        tools: result.tools.map((t) => ({ name: t.name, ok: t.ok, summary: t.summary.slice(0, 300), ms: t.durationMs })),
        usage: result.usage,
        iterations: result.iterations,
        latency_ms: Date.now() - started,
      },
    });
    metrics.addMetric('ChatRequests', MetricUnit.Count, 1);
    metrics.addMetric('ChatLatency', MetricUnit.Milliseconds, Date.now() - started);
    return { ...result, sessionId, turn: turnNo };
  } catch (err) {
    metrics.addMetric('ChatErrors', MetricUnit.Count, 1);
    await writeAudit({
      actor: input.principal.sub,
      actorEmail: input.principal.email,
      role: input.principal.role,
      action: 'ai.chat',
      resource: `session/${sessionId}`,
      outcome: 'ERROR',
      requestId: input.requestId,
      details: { channel: input.channel, prompt: input.message.slice(0, 2000), error: (err as Error).message },
    });
    throw err;
  }
}
