import { describe, expect, it } from 'vitest';
import { DEFAULT_THRESHOLDS, detectAnomalies, robustZ } from '../src/analytics/anomaly.js';
import { forecastLoad, ridgeFit } from '../src/analytics/forecast.js';
import { eventsBetween, forecastTemperature, generateRange, HOUR_MS, rollup, systemTemperature } from '../src/data/generator.js';

const end = Date.parse('2026-08-15T05:00:00Z');

describe('ridge regression', () => {
  it('recovers known coefficients', () => {
    const X = Array.from({ length: 200 }, (_, i) => [1, i / 10, Math.sin(i)]);
    const y = X.map((x) => 3 + 2 * x[1] - 5 * x[2]);
    const b = ridgeFit(X, y, 1e-9);
    expect(b[0]).toBeCloseTo(3, 3);
    expect(b[1]).toBeCloseTo(2, 3);
    expect(b[2]).toBeCloseTo(-5, 3);
  });
});

describe('load forecast', () => {
  it('beats a seasonal-naive baseline and produces sane bands', () => {
    const fiveMin = generateRange(end - 28 * 24 * HOUR_MS, end);
    const hourly = [];
    for (let i = 0; i + 12 <= fiveMin.length; i += 12) hourly.push(rollup(fiveMin.slice(i, i + 12), fiveMin[i + 11].ts));
    const obs = hourly.map((h) => ({ epochMs: h.epoch_ms, loadMw: h.load_mw, tempF: systemTemperature(h) }));
    const issued = obs[obs.length - 1].epochMs;
    const f = forecastLoad(obs, 48, (t) => forecastTemperature(t, issued));
    expect(f.points).toHaveLength(48);
    expect(f.backtest.mape_pct).toBeLessThan(5);
    expect(f.backtest.mape_pct).toBeLessThan(f.backtest.naive_mape_pct + 1);
    for (const p of f.points) {
      expect(p.p10_mw).toBeLessThanOrEqual(p.forecast_mw);
      expect(p.p90_mw).toBeGreaterThanOrEqual(p.forecast_mw);
    }
  });
});

describe('anomaly detection', () => {
  it('robust z-score ignores outliers in the reference set', () => {
    const xs = [...Array(100).fill(0).map((_, i) => i % 5), 1000];
    expect(Math.abs(robustZ(xs, 2))).toBeLessThan(1);
    expect(robustZ(xs, 50)).toBeGreaterThan(10);
  });

  it('flags frequency dips from unit trips and is idempotent', () => {
    const start = end - 30 * 24 * HOUR_MS;
    const data = generateRange(start, end);
    const bigTrips = eventsBetween(start + 24 * HOUR_MS, end).filter((e) => e.type === 'UNIT_TRIP' && 60 - 0.000085 * e.mw_impact < DEFAULT_THRESHOLDS.freqLowHz);
    const found = detectAnomalies(data);
    const freq = found.filter((a) => a.type === 'FREQUENCY_EXCURSION');
    for (const trip of bigTrips) expect(freq.some((a) => a.ts === trip.start)).toBe(true);
    expect(detectAnomalies(data).map((a) => a.id)).toEqual(found.map((a) => a.id));
    expect(new Set(found.map((a) => a.id)).size).toBe(found.length);
  });

  it('flags stale telemetry', () => {
    const e = eventsBetween(end - 90 * 24 * HOUR_MS, end).find((x) => x.type === 'TELEMETRY_STALE')!;
    const s = Date.parse(e.start);
    const data = generateRange(s - 6 * HOUR_MS, Date.parse(e.end));
    const found = detectAnomalies(data).filter((a) => a.type === 'STALE_TELEMETRY');
    expect(found.some((a) => a.zone === e.zone)).toBe(true);
  });
});
