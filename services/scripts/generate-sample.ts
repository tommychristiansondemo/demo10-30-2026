/**
 * Generate synthetic data locally (no AWS needed) to explore the model or prototype analytics.
 *   npm run generate:sample -- --days 7 --out sample
 * Writes Parquet files in the same layout as the lake plus a JSON summary of events and anomalies.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { detectAnomalies } from '../src/analytics/anomaly.js';
import { eventsBetween, floorToInterval, generateRange, HOUR_MS } from '../src/data/generator.js';
import { gridRows, hubRows, toParquet, zoneRows } from '../src/lib/lake.js';

const arg = (name: string, def: string) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : def; };
const days = Number(arg('days', '7'));
const out = arg('out', 'sample');
const end = floorToInterval(Date.now());
const start = end - days * 24 * HOUR_MS;

const intervals = generateRange(start, end);
mkdirSync(out, { recursive: true });
for (const [table, rows] of [['grid_interval', gridRows(intervals)], ['zone_load', zoneRows(intervals)], ['hub_price', hubRows(intervals)]] as const) {
  writeFileSync(join(out, `${table}.parquet`), toParquet(table, rows));
}
const events = eventsBetween(start, end);
const anomalies = detectAnomalies(intervals);
writeFileSync(join(out, 'summary.json'), JSON.stringify({ from: new Date(start).toISOString(), to: new Date(end).toISOString(), intervals: intervals.length, events, anomalies }, null, 2));
const peak = intervals.reduce((a, b) => (b.load_mw > a.load_mw ? b : a));
console.log(`Wrote ${intervals.length} intervals to ${out}/ (peak ${Math.round(peak.load_mw)} MW at ${peak.ts}; ${events.length} events; ${anomalies.length} anomalies)`);
