/**
 * Config schema and defaults (dependency-light so the CDK app can import it to seed the
 * SSM parameter). Runtime loading lives in config.ts.
 */
import { z } from 'zod';
import { DEFAULT_THRESHOLDS } from '../analytics/anomaly.js';

export const PROMPT_VARIANTS = ['operations-analyst', 'developer-assistant', 'executive-brief'] as const;
export const AI_TOOLS = [
  'get_grid_snapshot',
  'get_recent_metrics',
  'query_grid_data',
  'forecast_load',
  'detect_anomalies',
  'search_knowledge_base',
  'list_alerts',
] as const;

export const AppConfigSchema = z.object({
  ai: z.object({
    enabled: z.boolean(),
    chatModelId: z.string().min(3),
    fallbackModelId: z.string().min(3),
    sqlModelId: z.string().min(3),
    effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']),
    maxToolIterations: z.number().int().min(1).max(20),
    maxOutputTokens: z.number().int().min(1024).max(64000),
    promptVariant: z.enum(PROMPT_VARIANTS),
    tools: z.record(z.enum(AI_TOOLS), z.boolean()),
    maxSessionTurns: z.number().int().min(2).max(100),
  }),
  features: z.object({
    aiChat: z.boolean(),
    nlToSql: z.boolean(),
    forecasting: z.boolean(),
    anomalyAlerts: z.boolean(),
    knowledgeSearch: z.boolean(),
  }),
  anomaly: z.object({
    freqLowHz: z.number(),
    freqHighHz: z.number(),
    prcWarnMw: z.number(),
    prcCriticalMw: z.number(),
    forecastDeviationPct: z.number(),
    netLoadRampMwPer30Min: z.number(),
    zScore: z.number(),
    flatlineIntervals: z.number().int().min(2),
  }),
});
export type AppConfig = z.infer<typeof AppConfigSchema>;

export const DEFAULT_CONFIG: AppConfig = {
  ai: {
    enabled: true,
    // Cross-region inference profiles on the Bedrock runtime (see ai/models.ts). Switch to
    // anthropic.claude-opus-5-5 etc. from the Admin page once the account has access.
    chatModelId: 'us.anthropic.claude-opus-4-6-v1',
    fallbackModelId: 'us.anthropic.claude-sonnet-4-6',
    sqlModelId: 'us.anthropic.claude-sonnet-4-6',
    effort: 'medium',
    maxToolIterations: 8,
    maxOutputTokens: 16000,
    promptVariant: 'operations-analyst',
    tools: Object.fromEntries(AI_TOOLS.map((t) => [t, true])) as Record<(typeof AI_TOOLS)[number], boolean>,
    maxSessionTurns: 30,
  },
  features: { aiChat: true, nlToSql: true, forecasting: true, anomalyAlerts: true, knowledgeSearch: true },
  anomaly: { ...DEFAULT_THRESHOLDS },
};
