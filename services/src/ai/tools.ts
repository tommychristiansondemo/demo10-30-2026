/**
 * Agent tools. Each tool = JSON schema (sent to Claude) + zod validator + implementation.
 * Adding a tool: define it here, add its name to AI_TOOLS in lib/config.ts, and it becomes
 * toggleable from the Admin → Feature flags page. See docs/extending.md.
 */
import type Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import type { AppConfig } from '../lib/config.js';
import type { Principal } from '../lib/auth.js';
import { runQuery } from '../lib/athena.js';
import * as grid from '../lib/grid-service.js';
import { listAlerts } from '../lib/repo.js';
import { HOUR_MS } from '../data/generator.js';
import type { GridInterval } from '../data/types.js';

export interface ToolContext { config: AppConfig; principal: Principal }

interface ToolDef<T> {
  spec: Anthropic.Tool;
  input: z.ZodType<T>;
  run: (input: T, ctx: ToolContext) => Promise<unknown>;
  /** Short human-readable summary for the UI trace. */
  summarize?: (input: T, output: any) => string;
}

const obj = (properties: Record<string, unknown>, required: string[] = Object.keys(properties)) => ({
  type: 'object' as const,
  properties,
  required,
  additionalProperties: false,
});

const FIELD_GROUPS = ['load', 'net_load', 'gen_mix', 'frequency', 'reserves', 'prices', 'zones'] as const;

function compact(i: GridInterval, fields: readonly string[]) {
  const o: Record<string, unknown> = { ts: i.ts };
  if (fields.includes('load')) Object.assign(o, { load_mw: Math.round(i.load_mw), forecast_mw: Math.round(i.load_forecast_mw) });
  if (fields.includes('net_load')) o.net_load_mw = Math.round(i.net_load_mw);
  if (fields.includes('gen_mix')) o.gen_mw = Object.fromEntries(Object.entries(i.gen).map(([k, v]) => [k, Math.round(v)]));
  if (fields.includes('frequency')) o.freq = i.freq;
  if (fields.includes('reserves')) o.prc_mw = Math.round(i.reserves.prc_mw);
  if (fields.includes('prices')) Object.assign(o, { system_lambda: i.system_lambda, hub_lmp: Object.fromEntries(Object.entries(i.hubs).map(([k, v]) => [k, v.lmp])) });
  if (fields.includes('zones')) o.zone_load_mw = Object.fromEntries(Object.entries(i.zones).map(([k, v]) => [k, Math.round(v.load_mw)]));
  if (i.active_events.length) o.events = i.active_events;
  return o;
}

const tools = {
  get_grid_snapshot: {
    spec: {
      name: 'get_grid_snapshot',
      description:
        'Current real-time grid state (latest 5-minute interval): load and forecast, generation by fuel, frequency, PRC and ancillary reserves, system lambda, hub LMPs, weather-zone loads and temperatures, active contingency events, and derived status (renewable share, reserve status, data age). Use for any question about "now".',
      input_schema: obj({}),
      strict: true,
    },
    input: z.object({}).passthrough(),
    run: async () => grid.snapshot(),
    summarize: (_i, o) => `Latest interval ${o.ts}: load ${Math.round(o.load_mw).toLocaleString()} MW, PRC ${Math.round(o.reserves.prc_mw).toLocaleString()} MW`,
  } satisfies ToolDef<Record<string, unknown>>,

  get_recent_metrics: {
    spec: {
      name: 'get_recent_metrics',
      description:
        'Recent time series from the real-time store. Use 5m resolution for windows up to 12 hours and 1h for longer windows (max 720 hours). Choose only the field groups you need to keep results small.',
      input_schema: obj({
        hours_back: { type: 'integer', description: 'How many hours back from now (1-720)' },
        resolution: { type: 'string', enum: ['5m', '1h'] },
        fields: { type: 'array', items: { type: 'string', enum: [...FIELD_GROUPS] }, description: 'Field groups to include' },
      }),
      strict: true,
    },
    input: z.object({
      hours_back: z.number().int().min(1).max(720),
      resolution: z.enum(['5m', '1h']),
      fields: z.array(z.enum(FIELD_GROUPS)).min(1),
    }),
    run: async (i) => {
      const resolution = i.resolution === '5m' && i.hours_back <= 12 ? '5m' : '1h';
      const end = Date.now();
      const s = await grid.series(new Date(end - i.hours_back * HOUR_MS).toISOString(), new Date(end).toISOString(), resolution);
      return { resolution, count: s.points.length, points: s.points.map((p) => compact(p, i.fields)) };
    },
    summarize: (i, o) => `${o.count} ${o.resolution} points over the last ${i.hours_back} h (${i.fields.join(', ')})`,
  } satisfies ToolDef<{ hours_back: number; resolution: '5m' | '1h'; fields: (typeof FIELD_GROUPS)[number][] }>,

  query_grid_data: {
    spec: {
      name: 'query_grid_data',
      description:
        'Run one read-only Athena (Trino) SQL SELECT over the historical data lake (tables grid_interval, zone_load, hub_price, grid_event; schema in the system prompt). Always filter on the dt partition. Returns at most 200 rows.',
      input_schema: obj({
        sql: { type: 'string', description: 'A single SELECT/WITH statement, no comments or semicolons' },
        purpose: { type: 'string', description: 'One sentence describing what this query answers (shown to the user)' },
      }),
      strict: true,
    },
    input: z.object({ sql: z.string().min(10).max(8000), purpose: z.string().max(500) }),
    run: async (i) => {
      const r = await runQuery(i.sql, { maxRows: 200 });
      return { sql: r.sql, columns: r.columns, rows: r.rows, truncated: r.truncated, bytes_scanned: r.stats.bytesScanned, execution_ms: r.stats.executionMs };
    },
    summarize: (i, o) => `${i.purpose} → ${o.rows.length} rows, ${(o.bytes_scanned / 1e6).toFixed(1)} MB scanned`,
  } satisfies ToolDef<{ sql: string; purpose: string }>,

  forecast_load: {
    spec: {
      name: 'forecast_load',
      description:
        'Weather-normalized hourly load forecast (ridge regression on hour/day-type and temperature degree-hours) with P10/P90 bands and a 24-hour backtest MAPE versus a seasonal-naive baseline.',
      input_schema: obj({ hours_ahead: { type: 'integer', description: 'Forecast horizon in hours (1-72)' } }),
      strict: true,
    },
    input: z.object({ hours_ahead: z.number().int().min(1).max(72) }),
    run: async (i) => {
      const f = await grid.loadForecast(i.hours_ahead);
      const peak = f.points.reduce((a, b) => (b.forecast_mw > a.forecast_mw ? b : a));
      return { model: f.model, issued_at: f.issued_at, backtest: f.backtest, peak, points: f.points };
    },
    summarize: (i, o) => `${i.hours_ahead} h forecast, peak ${o.peak.forecast_mw.toLocaleString()} MW at ${o.peak.ts}; backtest MAPE ${o.backtest.mape_pct}%`,
  } satisfies ToolDef<{ hours_ahead: number }>,

  detect_anomalies: {
    spec: {
      name: 'detect_anomalies',
      description:
        'Run the anomaly detectors (frequency band, PRC thresholds, load-vs-forecast deviation, net-load ramps, robust z-score outliers on wind ramps and prices, stale-telemetry flatlines) over recent 5-minute data.',
      input_schema: obj({ hours_back: { type: 'integer', description: 'Window to evaluate in hours (1-72)' } }),
      strict: true,
    },
    input: z.object({ hours_back: z.number().int().min(1).max(72) }),
    run: async (i, ctx) => grid.anomalies(i.hours_back, ctx.config.anomaly),
    summarize: (i, o) => `${o.anomalies.length} anomalies in the last ${i.hours_back} h (${o.intervals_scanned} intervals scanned)`,
  } satisfies ToolDef<{ hours_back: number }>,

  search_knowledge_base: {
    spec: {
      name: 'search_knowledge_base',
      description:
        'Semantic search over GridSight operational documents: grid terminology, emergency procedure summaries, ancillary services, ORDC pricing, outage coordination, runbooks, incident reviews and the data dictionary. Returns passages with their source document names.',
      input_schema: obj({
        query: { type: 'string', description: 'Natural-language search query' },
        max_results: { type: 'integer', description: 'Number of passages (1-10)' },
      }),
      strict: true,
    },
    input: z.object({ query: z.string().min(2).max(1000), max_results: z.number().int().min(1).max(10) }),
    run: async (i) => ({ passages: await grid.searchKnowledge(i.query, i.max_results) }),
    summarize: (i, o) => `"${i.query}" → ${o.passages.length} passages from ${[...new Set(o.passages.map((p: any) => p.source))].join(', ')}`,
  } satisfies ToolDef<{ query: string; max_results: number }>,

  list_alerts: {
    spec: {
      name: 'list_alerts',
      description: 'List operational alerts raised by the anomaly detectors or operators, newest first.',
      input_schema: obj({
        status: { type: 'string', enum: ['OPEN', 'ACKNOWLEDGED', 'RESOLVED'] },
        limit: { type: 'integer', description: 'Max alerts (1-50)' },
      }),
      strict: true,
    },
    input: z.object({ status: z.enum(['OPEN', 'ACKNOWLEDGED', 'RESOLVED']), limit: z.number().int().min(1).max(50) }),
    run: async (i) => {
      const alerts = await listAlerts(i.status, i.limit);
      return { count: alerts.length, alerts: alerts.map(({ notes: _n, ...a }) => a) };
    },
    summarize: (i, o) => `${o.count} ${i.status.toLowerCase()} alerts`,
  } satisfies ToolDef<{ status: 'OPEN' | 'ACKNOWLEDGED' | 'RESOLVED'; limit: number }>,
};

export type ToolName = keyof typeof tools;

export function enabledTools(config: AppConfig): Anthropic.Tool[] {
  return (Object.keys(tools) as ToolName[])
    .filter((n) => config.ai.tools[n] !== false)
    .filter((n) => n !== 'search_knowledge_base' || config.features.knowledgeSearch)
    .filter((n) => n !== 'forecast_load' || config.features.forecasting)
    .map((n) => tools[n].spec);
}

const MAX_RESULT_CHARS = 60_000;

export interface ToolExecution {
  id: string;
  name: string;
  input: unknown;
  ok: boolean;
  summary: string;
  durationMs: number;
  /** JSON string sent back to the model. */
  content: string;
}

export async function executeTool(id: string, name: string, rawInput: unknown, ctx: ToolContext): Promise<ToolExecution> {
  const started = Date.now();
  const def = (tools as Record<string, ToolDef<any>>)[name];
  if (!def || ctx.config.ai.tools[name as ToolName] === false) {
    return { id, name, input: rawInput, ok: false, summary: 'Unknown or disabled tool', durationMs: 0, content: JSON.stringify({ error: `Tool ${name} is not available` }) };
  }
  try {
    const input = def.input.parse(rawInput ?? {});
    const output = await def.run(input, ctx);
    let content = JSON.stringify(output);
    if (content.length > MAX_RESULT_CHARS) content = JSON.stringify({ truncated: true, note: 'Result truncated; narrow the query.', partial: content.slice(0, MAX_RESULT_CHARS) });
    return { id, name, input, ok: true, summary: def.summarize?.(input, output) ?? 'ok', durationMs: Date.now() - started, content };
  } catch (err) {
    const message = err instanceof z.ZodError ? `Invalid input: ${err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}` : (err as Error).message;
    return { id, name, input: rawInput, ok: false, summary: message, durationMs: Date.now() - started, content: JSON.stringify({ error: message }) };
  }
}
