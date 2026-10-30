/**
 * Anomaly detection over 5-minute grid intervals.
 *
 * Two layers:
 *   1. Rule-based operating limits that grid operators already think in (frequency band,
 *      PRC thresholds, load forecast deviation, net-load ramp).
 *   2. Statistical detectors that catch things rules miss: robust z-scores (median/MAD) on
 *      first differences, and flatline detection for stale telemetry.
 *
 * Detectors are pure functions so they can run in the 5-minute generator, on demand from the
 * API, or inside the AI agent's `detect_anomalies` tool with identical results.
 */
import { WEATHER_ZONES, type GridInterval, type Severity } from '../data/types.js';

export interface AnomalyThresholds {
  freqLowHz: number;
  freqHighHz: number;
  prcWarnMw: number;
  prcCriticalMw: number;
  forecastDeviationPct: number;
  netLoadRampMwPer30Min: number;
  zScore: number;
  flatlineIntervals: number;
}

export const DEFAULT_THRESHOLDS: AnomalyThresholds = {
  freqLowHz: 59.95,
  freqHighHz: 60.05,
  prcWarnMw: 3000,
  prcCriticalMw: 2500,
  forecastDeviationPct: 5,
  netLoadRampMwPer30Min: 4500,
  zScore: 5,
  flatlineIntervals: 4,
};

export interface Anomaly {
  /** Deterministic id so re-running detection over the same window is idempotent. */
  id: string;
  ts: string;
  type:
    | 'FREQUENCY_EXCURSION'
    | 'LOW_RESERVES'
    | 'FORECAST_DEVIATION'
    | 'NET_LOAD_RAMP'
    | 'STATISTICAL_OUTLIER'
    | 'STALE_TELEMETRY'
    | 'PRICE_SPIKE';
  metric: string;
  severity: Severity;
  value: number;
  expected?: number;
  score?: number;
  zone?: string;
  title: string;
  message: string;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Median and scaled MAD (1.4826 makes MAD consistent with σ for normal data). */
export function robustStats(xs: number[]): { med: number; mad: number } {
  const med = median(xs);
  return { med, mad: median(xs.map((v) => Math.abs(v - med))) * 1.4826 };
}

const zFrom = ({ med, mad }: { med: number; mad: number }, x: number) => (mad < 1e-9 ? 0 : (x - med) / mad);

/** Robust z-score of `x` relative to the reference set `xs`. */
export function robustZ(xs: number[], x: number): number {
  return zFrom(robustStats(xs), x);
}

const key = (type: string, metric: string, ts: string) => `${type}#${metric}#${ts}`;

/**
 * Detect anomalies in `intervals` (ascending). Only intervals at index >= `evaluateFrom`
 * produce findings; earlier ones provide statistical context.
 */
export function detectAnomalies(
  intervals: GridInterval[],
  thresholds: AnomalyThresholds = DEFAULT_THRESHOLDS,
  evaluateFrom = 0,
): Anomaly[] {
  const out: Anomaly[] = [];
  const push = (a: Omit<Anomaly, 'id'>) => out.push({ ...a, id: key(a.type, a.metric + (a.zone ? `:${a.zone}` : ''), a.ts) });

  const windDiffs = intervals.slice(1).map((iv, i) => iv.gen.wind - intervals[i].gen.wind);
  const lambdaSeries = intervals.map((iv) => iv.system_lambda);
  const windStats = robustStats(windDiffs);
  const lambdaStats = robustStats(lambdaSeries);

  for (let i = Math.max(0, evaluateFrom); i < intervals.length; i++) {
    const iv = intervals[i];

    // 1. Frequency band
    if (iv.freq.min_hz < thresholds.freqLowHz) {
      const depth = 60 - iv.freq.min_hz;
      push({
        ts: iv.ts,
        type: 'FREQUENCY_EXCURSION',
        metric: 'freq_min_hz',
        severity: iv.freq.min_hz < 59.9 ? 'CRITICAL' : 'WARNING',
        value: iv.freq.min_hz,
        expected: 60,
        title: `Frequency dipped to ${iv.freq.min_hz.toFixed(3)} Hz`,
        message: `System frequency fell ${(depth * 1000).toFixed(0)} mHz below nominal, consistent with a sudden loss of generation. Verify primary frequency response and RRS deployment.`,
      });
    }
    if (iv.freq.max_hz > thresholds.freqHighHz) {
      push({
        ts: iv.ts,
        type: 'FREQUENCY_EXCURSION',
        metric: 'freq_max_hz',
        severity: 'WARNING',
        value: iv.freq.max_hz,
        expected: 60,
        title: `Frequency rose to ${iv.freq.max_hz.toFixed(3)} Hz`,
        message: 'Over-frequency excursion: check for a large load loss or excessive regulation-up deployment.',
      });
    }

    // 2. Physical responsive capability
    const prc = iv.reserves.prc_mw;
    if (prc < thresholds.prcWarnMw && (i === 0 || intervals[i - 1].reserves.prc_mw >= thresholds.prcWarnMw || prc < thresholds.prcCriticalMw)) {
      push({
        ts: iv.ts,
        type: 'LOW_RESERVES',
        metric: 'prc_mw',
        severity: prc < thresholds.prcCriticalMw ? 'CRITICAL' : 'WARNING',
        value: prc,
        expected: thresholds.prcWarnMw,
        title: `PRC at ${Math.round(prc).toLocaleString('en-US')} MW`,
        message:
          prc < thresholds.prcCriticalMw
            ? 'Physical Responsive Capability is below the EEA-level threshold. Review emergency procedures and available load resources.'
            : 'Physical Responsive Capability is below the advisory threshold. Monitor closely for further decline.',
      });
    }

    // 3. Load vs forecast
    const devPct = (100 * (iv.load_mw - iv.load_forecast_mw)) / iv.load_forecast_mw;
    const prevDev = i > 0 ? (100 * (intervals[i - 1].load_mw - intervals[i - 1].load_forecast_mw)) / intervals[i - 1].load_forecast_mw : 0;
    if (Math.abs(devPct) >= thresholds.forecastDeviationPct && Math.abs(prevDev) < thresholds.forecastDeviationPct) {
      push({
        ts: iv.ts,
        type: 'FORECAST_DEVIATION',
        metric: 'load_mw',
        severity: Math.abs(devPct) >= thresholds.forecastDeviationPct * 1.5 ? 'CRITICAL' : 'WARNING',
        value: iv.load_mw,
        expected: iv.load_forecast_mw,
        score: Math.round(devPct * 100) / 100,
        title: `Load ${devPct > 0 ? 'above' : 'below'} forecast by ${Math.abs(devPct).toFixed(1)}%`,
        message: `Actual load ${Math.round(iv.load_mw).toLocaleString('en-US')} MW vs forecast ${Math.round(iv.load_forecast_mw).toLocaleString('en-US')} MW. Consider updating the short-term forecast and reviewing commitment (RUC).`,
      });
    }

    // 4. Net-load ramp over 30 minutes
    if (i >= 6) {
      const ramp = iv.net_load_mw - intervals[i - 6].net_load_mw;
      const prevRamp = i >= 7 ? intervals[i - 1].net_load_mw - intervals[i - 7].net_load_mw : 0;
      if (Math.abs(ramp) >= thresholds.netLoadRampMwPer30Min && Math.abs(prevRamp) < thresholds.netLoadRampMwPer30Min) {
        push({
          ts: iv.ts,
          type: 'NET_LOAD_RAMP',
          metric: 'net_load_mw',
          severity: 'WARNING',
          value: Math.round(ramp),
          expected: 0,
          title: `Net load ${ramp > 0 ? 'up' : 'down'}-ramp of ${Math.abs(Math.round(ramp)).toLocaleString('en-US')} MW in 30 min`,
          message: 'Steep net-load ramp (load minus wind and solar). Confirm ramp capability and ECRS/Non-Spin availability.',
        });
      }
    }

    // 5. Statistical: wind output first-difference outlier (sudden ramps)
    if (i >= 1 && windDiffs.length > 24) {
      const d = intervals[i].gen.wind - intervals[i - 1].gen.wind;
      const z = zFrom(windStats, d);
      const prevZ = i >= 2 ? zFrom(windStats, intervals[i - 1].gen.wind - intervals[i - 2].gen.wind) : 0;
      if (Math.abs(z) >= thresholds.zScore && Math.abs(prevZ) < thresholds.zScore) {
        push({
          ts: iv.ts,
          type: 'STATISTICAL_OUTLIER',
          metric: 'gen_wind_mw',
          severity: Math.abs(z) > thresholds.zScore * 2 ? 'CRITICAL' : 'WARNING',
          value: Math.round(d),
          score: Math.round(z * 10) / 10,
          title: `Unusual wind output change (${d > 0 ? '+' : ''}${Math.round(d).toLocaleString('en-US')} MW in 5 min)`,
          message: `5-minute wind change is ${Math.abs(z).toFixed(1)} robust standard deviations from normal. Possible ramp event or telemetry issue.`,
        });
      }
    }

    // 6. Price spike (robust z on system lambda, with an absolute floor)
    if (lambdaSeries.length > 24 && iv.system_lambda > 250) {
      const z = zFrom(lambdaStats, iv.system_lambda);
      if (z >= thresholds.zScore && (i === 0 || intervals[i - 1].system_lambda <= 250)) {
        push({
          ts: iv.ts,
          type: 'PRICE_SPIKE',
          metric: 'system_lambda',
          severity: iv.system_lambda > 1000 ? 'CRITICAL' : 'WARNING',
          value: iv.system_lambda,
          score: Math.round(z * 10) / 10,
          title: `System lambda spiked to $${iv.system_lambda.toFixed(0)}/MWh`,
          message: 'Real-time price spike, typically driven by the ORDC reserve adder as reserves tighten.',
        });
      }
    }

    // 7. Flatline (stale telemetry) on zone loads
    const n = thresholds.flatlineIntervals;
    if (i >= n) {
      for (const z of WEATHER_ZONES) {
        const v = iv.zones[z].load_mw;
        let flat = true;
        for (let k = 1; k <= n && flat; k++) flat = intervals[i - k].zones[z].load_mw === v;
        const wasFlat = i > n && (() => {
          for (let k = 1; k <= n; k++) if (intervals[i - 1 - k].zones[z].load_mw !== intervals[i - 1].zones[z].load_mw) return false;
          return true;
        })();
        if (flat && !wasFlat) {
          push({
            ts: iv.ts,
            type: 'STALE_TELEMETRY',
            metric: 'zone_load_mw',
            zone: z,
            severity: 'WARNING',
            value: v,
            title: `Stale telemetry: ${z.replace('_', ' ')} load frozen`,
            message: `${z} load has reported exactly ${v.toLocaleString('en-US')} MW for ${n + 1} consecutive intervals. Check ICCP links and the EMS data path before trusting downstream analytics.`,
          });
        }
      }
    }
  }
  return out;
}
