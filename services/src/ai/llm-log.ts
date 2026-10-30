/**
 * Structured "llm_call" log records: one per Claude request, with the prompt, Claude's reasoning
 * (thinking blocks), tool calls, the response and token usage. The Course Insights app queries these
 * with CloudWatch Logs Insights (`filter message = "llm_call"`), so the shape is a contract: keep the
 * field names in sync with insights/src/lib/logs.ts.
 */
import type Anthropic from '@anthropic-ai/sdk';
import { logger } from '../lib/observability.js';

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}… [${s.length - n} more chars]` : s);

export interface LlmCallContext {
  app: 'gridsight' | 'insights';
  purpose: string;
  model: string;
  /** What the model was asked on this call (the user's text, or a note such as "tool results"). */
  prompt: string;
  role?: string;
  requestId?: string;
  sessionId?: string;
  iteration?: number;
  startedAt: number;
}

export function logLlmCall(ctx: LlmCallContext, msg: Anthropic.Message): void {
  const thinking = msg.content
    .filter((b): b is Anthropic.ThinkingBlock => b.type === 'thinking')
    .map((b) => b.thinking)
    .join('\n\n');
  const redactedThinking = msg.content.some((b) => b.type === 'redacted_thinking');
  const text = msg.content.filter((b): b is Anthropic.TextBlock => b.type === 'text').map((b) => b.text).join('');
  const toolCalls = msg.content
    .filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use')
    .map((b) => ({ name: b.name, input: clip(JSON.stringify(b.input), 1500) }));
  logger.info('llm_call', {
    llm: {
      app: ctx.app,
      purpose: ctx.purpose,
      model: ctx.model,
      role: ctx.role,
      requestId: ctx.requestId,
      sessionId: ctx.sessionId,
      iteration: ctx.iteration ?? 1,
      latencyMs: Date.now() - ctx.startedAt,
      stopReason: msg.stop_reason,
      prompt: clip(ctx.prompt, 4000),
      thinking: thinking ? clip(thinking, 12000) : redactedThinking ? '[redacted by the model provider]' : '',
      response: clip(text, 6000),
      toolCalls,
      usage: {
        input: msg.usage.input_tokens,
        output: msg.usage.output_tokens,
        cacheRead: msg.usage.cache_read_input_tokens ?? 0,
        cacheWrite: msg.usage.cache_creation_input_tokens ?? 0,
      },
    },
  });
}
