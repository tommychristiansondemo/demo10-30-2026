/**
 * Seeds the platform at deploy time (CDK Trigger) so dashboards, forecasts, SQL and the AI
 * assistant work immediately: 90 days of Parquet in the lake, 30 days of 5-minute and 90 days of
 * hourly data in DynamoDB, and a realistic alert history. Deterministic and idempotent.
 */
import { eventsBetween, floorToInterval, generateRange, HOUR_MS, INTERVAL_MS, rollup } from '../data/generator.js';
import type { GridInterval } from '../data/types.js';
import { detectAnomalies } from '../analytics/anomaly.js';
import { getConfig } from '../lib/config.js';
import { env } from '../lib/env.js';
import { writeEventsToLake, writeIntervalsToLake } from '../lib/lake.js';
import { logger } from '../lib/observability.js';
import { createAlertIfAbsent, putIntervals } from '../lib/repo.js';
import { anomalyToAlert, eventToAlert } from './generator.js';

const DAY_MS = 24 * HOUR_MS;
const iso = (ms: number) => new Date(ms).toISOString();

async function pool<T>(items: T[], concurrency: number, fn: (t: T) => Promise<void>) {
  let i = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => { while (i < items.length) await fn(items[i++]); }));
}

export const handler = async () => {
  const seed = env.dataSeed;
  const lakeDays = Number(process.env.BACKFILL_DAYS ?? '90');
  const hotDays = env.hotDays;
  const now = floorToInterval(Date.now());
  const today = Math.floor(now / DAY_MS) * DAY_MS;
  const start = today - lakeDays * DAY_MS;
  const t0 = Date.now();

  const all = generateRange(start - INTERVAL_MS, now, { seed }); // ts from `start` through `now`
  logger.info('generated intervals', { count: all.length, ms: Date.now() - t0 });

  // ---- Lake: daily files for complete days, hourly files for today ----
  const byDay = new Map<string, GridInterval[]>();
  for (const iv of all) {
    const dt = iv.ts.slice(0, 10);
    (byDay.get(dt) ?? byDay.set(dt, []).get(dt)!).push(iv);
  }
  const todayDt = iso(today).slice(0, 10);
  const jobs: (() => Promise<void>)[] = [];
  for (const [dt, ivs] of byDay) {
    const ds = Date.parse(`${dt}T00:00:00Z`);
    const events = eventsBetween(ds, Math.min(ds + DAY_MS, now), seed).filter((e) => Date.parse(e.start) >= ds && Date.parse(e.start) < Math.min(ds + DAY_MS, now + 1));
    jobs.push(() => writeEventsToLake(dt, events));
    if (dt !== todayDt) {
      jobs.push(() => writeIntervalsToLake(dt, 'day', ivs));
    } else {
      const byHour = new Map<string, GridInterval[]>();
      for (const iv of ivs) { const hh = iv.ts.slice(11, 13); (byHour.get(hh) ?? byHour.set(hh, []).get(hh)!).push(iv); }
      for (const [hh, hivs] of byHour) jobs.push(() => writeIntervalsToLake(dt, `hour=${hh}`, hivs));
    }
  }
  await pool(jobs, 8, (j) => j());
  logger.info('lake written', { files: jobs.length, ms: Date.now() - t0 });

  // ---- Hot store ----
  const hot = all.filter((i) => i.epoch_ms > now - hotDays * DAY_MS);
  const chunks: GridInterval[][] = [];
  for (let i = 0; i < hot.length; i += 500) chunks.push(hot.slice(i, i + 500));
  await pool(chunks, 6, (c) => putIntervals(c, '5m'));

  const hourly: GridInterval[] = [];
  for (let t = Math.floor(now / HOUR_MS) * HOUR_MS; t > now - Math.min(lakeDays, hotDays * 3) * DAY_MS; t -= HOUR_MS) {
    const ivs = all.filter((i) => i.epoch_ms > t - HOUR_MS && i.epoch_ms <= t);
    if (ivs.length === 12) hourly.push(rollup(ivs, iso(t)));
  }
  const hChunks: GridInterval[][] = [];
  for (let i = 0; i < hourly.length; i += 500) hChunks.push(hourly.slice(i, i + 500));
  await pool(hChunks, 6, (c) => putIntervals(c, '1h'));
  logger.info('hot store written', { fiveMin: hot.length, hourly: hourly.length, ms: Date.now() - t0 });

  // ---- Alert history: last 7 days; older than 24 h are marked resolved ----
  const { config } = await getConfig(true);
  const window = all.filter((i) => i.epoch_ms > now - 8 * DAY_MS);
  const evalFrom = window.findIndex((i) => i.epoch_ms > now - 7 * DAY_MS);
  const anomalies = detectAnomalies(window, config.anomaly, evalFrom);
  let created = 0;
  for (const a of anomalies) {
    const old = Date.parse(a.ts) < now - DAY_MS;
    const alert = anomalyToAlert(a, old ? 'RESOLVED' : 'OPEN');
    if (old) Object.assign(alert, { updated_by: 'system', updated_at: iso(now), notes: [{ at: iso(now), by: 'system', text: 'Auto-resolved during initial backfill' }] });
    if (await createAlertIfAbsent(alert)) created++;
  }
  for (const e of eventsBetween(now - 7 * DAY_MS, now + 1, seed).filter((x) => Date.parse(x.start) > now - 7 * DAY_MS && Date.parse(x.start) <= now)) {
    const done = Date.parse(e.end) < now;
    const alert = eventToAlert(e, done ? 'RESOLVED' : 'OPEN');
    if (!alert) continue;
    if (done) Object.assign(alert, { updated_by: 'system', updated_at: iso(now), notes: [{ at: e.end, by: 'system', text: 'Event cleared' }] });
    if (await createAlertIfAbsent(alert)) created++;
  }
  const summary = { intervals: all.length, lakeFiles: jobs.length, hot5m: hot.length, hourly: hourly.length, alerts: created, ms: Date.now() - t0 };
  logger.info('backfill complete', summary);
  return summary;
};
