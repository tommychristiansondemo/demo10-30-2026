/** Read-side grid operations shared by the REST API and the AI agent tools. */
import { BedrockAgentRuntimeClient, RetrieveCommand } from '@aws-sdk/client-bedrock-agent-runtime';
import { detectAnomalies, type AnomalyThresholds } from '../analytics/anomaly.js';
import { forecastLoad } from '../analytics/forecast.js';
import { eventsBetween, forecastTemperature, HOUR_MS, systemTemperature } from '../data/generator.js';
import type { GridInterval } from '../data/types.js';
import { env } from './env.js';
import { latestIntervals, queryIntervals, type Resolution } from './repo.js';

export class NotReadyError extends Error {}

export async function snapshot() {
  const [latest] = await latestIntervals(1);
  if (!latest) throw new NotReadyError('No grid data yet. The backfill runs during deployment; the generator writes every 5 minutes.');
  const renewables = latest.gen.wind + latest.gen.solar;
  const prc = latest.reserves.prc_mw;
  return {
    ...latest,
    derived: {
      renewable_share_pct: Math.round((1000 * renewables) / Math.max(1, latest.gen_total_mw)) / 10,
      reserve_status: prc < 2500 ? 'EMERGENCY' : prc < 3000 ? 'ADVISORY' : prc < 4500 ? 'WATCH' : 'NORMAL',
      forecast_error_pct: Math.round((1000 * (latest.load_mw - latest.load_forecast_mw)) / latest.load_forecast_mw) / 10,
      data_age_seconds: Math.round((Date.now() - latest.epoch_ms) / 1000),
    },
    active_event_details: eventsBetween(latest.epoch_ms, latest.epoch_ms + 1, env.dataSeed).filter((e) => latest.active_events.includes(e.event_id)),
  };
}

export async function series(startIso: string, endIso: string, resolution?: Resolution): Promise<{ resolution: Resolution; points: GridInterval[] }> {
  const spanH = (Date.parse(endIso) - Date.parse(startIso)) / HOUR_MS;
  const res: Resolution = resolution ?? (spanH > 48 ? '1h' : '5m');
  return { resolution: res, points: await queryIntervals(startIso, endIso, res) };
}

export async function loadForecast(hoursAhead: number) {
  const now = Date.now();
  const history = await queryIntervals(new Date(now - 28 * 24 * HOUR_MS).toISOString(), new Date(now).toISOString(), '1h');
  if (history.length < 24 * 7) throw new NotReadyError('Need at least 7 days of hourly history to forecast.');
  const obs = history.map((i) => ({ epochMs: i.epoch_ms, loadMw: i.load_mw, tempF: systemTemperature(i) }));
  const issued = obs[obs.length - 1].epochMs;
  const result = forecastLoad(obs, hoursAhead, (t) => forecastTemperature(t, issued, env.dataSeed));
  return {
    ...result,
    issued_at: new Date(issued).toISOString(),
    recent_actuals: history.slice(-48).map((i) => ({ ts: i.ts, load_mw: i.load_mw, official_forecast_mw: i.load_forecast_mw })),
  };
}

export async function anomalies(hoursBack: number, thresholds: AnomalyThresholds) {
  const end = Date.now();
  const contextH = Math.max(hoursBack, 24);
  const data = await queryIntervals(new Date(end - (contextH + 1) * HOUR_MS).toISOString(), new Date(end).toISOString(), '5m');
  const from = data.findIndex((i) => i.epoch_ms >= end - hoursBack * HOUR_MS);
  return { window_hours: hoursBack, intervals_scanned: data.length, anomalies: detectAnomalies(data, thresholds, Math.max(0, from)) };
}

const kb = new BedrockAgentRuntimeClient({});

export async function searchKnowledge(query: string, maxResults = 5) {
  if (!env.knowledgeBaseId) throw new NotReadyError('Knowledge base is not configured');
  const res = await kb.send(
    new RetrieveCommand({
      knowledgeBaseId: env.knowledgeBaseId,
      retrievalQuery: { text: query },
      retrievalConfiguration: { vectorSearchConfiguration: { numberOfResults: Math.min(10, Math.max(1, maxResults)) } },
    }),
  );
  return (res.retrievalResults ?? []).map((r) => {
    const uri = r.location?.s3Location?.uri ?? '';
    return { source: uri.split('/').pop() ?? uri, uri, score: Math.round((r.score ?? 0) * 1000) / 1000, text: r.content?.text ?? '' };
  });
}
