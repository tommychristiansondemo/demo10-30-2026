/**
 * Weather-normalized short-term load forecast.
 *
 * Model: ridge regression on hourly load with features
 *   - hour-of-day one-hot (24), split by weekday/weekend
 *   - cooling degree hours above 65°F and its square (AC load is convex in temperature)
 *   - heating degree hours below 55°F
 *   - cooling degree hours × daytime indicator (AC saturation is higher in the afternoon)
 * Prediction intervals come from empirical residual quantiles, widened with horizon.
 *
 * This is the same family of model utilities use as a transparent baseline. It's intentionally
 * small enough to read in one sitting so ERCOT engineers can swap in their own model
 * (see docs/extending.md → "Replace the forecaster").
 */
import { centralTime, HOUR_MS } from '../data/generator.js';

export interface HourlyObservation {
  epochMs: number;
  loadMw: number;
  tempF: number;
}

export interface ForecastPoint {
  ts: string;
  forecast_mw: number;
  p10_mw: number;
  p90_mw: number;
  temp_forecast_f: number;
}

export interface ForecastResult {
  model: string;
  trained_on_hours: number;
  backtest: { horizon_hours: number; mape_pct: number; naive_mape_pct: number };
  points: ForecastPoint[];
}

function features(epochMs: number, tempF: number): number[] {
  const { hour, dow } = centralTime(epochMs);
  const h = Math.floor(hour);
  const weekend = dow === 0 || dow === 6;
  const x = new Array(48 + 4).fill(0);
  x[(weekend ? 24 : 0) + h] = 1;
  const cdh = Math.max(0, tempF - 65);
  const hdh = Math.max(0, 55 - tempF);
  const daytime = h >= 11 && h <= 20 ? 1 : 0;
  x[48] = cdh / 10;
  x[49] = (cdh * cdh) / 100;
  x[50] = hdh / 10;
  x[51] = (cdh * daytime) / 10;
  return x;
}

/** Solve (XᵀX + λI)β = Xᵀy with Cholesky decomposition. */
export function ridgeFit(X: number[][], y: number[], lambda = 1e-3): number[] {
  const p = X[0].length;
  const A = Array.from({ length: p }, () => new Array(p).fill(0));
  const b = new Array(p).fill(0);
  for (let r = 0; r < X.length; r++) {
    const row = X[r];
    for (let i = 0; i < p; i++) {
      if (row[i] === 0) continue;
      b[i] += row[i] * y[r];
      for (let j = 0; j < p; j++) A[i][j] += row[i] * row[j];
    }
  }
  for (let i = 0; i < p; i++) A[i][i] += lambda;
  // Cholesky: A = L Lᵀ
  const L = Array.from({ length: p }, () => new Array(p).fill(0));
  for (let i = 0; i < p; i++) {
    for (let j = 0; j <= i; j++) {
      let sum = A[i][j];
      for (let k = 0; k < j; k++) sum -= L[i][k] * L[j][k];
      L[i][j] = i === j ? Math.sqrt(Math.max(sum, 1e-12)) : sum / L[j][j];
    }
  }
  const z = new Array(p).fill(0);
  for (let i = 0; i < p; i++) {
    let sum = b[i];
    for (let k = 0; k < i; k++) sum -= L[i][k] * z[k];
    z[i] = sum / L[i][i];
  }
  const beta = new Array(p).fill(0);
  for (let i = p - 1; i >= 0; i--) {
    let sum = z[i];
    for (let k = i + 1; k < p; k++) sum -= L[k][i] * beta[k];
    beta[i] = sum / L[i][i];
  }
  return beta;
}

const dot = (a: number[], b: number[]) => a.reduce((s, v, i) => s + v * b[i], 0);

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

const mape = (actual: number[], pred: number[]) =>
  (100 * actual.reduce((s, a, i) => s + Math.abs(a - pred[i]) / Math.max(1, a), 0)) / Math.max(1, actual.length);

/**
 * Train on `history` (hourly, ascending) and forecast `horizonHours` ahead using
 * `tempForecast(epochMs)` for future temperatures.
 */
export function forecastLoad(
  history: HourlyObservation[],
  horizonHours: number,
  tempForecast: (epochMs: number) => number,
): ForecastResult {
  if (history.length < 24 * 7) throw new Error('forecastLoad needs at least 7 days of hourly history');
  const holdout = 24;
  const train = history.slice(0, -holdout);
  const test = history.slice(-holdout);

  // Backtest on the most recent day so users can see how much to trust the model.
  const betaBt = ridgeFit(train.map((o) => features(o.epochMs, o.tempF)), train.map((o) => o.loadMw));
  const btPred = test.map((o) => dot(features(o.epochMs, o.tempF), betaBt));
  const naivePred = test.map((o) => {
    const prior = history.find((h) => h.epochMs === o.epochMs - 7 * 24 * HOUR_MS);
    return prior ? prior.loadMw : o.loadMw;
  });

  const X = history.map((o) => features(o.epochMs, o.tempF));
  const y = history.map((o) => o.loadMw);
  const beta = ridgeFit(X, y);
  const residuals = X.map((x, i) => y[i] - dot(x, beta)).sort((a, b) => a - b);
  const r10 = quantile(residuals, 0.1);
  const r90 = quantile(residuals, 0.9);

  const last = history[history.length - 1].epochMs;
  const points: ForecastPoint[] = [];
  for (let h = 1; h <= horizonHours; h++) {
    const t = last + h * HOUR_MS;
    const temp = tempForecast(t);
    const f = dot(features(t, temp), beta);
    const widen = 1 + 0.02 * h; // forecast uncertainty grows with horizon (weather error)
    points.push({
      ts: new Date(t).toISOString(),
      forecast_mw: Math.round(f),
      p10_mw: Math.round(f + r10 * widen),
      p90_mw: Math.round(f + r90 * widen),
      temp_forecast_f: Math.round(temp * 10) / 10,
    });
  }
  return {
    model: 'ridge-regression(hour×daytype + CDH/HDH)',
    trained_on_hours: history.length,
    backtest: {
      horizon_hours: holdout,
      mape_pct: Math.round(mape(test.map((o) => o.loadMw), btPred) * 100) / 100,
      naive_mape_pct: Math.round(mape(test.map((o) => o.loadMw), naivePred) * 100) / 100,
    },
    points,
  };
}
