/**
 * Scheduled every 5 minutes (EventBridge). Produces the latest synthetic interval(s), maintains
 * hourly rollups and the Parquet lake, runs anomaly detection, and pushes updates to WebSocket clients.
 */
import { detectAnomalies } from '../analytics/anomaly.js';
import { eventsBetween, floorToInterval, generateRange, HOUR_MS, INTERVAL_MS, rollup } from '../data/generator.js';
import type { Alert, GridEvent, GridInterval } from '../data/types.js';
import { getConfig } from '../lib/config.js';
import { env } from '../lib/env.js';
import { deleteHourlyParts, writeEventsToLake, writeIntervalsToLake } from '../lib/lake.js';
import { flushMetrics, logger, metrics, MetricUnit } from '../lib/observability.js';
import { createAlertIfAbsent, latestIntervals, putIntervals, queryIntervals } from '../lib/repo.js';
import { broadcast } from '../lib/ws.js';

const DAY_MS = 24 * HOUR_MS;
const dayStart = (ms: number) => Math.floor(ms / DAY_MS) * DAY_MS;
const iso = (ms: number) => new Date(ms).toISOString();

export function anomalyToAlert(a: ReturnType<typeof detectAnomalies>[number], status: Alert['status'] = 'OPEN'): Alert {
  return { id: a.id, ts: a.ts, type: a.type, metric: a.metric, severity: a.severity, status, title: a.title, message: a.message, value: a.value, expected: a.expected, score: a.score, zone: a.zone, source: 'detector' };
}

/** Contingency events (excluding data-quality events, which the detectors catch) become alerts too. */
export function eventToAlert(e: GridEvent, status: Alert['status'] = 'OPEN'): Alert | undefined {
  if (e.type === 'TELEMETRY_STALE') return undefined;
  const titles: Record<string, string> = {
    UNIT_TRIP: `Unit trip: ${e.mw_impact.toLocaleString('en-US')} MW forced outage`,
    WIND_RAMP: `Wind down-ramp of ${e.mw_impact.toLocaleString('en-US')} MW`,
    TRANSMISSION_OUTAGE: `Transmission outage in ${e.zone.replace('_', ' ')}`,
    LOAD_FORECAST_MISS: `Load running ${e.mw_impact}% above forecast in ${e.zone.replace('_', ' ')}`,
  };
  return { id: `EVENT#${e.event_id}`, ts: e.start, type: `CONTINGENCY_${e.type}`, metric: 'event', severity: e.severity, status, title: titles[e.type] ?? e.type, message: e.description, value: e.mw_impact, zone: e.zone, source: 'detector' };
}

export const handler = async () => {
  const seed = env.dataSeed;
  const now = floorToInterval(Date.now());
  try {
    const [last] = await latestIntervals(1);
    const from = Math.max(last ? last.epoch_ms : now - HOUR_MS, now - 2 * HOUR_MS);
    const fresh = generateRange(from, now, { seed });
    if (fresh.length === 0) return { written: 0 };
    await putIntervals(fresh, '5m');

    // Hourly rollups (hour-ending) and lake files (hour-beginning) for completed hours.
    for (const iv of fresh) {
      const t = iv.epoch_ms;
      if (t % HOUR_MS === 0) {
        await putIntervals([rollup(generateRange(t - HOUR_MS, t, { seed }), iso(t))], '1h');
      }
      if ((t + INTERVAL_MS) % HOUR_MS === 0) {
        const hourStart = t + INTERVAL_MS - HOUR_MS;
        const dt = iso(hourStart).slice(0, 10);
        const hh = iso(hourStart).slice(11, 13);
        await writeIntervalsToLake(dt, `hour=${hh}`, generateRange(hourStart - INTERVAL_MS, t, { seed }));
        const ds = dayStart(hourStart);
        await writeEventsToLake(dt, eventsBetween(ds, t, seed).filter((e) => Date.parse(e.start) >= ds && Date.parse(e.start) <= t));
      }
      // Shortly after midnight UTC, compact yesterday's hourly files into one daily file.
      if (t % DAY_MS === 15 * 60_000) {
        const yStart = dayStart(t) - DAY_MS;
        const dt = iso(yStart).slice(0, 10);
        await writeIntervalsToLake(dt, 'day', generateRange(yStart - INTERVAL_MS, yStart + DAY_MS - INTERVAL_MS, { seed }));
        await writeEventsToLake(dt, eventsBetween(yStart, yStart + DAY_MS, seed).filter((e) => Date.parse(e.start) >= yStart && Date.parse(e.start) < yStart + DAY_MS));
        const removed = await deleteHourlyParts(dt);
        logger.info('compacted lake partition', { dt, removed });
      }
    }

    // Anomaly detection over new intervals with 24 h of context.
    const { config } = await getConfig();
    let newAlerts: Alert[] = [];
    if (config.features.anomalyAlerts) {
      const context: GridInterval[] = await queryIntervals(iso(now - DAY_MS), iso(now), '5m');
      const evalFrom = context.findIndex((i) => i.epoch_ms >= fresh[0].epoch_ms);
      const found = detectAnomalies(context, config.anomaly, evalFrom < 0 ? context.length : evalFrom);
      for (const a of found) {
        const alert = anomalyToAlert(a);
        if (await createAlertIfAbsent(alert)) newAlerts.push(alert);
      }
      for (const e of eventsBetween(fresh[0].epoch_ms - INTERVAL_MS, now + 1, seed)) {
        const startMs = Date.parse(e.start);
        const alert = startMs >= fresh[0].epoch_ms && startMs <= now ? eventToAlert(e) : undefined;
        if (alert && (await createAlertIfAbsent(alert))) newAlerts.push(alert);
      }
      metrics.addMetric('AnomaliesDetected', MetricUnit.Count, newAlerts.length);
    }

    const latest = fresh[fresh.length - 1];
    await broadcast({ type: 'grid.interval', data: latest });
    for (const a of newAlerts) await broadcast({ type: 'alert.new', data: a });

    metrics.addMetric('IntervalsWritten', MetricUnit.Count, fresh.length);
    metrics.addMetric('DataLagSeconds', MetricUnit.Seconds, Math.round((Date.now() - latest.epoch_ms) / 1000));
    logger.info('generator run', { intervals: fresh.length, latest: latest.ts, alerts: newAlerts.length });
    return { written: fresh.length, latest: latest.ts, alerts: newAlerts.length };
  } finally {
    flushMetrics();
  }
};
