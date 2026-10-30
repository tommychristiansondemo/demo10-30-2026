import { describe, expect, it } from 'vitest';
import { guardSql, SqlRejected } from '../src/lib/sql-guard.js';

const tables = ['grid_interval', 'zone_load', 'hub_price', 'grid_event'];

describe('SQL guard', () => {
  it('accepts a SELECT and appends a LIMIT', () => {
    expect(guardSql("SELECT avg(load_mw) FROM grid_interval WHERE dt = '2026-10-01'", tables, 100)).toMatch(/LIMIT 100$/);
  });
  it('clamps an oversized LIMIT and keeps a small one', () => {
    expect(guardSql('SELECT * FROM grid_interval LIMIT 50000', tables, 1000)).toMatch(/LIMIT 1000$/);
    expect(guardSql('SELECT * FROM grid_interval LIMIT 5', tables, 1000)).toMatch(/LIMIT 5$/);
  });
  it('allows CTEs and joins across known tables', () => {
    expect(() =>
      guardSql('WITH peaks AS (SELECT dt, max(load_mw) m FROM grid_interval GROUP BY dt) SELECT p.dt, h.lmp FROM peaks p JOIN hub_price h ON h.dt = p.dt', tables),
    ).not.toThrow();
  });
  it.each([
    ['DROP TABLE grid_interval', /SELECT/],
    ['SELECT 1; DROP TABLE x', /single statement/],
    ['SELECT * FROM grid_interval -- comment', /comments/],
    ['SELECT * FROM secrets', /Unknown table/],
    ['SELECT * FROM other_db.grid_interval', /Database not allowed/],
    ['SELECT * FROM information_schema.tables', /not allowed/],
    ["INSERT INTO grid_interval SELECT * FROM grid_interval", /SELECT/],
  ])('rejects %s', (sql, msg) => {
    expect(() => guardSql(sql, tables, 100, 'gridsight_dev')).toThrow(SqlRejected);
    expect(() => guardSql(sql, tables, 100, 'gridsight_dev')).toThrow(msg);
  });
  it('does not trip on keywords inside string literals', () => {
    expect(() => guardSql("SELECT * FROM grid_event WHERE description LIKE '%update%'", tables)).not.toThrow();
  });
});
