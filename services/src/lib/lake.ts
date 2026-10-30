/** Write grid data to the S3 data lake as Parquet, partitioned by dt=YYYY-MM-DD. */
import { DeleteObjectsCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { parquetWriteBuffer } from 'hyparquet-writer';
import { FUELS, TRADING_HUBS, WEATHER_ZONES, type GridEvent, type GridInterval } from '../data/types.js';
import { LAKE_PREFIX, LAKE_TABLES, type ColumnType } from '../data/schema.js';
import { env } from './env.js';

const s3 = new S3Client({});

type Row = Record<string, unknown>;
const PARQUET_TYPE: Record<ColumnType, 'TIMESTAMP' | 'DOUBLE' | 'STRING' | 'INT32'> = {
  timestamp: 'TIMESTAMP',
  double: 'DOUBLE',
  string: 'STRING',
  int: 'INT32',
};

export function toParquet(table: string, rows: Row[]): Uint8Array {
  const def = LAKE_TABLES.find((t) => t.name === table);
  if (!def) throw new Error(`Unknown table ${table}`);
  const buf = parquetWriteBuffer({
    columnData: def.columns.map((c) => ({ name: c.name, type: PARQUET_TYPE[c.type], data: rows.map((r) => r[c.name] ?? null) as any[] })),
  });
  return new Uint8Array(buf);
}

export function gridRows(intervals: GridInterval[]): Row[] {
  return intervals.map((i) => ({
    ts: new Date(i.epoch_ms),
    load_mw: i.load_mw,
    load_forecast_mw: i.load_forecast_mw,
    net_load_mw: i.net_load_mw,
    ...Object.fromEntries(FUELS.map((f) => [`gen_${f}_mw`, i.gen[f]])),
    gen_total_mw: i.gen_total_mw,
    curtailment_mw: i.curtailment_mw,
    freq_mean_hz: i.freq.mean_hz,
    freq_min_hz: i.freq.min_hz,
    freq_max_hz: i.freq.max_hz,
    ...i.reserves,
    system_lambda: i.system_lambda,
    data_quality: i.data_quality,
    active_event_count: i.active_events.length,
  }));
}

export const zoneRows = (intervals: GridInterval[]): Row[] =>
  intervals.flatMap((i) => WEATHER_ZONES.map((z) => ({ ts: new Date(i.epoch_ms), zone: z, ...i.zones[z] })));

export const hubRows = (intervals: GridInterval[]): Row[] =>
  intervals.flatMap((i) => TRADING_HUBS.map((h) => ({ ts: new Date(i.epoch_ms), hub: h, ...i.hubs[h] })));

export const eventRows = (events: GridEvent[]): Row[] =>
  events.map((e) => ({ ...e, start_ts: new Date(e.start), end_ts: new Date(e.end) }));

const key = (table: string, dt: string, file: string) => `${LAKE_PREFIX}/${table}/dt=${dt}/${file}.parquet`;

/** Write all interval-derived tables for one partition/file name. Idempotent (overwrites). */
export async function writeIntervalsToLake(dt: string, file: string, intervals: GridInterval[]): Promise<void> {
  const writes: [string, Row[]][] = [
    ['grid_interval', gridRows(intervals)],
    ['zone_load', zoneRows(intervals)],
    ['hub_price', hubRows(intervals)],
  ];
  await Promise.all(
    writes.map(([table, rows]) =>
      s3.send(new PutObjectCommand({ Bucket: env.lakeBucket, Key: key(table, dt, file), Body: toParquet(table, rows), ContentType: 'application/vnd.apache.parquet' })),
    ),
  );
}

export async function writeEventsToLake(dt: string, events: GridEvent[]): Promise<void> {
  await s3.send(
    new PutObjectCommand({ Bucket: env.lakeBucket, Key: key('grid_event', dt, 'events'), Body: toParquet('grid_event', eventRows(events)) }),
  );
}

/** Remove hourly part files for a partition after it has been compacted into a daily file. */
export async function deleteHourlyParts(dt: string): Promise<number> {
  let deleted = 0;
  for (const table of ['grid_interval', 'zone_load', 'hub_price']) {
    const res = await s3.send(new ListObjectsV2Command({ Bucket: env.lakeBucket, Prefix: `${LAKE_PREFIX}/${table}/dt=${dt}/hour=` }));
    const objects = (res.Contents ?? []).map((o) => ({ Key: o.Key! }));
    if (objects.length) {
      await s3.send(new DeleteObjectsCommand({ Bucket: env.lakeBucket, Delete: { Objects: objects } }));
      deleted += objects.length;
    }
  }
  return deleted;
}
