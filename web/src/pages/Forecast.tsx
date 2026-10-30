import { useState } from 'react';
import { api } from '../api/client';
import type { ForecastResponse } from '../api/types';
import { baseOption, Chart, useChartColors } from '../components/Chart';
import { ChartCard, ErrorBox, Kpi, Segmented, Skeleton } from '../components/ui';
import { dateTimeCpt, gw, num } from '../lib/format';
import { useAsync } from '../lib/hooks';

export function Forecast() {
  const [hours, setHours] = useState(48);
  const c = useChartColors();
  const { data, error, loading } = useAsync(() => api.get<ForecastResponse>(`/v1/forecast/load?hours=${hours}`), [hours]);
  const peak = data?.points.reduce((a, b) => (b.forecast_mw > a.forecast_mw ? b : a));
  const base = baseOption(c, { yFormatter: (v) => `${(v / 1000).toFixed(1)} GW` });

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Load forecast</h1>
          <p>Weather-normalized ridge regression retrained on the last 28 days on every request. Bands are P10–P90 from empirical residuals.</p>
        </div>
        <span className="spacer" />
        <Segmented label="Horizon" value={hours} onChange={setHours} options={[{ value: 24, label: '24h' }, { value: 48, label: '48h' }, { value: 72, label: '72h' }]} />
      </div>
      {error && <ErrorBox error={error} />}
      <div className="grid kpis">
        {data && peak ? (
          <>
            <Kpi label="Forecast peak" value={gw(peak.forecast_mw)} detail={`${dateTimeCpt(peak.ts)} · P90 ${gw(peak.p90_mw)}`} />
            <Kpi label="Backtest MAPE (24h)" value={data.backtest.mape_pct.toFixed(2)} unit="%" detail="Most recent day, held out" />
            <Kpi label="Seasonal-naive MAPE" value={data.backtest.naive_mape_pct.toFixed(2)} unit="%" detail="Same hour last week" />
            <Kpi label="Training window" value={num(data.trained_on_hours)} unit="h" detail={`Issued ${dateTimeCpt(data.issued_at)}`} />
          </>
        ) : Array.from({ length: 4 }, (_, i) => <Skeleton key={i} height={96} />)}
      </div>
      <ChartCard
        title="Actuals and forecast"
        sub={data?.model}
        chart={loading || !data ? <Skeleton height={380} /> : (
          <Chart
            height={380}
            ariaLabel="Recent actual load and forecast with P10 to P90 band"
            option={{
              ...base,
              series: [
                { name: 'Actual load', type: 'line', showSymbol: false, color: c['series-1'], lineStyle: { width: 2 }, data: data.recent_actuals.map((p) => [Date.parse(p.ts), p.load_mw]) },
                { name: 'Operational forecast', type: 'line', showSymbol: false, color: c['text-muted'], lineStyle: { width: 1.5, type: 'dashed' }, data: data.recent_actuals.map((p) => [Date.parse(p.ts), p.official_forecast_mw]) },
                { name: 'P10', type: 'line', stack: 'band', showSymbol: false, lineStyle: { opacity: 0 }, data: data.points.map((p) => [Date.parse(p.ts), p.p10_mw]), tooltip: { show: false } },
                { name: 'P10–P90', type: 'line', stack: 'band', showSymbol: false, lineStyle: { opacity: 0 }, areaStyle: { color: c.band }, color: c.band, data: data.points.map((p) => [Date.parse(p.ts), p.p90_mw - p.p10_mw]), tooltip: { show: false } },
                { name: 'GridSight forecast', type: 'line', showSymbol: false, color: c['series-2'], lineStyle: { width: 2 }, data: data.points.map((p) => [Date.parse(p.ts), p.forecast_mw]), markLine: { symbol: 'none', silent: true, lineStyle: { color: c['axis-line'], type: 'solid' }, label: { formatter: 'Now', color: c['text-secondary'] }, data: [{ xAxis: Date.parse(data.issued_at) }] } },
              ],
              legend: { ...(base.legend as object), data: ['Actual load', 'Operational forecast', 'GridSight forecast', 'P10–P90'] },
            }}
          />
        )}
        rows={(data?.points ?? []) as never}
        columns={[{ key: 'ts', label: 'Hour ending (CPT)', format: dateTimeCpt }, { key: 'forecast_mw', label: 'Forecast MW', num: true, format: num }, { key: 'p10_mw', label: 'P10', num: true, format: num }, { key: 'p90_mw', label: 'P90', num: true, format: num }, { key: 'temp_forecast_f', label: 'Temp °F', num: true, format: (v: number) => v.toFixed(1) }] as never}
      />
      <p className="note">Swap in your own model by replacing services/src/analytics/forecast.ts (keep the ForecastResult shape). See docs/extending.md.</p>
    </>
  );
}
