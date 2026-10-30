import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import { live } from '../api/live';
import type { Alert, ForecastResponse, Fuel, GridEvent, GridInterval, Snapshot } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { baseOption, Chart, useChartColors, type ChartColors, type EChartsOption } from '../components/Chart';
import { Card, ChartCard, ErrorBox, Kpi, Segmented, SeverityBadge, Skeleton } from '../components/ui';
import { ago, dateTimeCpt, gw, hz, mw, num, pct, timeCpt, usd } from '../lib/format';
import { useAsync } from '../lib/hooks';

const RANGES = [
  { value: 6, label: '6h' },
  { value: 24, label: '24h' },
  { value: 72, label: '3d' },
  { value: 168, label: '7d' },
  { value: 720, label: '30d' },
];

// Bottom-to-top stacking order; validated as adjacent pairs for color-vision deficiency.
const FUEL_ORDER: { key: Fuel; label: string }[] = [
  { key: 'nuclear', label: 'Nuclear' },
  { key: 'coal', label: 'Coal' },
  { key: 'hydro', label: 'Hydro' },
  { key: 'gas', label: 'Gas' },
  { key: 'wind', label: 'Wind' },
  { key: 'solar', label: 'Solar' },
  { key: 'storage', label: 'Storage' },
  { key: 'other', label: 'Other' },
];
const HUBS = ['HB_NORTH', 'HB_HOUSTON', 'HB_WEST', 'HB_SOUTH', 'HB_PAN'];
const RESERVE_STATUS = {
  NORMAL: { sev: 'GOOD', label: 'Normal' },
  WATCH: { sev: 'INFO', label: 'Watch' },
  ADVISORY: { sev: 'WARNING', label: 'Advisory' },
  EMERGENCY: { sev: 'CRITICAL', label: 'EEA level' },
} as const;

const pt = (i: GridInterval, v: number) => [i.epoch_ms, v];

export function Overview() {
  const { can, feature } = useAuth();
  const [hours, setHours] = useState(24);
  const colors = useChartColors();

  const snap = useAsync(() => api.get<Snapshot>('/v1/grid/current'), [], { refreshMs: 60_000 });
  const series = useAsync(() => {
    const end = new Date();
    const start = new Date(end.getTime() - hours * 3600_000);
    return api.get<{ resolution: string; points: GridInterval[] }>(`/v1/grid/series?start=${start.toISOString()}&end=${end.toISOString()}`);
  }, [hours]);
  const alerts = useAsync(() => api.get<{ alerts: Alert[] }>('/v1/alerts?status=OPEN&limit=8'), [], { refreshMs: 120_000 });
  const forecast = useAsync(() => api.get<ForecastResponse>('/v1/forecast/load?hours=24'), [], { enabled: can('Analyst') && feature('forecasting') });

  // Live push: append new 5-minute intervals and new alerts without refetching.
  useEffect(() => live.subscribe((msg) => {
    if (msg.type === 'grid.interval') {
      void snap.reload();
      series.setData((s) => (s && s.resolution === '5m' && !s.points.some((p) => p.ts === msg.data.ts) ? { ...s, points: [...s.points.slice(1), msg.data] } : s));
    }
    if (msg.type === 'alert.new' || msg.type === 'alert.updated') void alerts.reload();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), []);

  const points = series.data?.points ?? [];
  const s = snap.data;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Grid overview</h1>
          <p>{s ? <>Interval ending {dateTimeCpt(s.ts)} · updated {ago(s.ts)}{s.data_quality === 'STALE' && <> · <SeverityBadge severity="WARNING" label="Stale telemetry" /></>}</> : 'Loading latest interval…'}</p>
        </div>
        <span className="spacer" />
        <Segmented label="Time range" value={hours} options={RANGES} onChange={setHours} />
      </div>

      {snap.error && <ErrorBox error={snap.error} />}
      <div className="grid kpis">
        {s ? (
          <>
            <Kpi label="System load" value={gw(s.load_mw)} detail={<>Forecast {gw(s.load_forecast_mw)} · {s.derived.forecast_error_pct > 0 ? '+' : ''}{pct(s.derived.forecast_error_pct)}</>} />
            <Kpi label="Net load" value={gw(s.net_load_mw)} detail={<>Wind {gw(s.gen.wind)} · Solar {gw(s.gen.solar)}</>} />
            <Kpi label="Renewable share" value={pct(s.derived.renewable_share_pct)} detail={s.curtailment_mw > 0 ? `Curtailment ${mw(s.curtailment_mw)}` : 'No curtailment'} />
            <Kpi label="Frequency (min)" value={s.freq.min_hz.toFixed(3)} unit="Hz" detail={`Mean ${hz(s.freq.mean_hz)}`} status={s.freq.min_hz < 59.95 ? <SeverityBadge severity="WARNING" label="Excursion" /> : undefined} />
            <Kpi label="PRC" value={gw(s.reserves.prc_mw)} detail={`RRS ${mw(s.reserves.rrs_mw)} · ECRS ${mw(s.reserves.ecrs_mw)}`} status={<SeverityBadge severity={RESERVE_STATUS[s.derived.reserve_status].sev} label={RESERVE_STATUS[s.derived.reserve_status].label} />} />
            <Kpi label="System lambda" value={usd(s.system_lambda)} unit="/MWh" detail={`HB_NORTH ${usd(s.hubs.HB_NORTH.lmp)} · HB_WEST ${usd(s.hubs.HB_WEST.lmp)}`} />
          </>
        ) : (
          Array.from({ length: 6 }, (_, i) => <Skeleton key={i} height={96} />)
        )}
      </div>

      {series.error && <ErrorBox error={series.error} />}
      <div className="grid two">
        <ChartCard
          title="Load vs forecast"
          sub={forecast.data ? `GridSight forecast: backtest MAPE ${forecast.data.backtest.mape_pct}%` : undefined}
          chart={series.loading && !points.length ? <Skeleton /> : <Chart ariaLabel="System load, operational forecast, net load and GridSight forecast" option={loadOption(colors, points, forecast.data)} />}
          rows={points.map((p) => ({ ts: p.ts, load: p.load_mw, forecast: p.load_forecast_mw, net: p.net_load_mw }))}
          columns={[{ key: 'ts', label: 'Time (CPT)', format: dateTimeCpt }, { key: 'load', label: 'Load MW', num: true, format: num }, { key: 'forecast', label: 'Forecast MW', num: true, format: num }, { key: 'net', label: 'Net load MW', num: true, format: num }]}
        />
        <ChartCard
          title="Generation mix"
          sub="Stacked by fuel; storage below zero is charging"
          chart={series.loading && !points.length ? <Skeleton /> : <Chart ariaLabel="Stacked generation by fuel type" option={mixOption(colors, points)} />}
          rows={points.map((p) => ({ ts: p.ts, ...p.gen }))}
          columns={[{ key: 'ts', label: 'Time (CPT)', format: dateTimeCpt }, ...FUEL_ORDER.map((f) => ({ key: f.key, label: `${f.label} MW`, num: true, format: num }))] as never}
        />
        <ChartCard
          title="System frequency"
          sub="5-minute min/mean/max · band 59.95–60.05 Hz"
          chart={series.loading && !points.length ? <Skeleton /> : <Chart ariaLabel="System frequency with alert thresholds" option={freqOption(colors, points)} />}
          rows={points.map((p) => ({ ts: p.ts, min: p.freq.min_hz, mean: p.freq.mean_hz, max: p.freq.max_hz }))}
          columns={[{ key: 'ts', label: 'Time (CPT)', format: dateTimeCpt }, { key: 'min', label: 'Min Hz', num: true, format: (v) => v.toFixed(3) }, { key: 'mean', label: 'Mean Hz', num: true, format: (v) => v.toFixed(3) }, { key: 'max', label: 'Max Hz', num: true, format: (v) => v.toFixed(3) }]}
        />
        <ChartCard
          title="Physical Responsive Capability"
          sub="Advisory below 3,000 MW · EEA level below 2,500 MW"
          chart={series.loading && !points.length ? <Skeleton /> : <Chart ariaLabel="PRC with advisory and emergency thresholds" option={prcOption(colors, points)} />}
          rows={points.map((p) => ({ ts: p.ts, prc: p.reserves.prc_mw, regup: p.reserves.regup_mw, rrs: p.reserves.rrs_mw, ecrs: p.reserves.ecrs_mw, nonspin: p.reserves.nonspin_mw }))}
          columns={[{ key: 'ts', label: 'Time (CPT)', format: dateTimeCpt }, { key: 'prc', label: 'PRC MW', num: true, format: num }, { key: 'regup', label: 'RegUp', num: true, format: num }, { key: 'rrs', label: 'RRS', num: true, format: num }, { key: 'ecrs', label: 'ECRS', num: true, format: num }, { key: 'nonspin', label: 'Non-Spin', num: true, format: num }]}
        />
      </div>

      <div className="grid main-side">
        <ChartCard
          title="Trading hub prices"
          sub="LMP, $/MWh"
          chart={series.loading && !points.length ? <Skeleton /> : <Chart ariaLabel="Locational marginal prices by trading hub" option={priceOption(colors, points)} />}
          rows={points.map((p) => ({ ts: p.ts, ...Object.fromEntries(HUBS.map((h) => [h, p.hubs[h].lmp])) }))}
          columns={[{ key: 'ts', label: 'Time (CPT)', format: dateTimeCpt }, ...HUBS.map((h) => ({ key: h, label: h, num: true, format: (v: number) => usd(v) }))] as never}
        />
        <Card title="Open alerts" actions={<Link to="/alerts">View all</Link>} flush>
          {alerts.error && <ErrorBox error={alerts.error} />}
          <div className="list">
            {(alerts.data?.alerts ?? []).map((a) => (
              <div className="list-item" key={a.id}>
                <SeverityBadge severity={a.severity} />
                <div>
                  <div className="title">{a.title}</div>
                  <div className="meta">{dateTimeCpt(a.ts)}{a.zone ? ` · ${a.zone.replace('_', ' ')}` : ''}</div>
                </div>
              </div>
            ))}
            {alerts.data && alerts.data.alerts.length === 0 && <div className="empty">No open alerts</div>}
          </div>
        </Card>
      </div>

      <div className="grid main-side">
        <Card title="Weather zones" sub="Latest interval" flush>
          {s && (
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>Zone</th><th className="num">Load</th><th className="num">Share</th><th className="num">Temperature</th></tr></thead>
                <tbody>
                  {Object.entries(s.zones).sort((a, b) => b[1].load_mw - a[1].load_mw).map(([z, v]) => (
                    <tr key={z}>
                      <td>{z.replace('_', ' ')}</td>
                      <td className="num">{mw(v.load_mw)}</td>
                      <td className="num">{pct((100 * v.load_mw) / s.load_mw)}</td>
                      <td className="num">{v.temp_f.toFixed(0)}°F</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
        <Card title="Active contingencies" flush>
          <div className="list">
            {(s?.active_event_details ?? []).map((e: GridEvent) => (
              <div className="list-item" key={e.event_id}>
                <SeverityBadge severity={e.severity} />
                <div>
                  <div className="title">{e.type.replace(/_/g, ' ')} · {e.zone.replace('_', ' ')}</div>
                  <div className="meta">{e.description}</div>
                  <div className="meta">Since {timeCpt(e.start)} CPT · until ~{timeCpt(e.end)}</div>
                </div>
              </div>
            ))}
            {s && s.active_event_details.length === 0 && <div className="empty">No active contingencies</div>}
          </div>
        </Card>
      </div>
    </>
  );
}

// ---- Chart options ------------------------------------------------------------------

function loadOption(c: ChartColors, points: GridInterval[], f?: ForecastResponse): EChartsOption {
  const base = baseOption(c, { yFormatter: (v) => `${(v / 1000).toFixed(1)} GW` });
  const fc = f?.points ?? [];
  return {
    ...base,
    series: [
      { name: 'Load', type: 'line', showSymbol: false, lineStyle: { width: 2 }, color: c['series-1'], data: points.map((p) => pt(p, p.load_mw)) },
      { name: 'Operational forecast', type: 'line', showSymbol: false, lineStyle: { width: 1.5, type: 'dashed' }, color: c['text-muted'], data: points.map((p) => pt(p, p.load_forecast_mw)) },
      { name: 'Net load', type: 'line', showSymbol: false, lineStyle: { width: 2 }, color: c['series-3'], data: points.map((p) => pt(p, p.net_load_mw)) },
      ...(fc.length
        ? [
            { name: 'P10', type: 'line', stack: 'band', showSymbol: false, lineStyle: { opacity: 0 }, data: fc.map((p) => [Date.parse(p.ts), p.p10_mw]), tooltip: { show: false } },
            { name: 'P10–P90', type: 'line', stack: 'band', showSymbol: false, lineStyle: { opacity: 0 }, areaStyle: { color: c.band }, color: c.band, data: fc.map((p) => [Date.parse(p.ts), p.p90_mw - p.p10_mw]), tooltip: { show: false } },
            { name: 'GridSight forecast', type: 'line', showSymbol: false, lineStyle: { width: 2, type: 'dashed' }, color: c['series-2'], data: fc.map((p) => [Date.parse(p.ts), p.forecast_mw]) },
          ]
        : []),
    ],
    legend: { ...(base.legend as object), data: ['Load', 'Operational forecast', 'Net load', ...(fc.length ? ['GridSight forecast', 'P10–P90'] : [])] },
  };
}

function mixOption(c: ChartColors, points: GridInterval[]): EChartsOption {
  return {
    ...baseOption(c, { yFormatter: (v) => `${(v / 1000).toFixed(1)} GW` }),
    series: FUEL_ORDER.map((f) => ({
      name: f.label,
      type: 'line',
      stack: 'gen',
      showSymbol: false,
      color: c[`fuel-${f.key}` as keyof ChartColors],
      // 1px surface-colored edge separates stacked fills.
      lineStyle: { width: 1, color: c['surface-1'] },
      areaStyle: { opacity: 0.92 },
      emphasis: { focus: 'series' },
      data: points.map((p) => pt(p, p.gen[f.key])),
    })),
  };
}

function freqOption(c: ChartColors, points: GridInterval[]): EChartsOption {
  const base = baseOption(c, { yFormatter: (v) => v.toFixed(3) });
  return {
    ...base,
    yAxis: { ...(base.yAxis as object), min: (v: { min: number }) => Math.min(59.94, Math.floor(v.min * 100) / 100), max: (v: { max: number }) => Math.max(60.06, Math.ceil(v.max * 100) / 100) },
    series: [
      { name: 'Min', type: 'line', stack: 'range', showSymbol: false, lineStyle: { opacity: 0 }, data: points.map((p) => pt(p, p.freq.min_hz)), tooltip: { show: false } },
      { name: 'Min–max range', type: 'line', stack: 'range', showSymbol: false, lineStyle: { opacity: 0 }, areaStyle: { color: c.band }, color: c.band, data: points.map((p) => pt(p, p.freq.max_hz - p.freq.min_hz)), tooltip: { show: false } },
      {
        name: 'Mean frequency', type: 'line', showSymbol: false, color: c['series-1'], lineStyle: { width: 2 }, data: points.map((p) => pt(p, p.freq.mean_hz)),
        markLine: {
          symbol: 'none', silent: true,
          lineStyle: { color: c['status-warning'], type: 'dashed', width: 1.5 },
          label: { color: c['text-secondary'], formatter: '{c} Hz', position: 'insideEndTop' },
          data: [{ yAxis: 59.95 }, { yAxis: 60.05 }],
        },
      },
      { name: 'Min frequency', type: 'line', showSymbol: false, color: c['series-2'], lineStyle: { width: 1.5 }, data: points.map((p) => pt(p, p.freq.min_hz)) },
    ],
    legend: { ...(base.legend as object), data: ['Mean frequency', 'Min frequency', 'Min–max range'] },
  };
}

function prcOption(c: ChartColors, points: GridInterval[]): EChartsOption {
  const base = baseOption(c, { yFormatter: (v) => `${(v / 1000).toFixed(1)} GW` });
  return {
    ...base,
    yAxis: { ...(base.yAxis as object), min: 0 },
    series: [
      {
        name: 'PRC', type: 'line', showSymbol: false, color: c['series-1'], lineStyle: { width: 2 }, areaStyle: { opacity: 0.08 }, data: points.map((p) => pt(p, p.reserves.prc_mw)),
        markLine: {
          symbol: 'none', silent: true,
          label: { color: c['text-secondary'], position: 'insideEndTop' },
          data: [
            { yAxis: 3000, name: 'Advisory', lineStyle: { color: c['status-warning'], type: 'dashed', width: 1.5 }, label: { formatter: 'Advisory 3.0 GW' } },
            { yAxis: 2500, name: 'EEA', lineStyle: { color: c['status-critical'], type: 'dashed', width: 1.5 }, label: { formatter: 'EEA level 2.5 GW' } },
          ],
        },
      },
    ],
    legend: { show: false },
  };
}

function priceOption(c: ChartColors, points: GridInterval[]): EChartsOption {
  return {
    ...baseOption(c, { yFormatter: (v) => `$${v.toFixed(0)}` }),
    series: HUBS.map((h, i) => ({
      name: h, type: 'line', showSymbol: false, lineStyle: { width: 1.75 },
      color: c[`series-${i + 1}` as keyof ChartColors],
      emphasis: { focus: 'series' },
      data: points.map((p) => pt(p, p.hubs[h].lmp)),
    })),
  };
}
