/**
 * Claude in Amazon Bedrock is served by two endpoints, and which one a model lives on depends on the
 * model generation and on the account's access:
 *   - Cross-region inference profiles (`us.anthropic.…`, `global.anthropic.…`) go through the Bedrock
 *     runtime (InvokeModel) via `AnthropicBedrock`. This is how Opus 4.6, Sonnet 4.6 and older are reached.
 *   - Bare `anthropic.claude-…` IDs (Opus 4.7 and newer) go through the Bedrock Mantle endpoint via
 *     `AnthropicBedrockMantle`.
 * Request options also differ by model, so the agent asks `requestOptions` instead of hard-coding them.
 */
import AnthropicBedrock, { AnthropicBedrockMantle } from '@anthropic-ai/bedrock-sdk';
import type Anthropic from '@anthropic-ai/sdk';
import type { AppConfig } from '../lib/config.js';
import { env } from '../lib/env.js';

const RUNTIME_API_VERSION = 'bedrock-2023-05-31';
const GEO_PREFIX = /^(us|global|eu|apac|jp|au|us-gov)\./;
const clientOptions = () => ({ awsRegion: env.region, maxRetries: 2, timeout: 120_000 });

let runtime: AnthropicBedrock | undefined;
let mantle: AnthropicBedrockMantle | undefined;

export type Endpoint = 'runtime' | 'mantle';

export function endpointFor(model: string): Endpoint {
  return GEO_PREFIX.test(model) ? 'runtime' : 'mantle';
}

/** The SDK client for a model. Both expose the same `messages` resource. */
export function clientFor(model: string): Pick<Anthropic, 'messages'> {
  if (endpointFor(model) === 'runtime') {
    // API version override: SDK 1.x sends 2026-10-21, which Bedrock accepts only for Claude 4.7+.
    // The runtime endpoint serves the older models, so it stays on the Bedrock 2023-05-31 version
    // (the client copies this header into the body's `anthropic_version`).
    runtime ??= new AnthropicBedrock({ ...clientOptions(), defaultHeaders: { 'anthropic-version': RUNTIME_API_VERSION } });
    return runtime as unknown as Pick<Anthropic, 'messages'>;
  }
  return (mantle ??= new AnthropicBedrockMantle(clientOptions())) as unknown as Pick<Anthropic, 'messages'>;
}

/** Opus/Sonnet 4.6 and every later generation support adaptive thinking and the effort parameter. */
export function supportsAdaptive(model: string): boolean {
  return /claude-(opus|sonnet)-4-[6-9]|claude-[a-z]+-[5-9]/.test(model);
}

/** `xhigh` effort arrived with Opus 4.7; earlier adaptive models top out at `high` below `max`. */
function effortFor(model: string, effort: AppConfig['ai']['effort']): AppConfig['ai']['effort'] {
  return effort === 'xhigh' && /claude-(opus|sonnet)-4-6/.test(model) ? 'high' : effort;
}

type SystemParam = Anthropic.MessageCreateParams['system'];

/**
 * Model-specific request fields: thinking/effort when supported, plus prompt caching. The Mantle
 * endpoint takes top-level automatic caching; the runtime endpoint rejects it, so the system prompt
 * (which, with the tools before it, is the large static prefix) gets an explicit breakpoint instead.
 */
export function requestOptions(
  model: string,
  system: string,
  effort: AppConfig['ai']['effort'],
  format?: Anthropic.JSONOutputFormat,
): { system: SystemParam; thinking?: Anthropic.ThinkingConfigParam; output_config?: Anthropic.OutputConfig; cache_control?: Anthropic.CacheControlEphemeral } {
  const adaptive = supportsAdaptive(model);
  const outputConfig: Anthropic.OutputConfig = { ...(adaptive ? { effort: effortFor(model, effort) } : {}), ...(format ? { format } : {}) };
  return {
    ...(endpointFor(model) === 'mantle'
      ? { system, cache_control: { type: 'ephemeral' as const } }
      : { system: [{ type: 'text' as const, text: system, cache_control: { type: 'ephemeral' as const } }] }),
    ...(adaptive ? { thinking: { type: 'adaptive' as const } } : {}),
    ...(Object.keys(outputConfig).length ? { output_config: outputConfig } : {}),
  };
}
