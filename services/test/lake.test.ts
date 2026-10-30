import { describe, expect, it } from 'vitest';
import { parquetReadObjects } from 'hyparquet';
import { generateRange, HOUR_MS } from '../src/data/generator.js';
import { gridRows, toParquet, zoneRows } from '../src/lib/lake.js';
import { LAKE_TABLES } from '../src/data/schema.js';

describe('parquet lake writer', () => {
  it('writes files that round-trip with the declared schema', async () => {
    const end = Date.parse('2026-10-01T00:00:00Z');
    const ivs = generateRange(end - HOUR_MS, end);
    const bytes = toParquet('grid_interval', gridRows(ivs));
    const rows = await parquetReadObjects({ file: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer });
    expect(rows).toHaveLength(12);
    expect(Object.keys(rows[0]).sort()).toEqual(LAKE_TABLES[0].columns.map((c) => c.name).sort());
    expect(rows[0].load_mw).toBe(ivs[0].load_mw);
    expect(zoneRows(ivs)).toHaveLength(12 * 8);
  });
});
