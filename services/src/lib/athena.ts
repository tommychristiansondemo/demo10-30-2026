/** Run guarded Athena queries against the GridSight lake and return typed rows. */
import {
  AthenaClient,
  GetQueryExecutionCommand,
  GetQueryResultsCommand,
  StartQueryExecutionCommand,
} from '@aws-sdk/client-athena';
import { LAKE_TABLES } from '../data/schema.js';
import { env } from './env.js';
import { guardSql } from './sql-guard.js';

const athena = new AthenaClient({});

export interface QueryResult {
  sql: string;
  columns: { name: string; type: string }[];
  rows: Record<string, string | number | null>[];
  truncated: boolean;
  stats: { queryExecutionId: string; bytesScanned: number; executionMs: number };
}

const NUMERIC = /^(double|float|real|decimal|integer|int|bigint|smallint|tinyint)/i;

export async function runQuery(rawSql: string, opts: { maxRows?: number; timeoutMs?: number } = {}): Promise<QueryResult> {
  const maxRows = opts.maxRows ?? 1000;
  const sql = guardSql(rawSql, LAKE_TABLES.map((t) => t.name), maxRows, env.glueDatabase);
  const start = await athena.send(
    new StartQueryExecutionCommand({
      QueryString: sql,
      WorkGroup: env.athenaWorkgroup,
      QueryExecutionContext: { Database: env.glueDatabase, Catalog: 'AwsDataCatalog' },
    }),
  );
  const id = start.QueryExecutionId!;
  const deadline = Date.now() + (opts.timeoutMs ?? 25_000);
  let delay = 300;
  for (;;) {
    const q = await athena.send(new GetQueryExecutionCommand({ QueryExecutionId: id }));
    const state = q.QueryExecution?.Status?.State;
    if (state === 'SUCCEEDED') {
      const stats = q.QueryExecution?.Statistics;
      const columns: QueryResult['columns'] = [];
      const rows: QueryResult['rows'] = [];
      let token: string | undefined;
      let first = true;
      do {
        const res = await athena.send(new GetQueryResultsCommand({ QueryExecutionId: id, NextToken: token, MaxResults: 1000 }));
        if (first) {
          for (const c of res.ResultSet?.ResultSetMetadata?.ColumnInfo ?? []) columns.push({ name: c.Name!, type: c.Type! });
        }
        const data = res.ResultSet?.Rows ?? [];
        for (const [idx, r] of data.entries()) {
          if (first && idx === 0) continue; // header row
          const obj: QueryResult['rows'][number] = {};
          r.Data?.forEach((d, i) => {
            const col = columns[i];
            const v = d.VarCharValue;
            obj[col.name] = v === undefined ? null : NUMERIC.test(col.type) ? Number(v) : v;
          });
          rows.push(obj);
        }
        first = false;
        token = res.NextToken;
      } while (token && rows.length < maxRows);
      return {
        sql,
        columns,
        rows: rows.slice(0, maxRows),
        truncated: rows.length >= maxRows,
        stats: { queryExecutionId: id, bytesScanned: stats?.DataScannedInBytes ?? 0, executionMs: stats?.TotalExecutionTimeInMillis ?? 0 },
      };
    }
    if (state === 'FAILED' || state === 'CANCELLED') {
      throw new Error(`Athena query ${state}: ${q.QueryExecution?.Status?.StateChangeReason ?? 'unknown reason'}`);
    }
    if (Date.now() > deadline) throw new Error(`Athena query ${id} timed out`);
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(1000, delay * 1.5);
  }
}
