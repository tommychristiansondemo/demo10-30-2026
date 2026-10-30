import { useState } from 'react';
import { api } from '../api/client';
import type { QueryResult } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { Card, DataTable, ErrorBox, Icon, Segmented } from '../components/ui';

const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = (n: number) => new Date(Date.now() - n * 86400_000).toISOString().slice(0, 10);

const SAMPLES = [
  { label: 'Daily peak load (7 days)', sql: `SELECT dt, max(load_mw) AS peak_load_mw, min(prc_mw) AS min_prc_mw, max(system_lambda) AS max_lambda\nFROM grid_interval\nWHERE dt >= '${daysAgo(7)}'\nGROUP BY dt\nORDER BY dt` },
  { label: 'Frequency excursions', sql: `SELECT ts, freq_min_hz, prc_mw, active_event_count\nFROM grid_interval\nWHERE dt >= '${daysAgo(30)}' AND freq_min_hz < 59.95\nORDER BY ts DESC` },
  { label: 'Average LMP by hub & CPT hour', sql: `SELECT hub, hour(at_timezone(ts, 'America/Chicago')) AS hour_cpt, round(avg(lmp), 2) AS avg_lmp\nFROM hub_price\nWHERE dt >= '${daysAgo(7)}'\nGROUP BY 1, 2\nORDER BY 1, 2` },
  { label: 'Contingencies by type', sql: `SELECT type, severity, count(*) AS events, round(avg(mw_impact)) AS avg_mw\nFROM grid_event\nWHERE dt >= '${daysAgo(90)}'\nGROUP BY 1, 2\nORDER BY events DESC` },
  { label: 'Zone load at today’s peak', sql: `WITH peak AS (\n  SELECT ts FROM grid_interval WHERE dt = '${today()}' ORDER BY load_mw DESC LIMIT 1\n)\nSELECT z.zone, z.load_mw, z.temp_f\nFROM zone_load z JOIN peak p ON z.ts = p.ts\nWHERE z.dt = '${today()}'\nORDER BY z.load_mw DESC` },
];

export function Explorer() {
  const { feature } = useAuth();
  const [mode, setMode] = useState<'nl' | 'sql'>(feature('nlToSql') ? 'nl' : 'sql');
  const [question, setQuestion] = useState('What was the average wind share of generation by hour of day (Central time) over the last 14 days?');
  const [sql, setSql] = useState(SAMPLES[0].sql);
  const [result, setResult] = useState<QueryResult>();
  const [explanation, setExplanation] = useState<string>();
  const [error, setError] = useState<Error>();
  const [busy, setBusy] = useState(false);

  const runSql = async (text = sql) => {
    setBusy(true); setError(undefined); setExplanation(undefined);
    try { setResult(await api.post<QueryResult>('/v1/query/sql', { sql: text })); } catch (e) { setError(e as Error); setResult(undefined); } finally { setBusy(false); }
  };
  const ask = async () => {
    setBusy(true); setError(undefined);
    try {
      const r = await api.post<{ sql: string; explanation: string; result?: QueryResult; error?: string }>('/v1/ai/sql', { question, execute: true });
      setSql(r.sql); setExplanation(r.explanation); setResult(r.result);
      if (r.error) setError(new Error(r.error));
    } catch (e) { setError(e as Error); } finally { setBusy(false); }
  };
  const csv = () => {
    if (!result) return;
    const esc = (v: unknown) => (v === null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
    const body = [result.columns.map((c) => c.name).join(','), ...result.rows.map((r) => result.columns.map((c) => esc(r[c.name])).join(','))].join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([body], { type: 'text/csv' }));
    a.download = `gridsight-${Date.now()}.csv`;
    a.click();
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Data explorer</h1>
          <p>Query 90+ days of 5-minute data in the Parquet lake with Athena. Queries are read-only, limited to GridSight tables, and audited.</p>
        </div>
        <span className="spacer" />
        <Segmented label="Mode" value={mode} onChange={setMode} options={[...(feature('nlToSql') ? [{ value: 'nl' as const, label: 'Ask in English' }] : []), { value: 'sql' as const, label: 'SQL' }]} />
      </div>
      {mode === 'nl' ? (
        <Card title="Natural language → SQL" sub="Claude writes the query; you can edit and re-run it">
          <div className="row" style={{ alignItems: 'stretch' }}>
            <textarea rows={2} value={question} onChange={(e) => setQuestion(e.target.value)} style={{ flex: 1 }} aria-label="Question" />
            <button className="primary" disabled={busy || question.length < 3} onClick={() => void ask()}><Icon name="sparkle" /> {busy ? 'Working…' : 'Ask'}</button>
          </div>
          {explanation && <p className="note" style={{ marginTop: 10 }}>{explanation}</p>}
          {explanation && <pre style={{ marginTop: 8 }}>{sql}</pre>}
          {explanation && <div className="row" style={{ marginTop: 8 }}><button className="small" onClick={() => setMode('sql')}>Edit SQL</button></div>}
        </Card>
      ) : (
        <Card title="SQL" sub="Athena engine v3 (Trino). Always filter on dt." actions={
          <select aria-label="Sample queries" onChange={(e) => { const s = SAMPLES[Number(e.target.value)]; if (s) setSql(s.sql); }} style={{ width: 240 }} defaultValue="">
            <option value="" disabled>Sample queries…</option>
            {SAMPLES.map((s, i) => <option key={s.label} value={i}>{s.label}</option>)}
          </select>
        }>
          <textarea className="mono" rows={9} value={sql} onChange={(e) => setSql(e.target.value)} aria-label="SQL" spellCheck={false} />
          <div className="row" style={{ marginTop: 8 }}>
            <button className="primary" disabled={busy} onClick={() => void runSql()}>{busy ? 'Running…' : 'Run query'}</button>
            <span className="note">Tables: grid_interval, zone_load, hub_price, grid_event · see docs/data-dictionary.md</span>
          </div>
        </Card>
      )}
      {error && <ErrorBox error={error} />}
      {result && (
        <Card
          title={`${result.rows.length.toLocaleString()} rows${result.truncated ? ' (truncated)' : ''}`}
          sub={`${(result.stats.bytesScanned / 1e6).toFixed(2)} MB scanned · ${result.stats.executionMs} ms · ${result.stats.queryExecutionId}`}
          actions={<button className="small" onClick={csv}>Download CSV</button>}
          flush
        >
          <DataTable rows={result.rows} columns={result.columns.map((c) => ({ key: c.name, label: c.name, num: /double|int|bigint|decimal|real/.test(c.type), format: (v) => (v === null ? '' : typeof v === 'number' ? v.toLocaleString('en-US', { maximumFractionDigits: 3 }) : String(v)) }))} />
        </Card>
      )}
    </>
  );
}
