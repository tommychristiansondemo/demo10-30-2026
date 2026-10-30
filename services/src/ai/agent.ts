/**
 * GridSight agent: a manual tool-use loop over Claude in Amazon Bedrock (Messages API; see models.ts
 * for which Bedrock endpoint serves which model). We own the loop so we can stream text to WebSocket clients, emit a
 * tool trace for the UI and audit log, enforce per-request iteration limits, and fall back to a
 * second model if the primary refuses.
 */
import type Anthropic from '@anthropic-ai/sdk';
import type { AppConfig } from '../lib/config.js';
import type { Principal } from '../lib/auth.js';
import { env } from '../lib/env.js';
import { logger, metrics, MetricUnit } from '../lib/observability.js';
import { logLlmCall } from './llm-log.js';
import { clientFor, requestOptions } from './models.js';
import { systemPrompt } from './prompts.js';
import { enabledTools, executeTool, type ToolExecution } from './tools.js';

export type AgentEvent =
  | { type: 'delta'; text: string }
  | { type: 'reset'; reason: string }
  | { type: 'tool_start'; id: string; name: string; input: unknown }
  | { type: 'tool_end'; id: string; name: string; ok: boolean; summary: string; durationMs: number };

export interface AgentResult {
  text: string;
  model: string;
  /** Messages appended this turn (user + assistant + tool results), stored verbatim for replay. */
  newMessages: Anthropic.MessageParam[];
  tools: Omit<ToolExecution, 'content'>[];
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number };
  stopReason: string;
  iterations: number;
}

export interface RunAgentOptions {
  history: Anthropic.MessageParam[];
  userText: string;
  config: AppConfig;
  principal: Principal;
  onEvent?: (e: AgentEvent) => void | Promise<void>;
  /** Cap iterations below the configured max (e.g. for the synchronous REST endpoint). */
  maxIterations?: number;
  /** Correlation IDs for the llm_call log records. */
  trace?: { requestId?: string; sessionId?: string };
}

export async function runAgent(opts: RunAgentOptions): Promise<AgentResult> {
  const { config, principal } = opts;
  const emit = async (e: AgentEvent) => { await opts.onEvent?.(e); };
  const system = systemPrompt(config, env.glueDatabase);
  const tools = enabledTools(config);
  const userMessage: Anthropic.MessageParam = {
    role: 'user',
    content: `[Context: current time ${new Date().toISOString()} UTC; user role ${principal.role}]\n\n${opts.userText}`,
  };
  const messages: Anthropic.MessageParam[] = [...opts.history, userMessage];
  const newMessages: Anthropic.MessageParam[] = [userMessage];
  const trace: AgentResult['tools'] = [];
  const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  const maxIterations = Math.min(opts.maxIterations ?? Infinity, config.ai.maxToolIterations);

  let model = config.ai.chatModelId;
  let finalText = '';
  let stopReason = 'end_turn';
  let iterations = 0;

  for (let forceAnswer = false; ; ) {
    iterations++;
    const startedAt = Date.now();
    const stream = clientFor(model).messages.stream({
      model,
      max_tokens: config.ai.maxOutputTokens,
      ...requestOptions(model, system, config.ai.effort),
      messages,
      tools,
      tool_choice: forceAnswer ? { type: 'none' } : { type: 'auto' },
    });
    stream.on('text', (delta) => { void emit({ type: 'delta', text: delta }); });
    const msg = await stream.finalMessage();
    logLlmCall(
      {
        app: 'gridsight',
        purpose: forceAnswer ? 'chat-final-answer' : 'chat',
        model,
        prompt: iterations === 1 ? opts.userText : `(continuing after tool results; original question: ${opts.userText})`,
        role: principal.role,
        requestId: opts.trace?.requestId,
        sessionId: opts.trace?.sessionId,
        iteration: iterations,
        startedAt,
      },
      msg,
    );

    usage.inputTokens += msg.usage.input_tokens;
    usage.outputTokens += msg.usage.output_tokens;
    usage.cacheReadTokens += msg.usage.cache_read_input_tokens ?? 0;
    usage.cacheWriteTokens += msg.usage.cache_creation_input_tokens ?? 0;
    stopReason = msg.stop_reason ?? 'end_turn';

    if (msg.stop_reason === 'refusal') {
      logger.warn('model refusal', { model, category: msg.stop_details?.category });
      if (model !== config.ai.fallbackModelId) {
        // Client-side fallback: retry the same request on the fallback model.
        model = config.ai.fallbackModelId;
        await emit({ type: 'reset', reason: 'Retrying with fallback model' });
        continue;
      }
      finalText = 'I can’t help with that request. Try rephrasing it around grid operations or data analysis.';
      await emit({ type: 'delta', text: finalText });
      newMessages.push({ role: 'assistant', content: [{ type: 'text', text: finalText }] });
      break;
    }

    // Append the full assistant content (including thinking blocks) unchanged: required for replay.
    const assistant: Anthropic.MessageParam = { role: 'assistant', content: msg.content };
    messages.push(assistant);
    newMessages.push(assistant);
    finalText = msg.content.filter((b): b is Anthropic.TextBlock => b.type === 'text').map((b) => b.text).join('');

    if (msg.stop_reason !== 'tool_use') break;

    const uses = msg.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
    const results = await Promise.all(
      uses.map(async (u) => {
        await emit({ type: 'tool_start', id: u.id, name: u.name, input: u.input });
        const r = await executeTool(u.id, u.name, u.input, { config, principal });
        await emit({ type: 'tool_end', id: u.id, name: u.name, ok: r.ok, summary: r.summary, durationMs: r.durationMs });
        metrics.addMetric(`Tool_${u.name}`, MetricUnit.Count, 1);
        if (!r.ok) metrics.addMetric('ToolErrors', MetricUnit.Count, 1);
        return r;
      }),
    );
    for (const { content: _c, ...rest } of results) trace.push(rest);
    // All tool results go back in a single user message.
    const toolResults: Anthropic.MessageParam = {
      role: 'user',
      content: results.map((r) => ({ type: 'tool_result' as const, tool_use_id: r.id, content: r.content, is_error: !r.ok })),
    };
    messages.push(toolResults);
    newMessages.push(toolResults);

    if (forceAnswer) break;
    if (iterations >= maxIterations) forceAnswer = true; // one last call with tools disabled to summarize
  }

  metrics.addMetric('ChatInputTokens', MetricUnit.Count, usage.inputTokens);
  metrics.addMetric('ChatOutputTokens', MetricUnit.Count, usage.outputTokens);
  metrics.addMetric('ChatCacheReadTokens', MetricUnit.Count, usage.cacheReadTokens);
  return { text: finalText, model, newMessages, tools: trace, usage, stopReason, iterations };
}

/** Natural language → SQL using structured output so the response is always parseable. */
export async function generateSql(question: string, config: AppConfig, system: string): Promise<{ sql: string; explanation: string }> {
  const model = config.ai.sqlModelId;
  const startedAt = Date.now();
  const msg = await clientFor(model).messages.create({
    model,
    max_tokens: 4000,
    ...requestOptions(model, system, 'low', {
      type: 'json_schema',
      schema: {
        type: 'object',
        properties: {
          sql: { type: 'string', description: 'A single Athena SELECT statement' },
          explanation: { type: 'string', description: 'One or two sentences explaining the query' },
        },
        required: ['sql', 'explanation'],
        additionalProperties: false,
      },
    }),
    messages: [{ role: 'user', content: `Today is ${new Date().toISOString().slice(0, 10)} (UTC).\n\nQuestion: ${question}` }],
  });
  logLlmCall({ app: 'gridsight', purpose: 'nl-to-sql', model, prompt: question, startedAt }, msg);
  if (msg.stop_reason === 'refusal') throw new Error('The model declined to generate SQL for this question');
  const text = msg.content.filter((b): b is Anthropic.TextBlock => b.type === 'text').map((b) => b.text).join('');
  const parsed = JSON.parse(text) as { sql: string; explanation: string };
  return parsed;
}
