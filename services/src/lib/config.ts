/**
 * Runtime configuration & feature flags, stored as JSON in SSM Parameter Store.
 * SSM keeps every version, so config changes are versioned and auditable for free.
 * Lambdas cache the value for 60 s; admins edit it from the Admin page or PUT /v1/admin/config.
 */
import { GetParameterCommand, PutParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { env } from './env.js';
import { AppConfigSchema, DEFAULT_CONFIG, type AppConfig } from './config-schema.js';

export * from './config-schema.js';

const ssm = new SSMClient({});
let cache: { value: AppConfig; version: number; at: number } | undefined;
const TTL_MS = 60_000;

/** Deep-merge stored config over defaults so new flags get sane values after upgrades. */
function withDefaults(raw: unknown): AppConfig {
  const r = (raw ?? {}) as Partial<AppConfig>;
  return AppConfigSchema.parse({
    ai: { ...DEFAULT_CONFIG.ai, ...r.ai, tools: { ...DEFAULT_CONFIG.ai.tools, ...r.ai?.tools } },
    features: { ...DEFAULT_CONFIG.features, ...r.features },
    anomaly: { ...DEFAULT_CONFIG.anomaly, ...r.anomaly },
  });
}

export async function getConfig(force = false): Promise<{ config: AppConfig; version: number }> {
  if (!force && cache && Date.now() - cache.at < TTL_MS) return { config: cache.value, version: cache.version };
  const res = await ssm.send(new GetParameterCommand({ Name: env.configParameter }));
  const value = withDefaults(JSON.parse(res.Parameter?.Value ?? '{}'));
  cache = { value, version: res.Parameter?.Version ?? 0, at: Date.now() };
  return { config: value, version: cache.version };
}

export async function putConfig(next: unknown): Promise<{ config: AppConfig; version: number }> {
  const value = withDefaults(next);
  const res = await ssm.send(
    new PutParameterCommand({ Name: env.configParameter, Value: JSON.stringify(value, null, 2), Overwrite: true, Type: 'String' }),
  );
  cache = { value, version: res.Version ?? 0, at: Date.now() };
  return { config: value, version: cache.version };
}

/** The subset of config the browser is allowed to see. */
export function publicConfig(c: AppConfig) {
  return { features: c.features, ai: { enabled: c.ai.enabled, chatModelId: c.ai.chatModelId, promptVariant: c.ai.promptVariant } };
}
