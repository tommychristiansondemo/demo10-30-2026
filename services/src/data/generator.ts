/**
 * Deterministic synthetic grid model for an ERCOT-like system.
 *
 * Every value is a pure function of (timestamp, seed). That gives us three properties
 * that matter for a demo platform:
 *   1. The historical backfill and the live 5-minute generator always agree.
 *   2. Anomalies and contingencies are reproducible, so tests can assert on them.
 *   3. No live ERCOT feed or credentials are needed.
 *
 * The physics are deliberately simplified (see docs/adr/0004-synthetic-data-model.md) but the
 * relationships engineers expect hold: load follows temperature and time of day, gas balances
 * the system, low reserves drive ORDC-style price adders, and generator trips cause frequency
 * dips proportional to the MW lost.
 */
import {
  FUELS,
  TRADING_HUBS,
  WEATHER_ZONES,
  type EventType,
  type Fuel,
  type GridEvent,
  type GridInterval,
  type HubPrice,
  type Severity,
  type TradingHub,
  type WeatherZone,
  type ZoneState,
} from './types.js';

export const INTERVAL_MS = 5 * 60 * 1000;
export const HOUR_MS = 60 * 60 * 1000;
const DEFAULT_SEED = 'gridsight-ercot-v1';

// Installed capacity assumptions (MW), loosely in line with a 2026-era Texas grid.
const CAP = {
  wind: 40_500,
  solar: 33_000,
  storage: 12_000,
  coal: 13_500,
  gas: 50_000,
  nuclear: 5_100,
};

const ZONE_PARAMS: Record<WeatherZone, { share: number; tempOffset: number; diurnal: number; weatherSens: number }> = {
  NORTH_CENTRAL: { share: 0.31, tempOffset: -1, diurnal: 10, weatherSens: 1.05 },
  COAST: { share: 0.25, tempOffset: 1, diurnal: 8, weatherSens: 1.0 },
  SOUTH_CENTRAL: { share: 0.15, tempOffset: 1, diurnal: 10, weatherSens: 1.05 },
  FAR_WEST: { share: 0.09, tempOffset: -2, diurnal: 13, weatherSens: 0.35 },
  SOUTHERN: { share: 0.08, tempOffset: 4, diurnal: 9, weatherSens: 1.0 },
  EAST: { share: 0.05, tempOffset: 0, diurnal: 10, weatherSens: 1.0 },
  WEST: { share: 0.04, tempOffset: -1, diurnal: 12, weatherSens: 0.8 },
  NORTH: { share: 0.03, tempOffset: -4, diurnal: 11, weatherSens: 1.0 },
};

// ---------------------------------------------------------------------------
// Deterministic noise primitives
// ---------------------------------------------------------------------------

/** 32-bit FNV-1a followed by a murmur-style finalizer; returns a float in [0, 1). */
export function hash01(...parts: (string | number)[]): number {
  const s = parts.join('|');
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Smooth value noise in [-1, 1] with knots every `periodHours`. */
function smooth(seed: string, key: string, hours: number, periodHours: number): number {
  const x = hours / periodHours;
  const k = Math.floor(x);
  const f = x - k;
  const a = hash01(seed, key, periodHours, k) * 2 - 1;
  const b = hash01(seed, key, periodHours, k + 1) * 2 - 1;
  const w = (1 - Math.cos(Math.PI * f)) / 2;
  return a * (1 - w) + b * w;
}

const gauss = (x: number, mu: number, sigma: number) => Math.exp(-((x - mu) ** 2) / (2 * sigma * sigma));
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const r1 = (x: number) => Math.round(x * 10) / 10;
const r2 = (x: number) => Math.round(x * 100) / 100;
const r4 = (x: number) => Math.round(x * 10000) / 10000;

// ---------------------------------------------------------------------------
// Calendar helpers (ERCOT runs on Central Prevailing Time)
// ---------------------------------------------------------------------------

function nthSundayUtc(year: number, month: number, n: number, hourUtc: number): number {
  const first = new Date(Date.UTC(year, month, 1));
  const offset = (7 - first.getUTCDay()) % 7;
  return Date.UTC(year, month, 1 + offset + 7 * (n - 1), hourUtc);
}

/** Returns the UTC offset (hours) for US Central time at the given instant. */
export function centralOffsetHours(epochMs: number): number {
  const year = new Date(epochMs).getUTCFullYear();
  const dstStart = nthSundayUtc(year, 2, 2, 8); // 2nd Sunday of March, 02:00 CST
  const dstEnd = nthSundayUtc(year, 10, 1, 7); // 1st Sunday of November, 02:00 CDT
  return epochMs >= dstStart && epochMs < dstEnd ? -5 : -6;
}

export function centralTime(epochMs: number) {
  const local = new Date(epochMs + centralOffsetHours(epochMs) * HOUR_MS);
  const hour = local.getUTCHours() + local.getUTCMinutes() / 60;
  const start = Date.UTC(local.getUTCFullYear(), 0, 0);
  const doy = Math.floor((local.getTime() - start) / 86_400_000);
  return { hour, dow: local.getUTCDay(), doy };
}

export function floorToInterval(epochMs: number): number {
  return Math.floor(epochMs / INTERVAL_MS) * INTERVAL_MS;
}

// ---------------------------------------------------------------------------
// Events (contingencies and data-quality issues)
// ---------------------------------------------------------------------------

const EVENT_SPECS: {
  type: EventType;
  pPerHour: number;
  zones: WeatherZone[];
  build: (u: number) => { mw: number; durationMin: number; severity: Severity; description: string };
}[] = [
  {
    type: 'UNIT_TRIP',
    pPerHour: 0.012,
    zones: ['COAST', 'NORTH_CENTRAL', 'SOUTH_CENTRAL', 'EAST', 'FAR_WEST'],
    build: (u) => {
      const mw = Math.round(400 + u * 1000);
      return {
        mw,
        durationMin: 120 + Math.round(u * 480),
        severity: mw >= 1000 ? 'CRITICAL' : 'WARNING',
        description: `Forced outage of a ${mw} MW combined-cycle unit (breaker trip)`,
      };
    },
  },
  {
    type: 'WIND_RAMP',
    pPerHour: 0.006,
    zones: ['WEST', 'FAR_WEST', 'NORTH'],
    build: (u) => {
      const mw = Math.round(2500 + u * 2500);
      return {
        mw,
        durationMin: 180 + Math.round(u * 180),
        severity: mw >= 4000 ? 'CRITICAL' : 'WARNING',
        description: `Rapid down-ramp of ${mw} MW of wind output following a frontal passage`,
      };
    },
  },
  {
    type: 'TRANSMISSION_OUTAGE',
    pPerHour: 0.005,
    zones: ['COAST', 'FAR_WEST', 'WEST', 'SOUTHERN', 'NORTH_CENTRAL'],
    build: (u) => ({
      mw: Math.round(600 + u * 900),
      durationMin: 180 + Math.round(u * 540),
      severity: 'WARNING',
      description: '345 kV line forced outage; post-contingency overload managed via SCED constraint',
    }),
  },
  {
    type: 'TELEMETRY_STALE',
    pPerHour: 0.004,
    zones: [...WEATHER_ZONES],
    build: (u) => ({
      mw: 0,
      durationMin: 30 + Math.round(u * 60),
      severity: 'WARNING',
      description: 'ICCP telemetry for zone load stopped updating (stale/frozen value)',
    }),
  },
  {
    type: 'LOAD_FORECAST_MISS',
    pPerHour: 0.004,
    zones: ['NORTH_CENTRAL', 'COAST', 'SOUTH_CENTRAL'],
    build: (u) => ({
      mw: Math.round(4 + u * 3), // percent
      durationMin: 180 + Math.round(u * 180),
      severity: 'WARNING',
      description: 'Actual load running materially above the load forecast (weather model miss)',
    }),
  },
];

function isoMinute(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 16).replace(/[-:T]/g, '');
}

function eventsStartingInHour(hourIndex: number, seed: string): GridEvent[] {
  const out: GridEvent[] = [];
  for (const spec of EVENT_SPECS) {
    if (hash01(seed, 'evt', spec.type, hourIndex) >= spec.pPerHour) continue;
    const u = hash01(seed, 'evt-u', spec.type, hourIndex);
    const startMs = hourIndex * HOUR_MS + Math.floor(hash01(seed, 'evt-m', spec.type, hourIndex) * 12) * INTERVAL_MS;
    const zone = spec.zones[Math.floor(hash01(seed, 'evt-z', spec.type, hourIndex) * spec.zones.length)];
    const b = spec.build(u);
    out.push({
      event_id: `${spec.type}-${isoMinute(startMs)}`,
      type: spec.type,
      start: new Date(startMs).toISOString(),
      end: new Date(startMs + b.durationMin * 60_000).toISOString(),
      zone,
      severity: b.severity,
      mw_impact: b.mw,
      description: `${b.description} (${zone.replace('_', ' ')} weather zone).`,
    });
  }
  return out;
}

const MAX_EVENT_HOURS = 13;

/** All events whose window overlaps [startMs, endMs). */
export function eventsBetween(startMs: number, endMs: number, seed = DEFAULT_SEED): GridEvent[] {
  const out: GridEvent[] = [];
  const firstHour = Math.floor(startMs / HOUR_MS) - MAX_EVENT_HOURS;
  const lastHour = Math.floor(endMs / HOUR_MS);
  for (let h = firstHour; h <= lastHour; h++) {
    for (const e of eventsStartingInHour(h, seed)) {
      const s = Date.parse(e.start);
      const en = Date.parse(e.end);
      if (s < endMs && en > startMs) out.push(e);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Weather and load
// ---------------------------------------------------------------------------

function seasonal(doy: number) {
  const summer = Math.max(0, -Math.cos((2 * Math.PI * (doy - 20)) / 365)); // 0..1, peaks late July
  const winter = Math.max(0, Math.cos((2 * Math.PI * (doy - 20)) / 365)); // 0..1, peaks mid January
  return { summer, winter };
}

export function zoneTemperature(epochMs: number, zone: WeatherZone, seed = DEFAULT_SEED): number {
  const { hour, doy } = centralTime(epochMs);
  const { winter } = seasonal(doy);
  const hours = epochMs / HOUR_MS;
  const p = ZONE_PARAMS[zone];
  const seasonalMean = 68 - 18 * Math.cos((2 * Math.PI * (doy - 20)) / 365);
  const diurnal = p.diurnal * Math.cos((2 * Math.PI * (hour - 16)) / 24);
  const synoptic = (7 + 6 * winter) * smooth(seed, 'wx', hours, 72) + 3 * smooth(seed, 'wx2', hours, 18);
  const local = 2 * smooth(seed, `wx-${zone}`, hours, 24);
  return seasonalMean + p.tempOffset + diurnal + synoptic + local;
}

function dayShape(hour: number): number {
  return Math.min(1, 0.55 * gauss(hour, 8.5, 2) + 0.7 * gauss(hour, 13.5, 4) + 0.9 * gauss(hour, 19, 2.3));
}

function zoneLoadRaw(epochMs: number, zone: WeatherZone, temp: number, seed: string): number {
  const { hour, dow } = centralTime(epochMs);
  const p = ZONE_PARAMS[zone];
  const shape = dayShape(hour);
  const weekend = dow === 0 ? 0.92 : dow === 6 ? 0.94 : 1;
  const base = (38_000 + 7_000 * shape) * weekend;
  const cooling = Math.max(0, temp - 70) * 1_150 * (0.75 + 0.25 * shape);
  const heating = Math.max(0, 52 - temp) * 1_000;
  let load = p.share * (base + p.weatherSens * (cooling + heating));
  if (zone === 'FAR_WEST') load = 0.7 * load + 0.3 * p.share * 52_000; // flat oil & gas industrial load
  const noise = 1 + 0.004 * smooth(seed, `ld-${zone}`, epochMs / HOUR_MS, 0.5) + 0.0015 * (hash01(seed, 'j', zone, epochMs) - 0.5);
  return load * noise;
}

// ---------------------------------------------------------------------------
// Main model
// ---------------------------------------------------------------------------

export interface GenerateOptions {
  seed?: string;
}

/** Generate the grid state for the 5-minute interval ending at `epochMs` (floored to the interval). */
export function generateInterval(epochMsInput: number, opts: GenerateOptions = {}): GridInterval {
  const seed = opts.seed ?? DEFAULT_SEED;
  const epochMs = floorToInterval(epochMsInput);
  const hours = epochMs / HOUR_MS;
  const { hour, doy } = centralTime(epochMs);
  const { summer, winter } = seasonal(doy);

  const events = eventsBetween(epochMs, epochMs + 1, seed);
  const active = events.filter((e) => Date.parse(e.start) <= epochMs && Date.parse(e.end) > epochMs);
  const startsNow = (e: GridEvent) => Date.parse(e.start) === epochMs;

  // --- Weather & load by zone -------------------------------------------------
  const zones = {} as Record<WeatherZone, ZoneState>;
  let load = 0;
  let forecastBase = 0;
  for (const z of WEATHER_ZONES) {
    const temp = zoneTemperature(epochMs, z, seed);
    let zl = zoneLoadRaw(epochMs, z, temp, seed);
    forecastBase += zl;
    const miss = active.find((e) => e.type === 'LOAD_FORECAST_MISS' && e.zone === z);
    if (miss) zl *= 1 + miss.mw_impact / 100;
    load += zl;
    zones[z] = { load_mw: r1(zl), temp_f: r1(temp) };
  }
  const loadForecast = forecastBase * (1 + 0.02 * smooth(seed, 'fcst', hours, 10));

  // Stale telemetry: the zone's reported load is frozen at the value seen when the event began.
  let dataQuality: GridInterval['data_quality'] = 'GOOD';
  for (const e of active.filter((x) => x.type === 'TELEMETRY_STALE')) {
    const startMs = Date.parse(e.start);
    const frozenTemp = zoneTemperature(startMs, e.zone, seed);
    zones[e.zone] = { load_mw: r1(zoneLoadRaw(startMs, e.zone, frozenTemp, seed)), temp_f: r1(frozenTemp) };
    dataQuality = 'STALE';
  }

  // --- Renewables -----------------------------------------------------------
  let windCf =
    0.38 +
    0.18 * smooth(seed, 'wind', hours, 30) +
    0.12 * smooth(seed, 'wind2', hours, 6) +
    0.07 * Math.cos((2 * Math.PI * (doy - 100)) / 365) +
    0.06 * Math.cos((2 * Math.PI * (hour - 2)) / 24);
  windCf = clamp(windCf, 0.03, 0.78);
  let wind = CAP.wind * windCf;
  for (const e of active.filter((x) => x.type === 'WIND_RAMP')) {
    const elapsed = (epochMs - Date.parse(e.start)) / 60_000;
    const remaining = (Date.parse(e.end) - epochMs) / 60_000;
    const factor = Math.min(1, elapsed / 45, remaining / 60);
    wind = Math.max(CAP.wind * 0.02, wind - e.mw_impact * factor);
  }

  const decl = ((23.44 * Math.PI) / 180) * Math.sin((2 * Math.PI * (284 + doy)) / 365);
  const lat = (31 * Math.PI) / 180;
  const utcHour = (epochMs % 86_400_000) / HOUR_MS;
  const hourAngle = ((15 * (utcHour - 6.53 - 12)) * Math.PI) / 180;
  const sinElev = Math.sin(lat) * Math.sin(decl) + Math.cos(lat) * Math.cos(decl) * Math.cos(hourAngle);
  const cloud = clamp(1 - 0.45 * Math.max(0, smooth(seed, 'cloud', hours, 8)) - 0.12 * winter, 0.2, 1);
  let solar = CAP.solar * 0.82 * Math.pow(Math.max(0, sinElev), 1.15) * cloud;

  // --- Firm resources ---------------------------------------------------------
  const refuel = (doy >= 75 && doy < 105) || (doy >= 280 && doy < 305);
  const nuclear = CAP.nuclear - (refuel ? 1_250 : 0) - 15 * Math.abs(smooth(seed, 'nuc', hours, 48));
  const hydro = Math.max(40, 150 + 100 * smooth(seed, 'hydro', hours, 24));
  const other = 350 + 40 * smooth(seed, 'other', hours, 12);

  const storageDischarge = 0.55 * gauss(hour, 19.5, 1.6) + 0.15 * gauss(hour, 7.5, 1.2);
  const storageCharge = solar > CAP.solar * 0.3 ? 0.5 * gauss(hour, 12.5, 2.5) : 0.05 * gauss(hour, 3, 2);
  let storage = CAP.storage * (storageDischarge - storageCharge);

  const coalCommitted = CAP.coal * (0.55 + 0.35 * Math.max(summer, winter));
  const netLoadPre = load - wind - solar;
  let coal = coalCommitted * clamp(0.6 + 0.4 * ((netLoadPre - 30_000) / 40_000), 0.45, 1);

  // --- Gas balances the system; curtail renewables if gas is at its floor ---------
  const gasMin = 6_500;
  let residual = load - (nuclear + coal + wind + solar + storage + hydro + other);
  let curtailment = 0;
  if (residual < gasMin) {
    const coalFloor = coalCommitted * 0.35;
    const coalCut = Math.min(coal - coalFloor, gasMin - residual);
    coal -= coalCut;
    residual += coalCut;
    if (storage > 0 && residual < gasMin) {
      const cut = Math.min(storage, gasMin - residual);
      storage -= cut;
      residual += cut;
    }
    if (residual < gasMin) {
      curtailment = gasMin - residual;
      const vre = wind + solar;
      wind -= (curtailment * wind) / vre;
      solar -= (curtailment * solar) / vre;
      residual = gasMin;
    }
  }
  const gas = residual;

  // --- Reserves (PRC) ----------------------------------------------------------
  const plannedOutage = 3_000 + 11_000 * gauss(doy, 105, 25) + 11_000 * gauss(doy, 300, 20) + 3_000 * winter;
  const tripped = active.filter((e) => e.type === 'UNIT_TRIP').reduce((s, e) => s + e.mw_impact, 0);
  const availGas = CAP.gas - plannedOutage - tripped;
  const committedGas = Math.min(availGas, gas * 1.06 + 4_000);
  const headroomGas = Math.max(0, committedGas - gas);
  const headroomCoal = Math.max(0, coalCommitted - coal);
  const headroomStorage = Math.max(0, CAP.storage * 0.85 - storage) * 0.25;
  let prc = 0.4 * headroomGas + 0.5 * headroomCoal + headroomStorage + 600;
  for (const e of active.filter((x) => x.type === 'UNIT_TRIP' && startsNow(x))) prc -= e.mw_impact * 0.5;
  prc = clamp(prc + 150 * smooth(seed, 'prc', hours, 1), 800, 16_000);

  const evening = gauss(hour, 19, 2.5);
  const midday = gauss(hour, 13, 3);
  const reserves = {
    prc_mw: r1(prc),
    regup_mw: r1(380 + 250 * evening + 100 * summer),
    regdown_mw: r1(330 + 200 * midday),
    rrs_mw: r1(3_000 + 400 * summer),
    ecrs_mw: r1(1_800 + 800 * evening),
    nonspin_mw: r1(1_600 + 1_400 * evening),
  };

  // --- Frequency ---------------------------------------------------------------
  let fMean = 60 + 0.004 * smooth(seed, 'f', hours, 0.25);
  const spread = 0.012 + 0.008 * hash01(seed, 'fs', epochMs);
  let fMin = fMean - spread;
  let fMax = fMean + spread;
  for (const e of active) {
    if (e.type === 'UNIT_TRIP' && startsNow(e)) {
      const nadir = 60 - 0.000085 * e.mw_impact - 0.01 * hash01(seed, 'nadir', e.event_id);
      fMin = Math.min(fMin, nadir);
      fMean -= (60 - nadir) / 6;
    }
    if (e.type === 'WIND_RAMP') {
      const elapsed = (epochMs - Date.parse(e.start)) / 60_000;
      if (elapsed < 45) fMin -= 0.012;
    }
  }
  fMax = Math.max(fMax, fMean);

  // --- Prices --------------------------------------------------------------------
  const gasPrice = 2.8 + 0.8 * winter + 0.3 * smooth(seed, 'hh', hours, 240);
  const util = clamp(gas / Math.max(1, availGas), 0, 1.2);
  const heatRate = 7 + 6 * Math.pow(util, 2.5);
  let lambda = gasPrice * heatRate + 2;
  const netLoad = load - wind - solar;
  if (curtailment > 0 || netLoad < 20_000) lambda = Math.min(lambda, -2 + ((netLoad - 15_000) / 1_000) * 3);
  const ordcAdder = 5_000 / (1 + Math.exp((prc - 2_500) / 550));
  lambda = clamp(lambda + ordcAdder, -250, 5_000);

  const coastStress = Math.max(0, zones.COAST.load_mw / (ZONE_PARAMS.COAST.share * 85_000) - 0.75);
  const outageIn = (zs: WeatherZone[]) => active.some((e) => e.type === 'TRANSMISSION_OUTAGE' && zs.includes(e.zone));
  const congestion: Record<TradingHub, number> = {
    HB_NORTH: 0.5 * smooth(seed, 'cn', hours, 3) + (outageIn(['NORTH_CENTRAL']) ? 18 : 0),
    HB_HOUSTON: 80 * coastStress + (outageIn(['COAST']) ? 60 : 0),
    HB_WEST: -Math.max(0, windCf - 0.35) * 60 - (outageIn(['FAR_WEST', 'WEST']) ? 45 : 0),
    HB_SOUTH: 4 * smooth(seed, 'cs', hours, 6) + (outageIn(['SOUTHERN']) ? 35 : 0),
    HB_PAN: -Math.max(0, windCf - 0.3) * 80,
  };
  const lossFactor: Record<TradingHub, number> = { HB_NORTH: 0.012, HB_HOUSTON: 0.018, HB_WEST: 0.028, HB_SOUTH: 0.02, HB_PAN: 0.03 };
  const hubs = {} as Record<TradingHub, HubPrice>;
  for (const h of TRADING_HUBS) {
    const loss = lambda * lossFactor[h];
    hubs[h] = { energy: r2(lambda), congestion: r2(congestion[h]), loss: r2(loss), lmp: r2(lambda + congestion[h] + loss) };
  }

  const gen: Record<Fuel, number> = { gas, coal, nuclear, wind, solar, storage, hydro, other };
  for (const f of FUELS) gen[f] = r1(gen[f]);
  const genTotal = FUELS.reduce((s, f) => s + gen[f], 0);

  return {
    ts: new Date(epochMs).toISOString(),
    epoch_ms: epochMs,
    load_mw: r1(load),
    load_forecast_mw: r1(loadForecast),
    net_load_mw: r1(netLoad),
    gen,
    gen_total_mw: r1(genTotal),
    curtailment_mw: r1(curtailment),
    wind_capacity_mw: CAP.wind,
    solar_capacity_mw: CAP.solar,
    freq: { mean_hz: r4(fMean), min_hz: r4(fMin), max_hz: r4(fMax) },
    reserves,
    system_lambda: r2(lambda),
    hubs,
    zones,
    active_events: active.map((e) => e.event_id),
    data_quality: dataQuality,
  };
}

/** Generate all intervals with end times in (startMs, endMs]. */
export function generateRange(startMs: number, endMs: number, opts: GenerateOptions = {}): GridInterval[] {
  const out: GridInterval[] = [];
  for (let t = floorToInterval(startMs) + INTERVAL_MS; t <= endMs; t += INTERVAL_MS) out.push(generateInterval(t, opts));
  return out;
}

/** Aggregate 5-minute intervals into one record (used for hourly rollups). */
export function rollup(intervals: GridInterval[], ts: string): GridInterval {
  if (intervals.length === 0) throw new Error('rollup requires at least one interval');
  const n = intervals.length;
  const avg = (f: (i: GridInterval) => number) => intervals.reduce((s, i) => s + f(i), 0) / n;
  const first = intervals[0];
  const gen = {} as Record<Fuel, number>;
  for (const f of FUELS) gen[f] = r1(avg((i) => i.gen[f]));
  const hubs = {} as Record<TradingHub, HubPrice>;
  for (const h of TRADING_HUBS) {
    hubs[h] = {
      lmp: r2(avg((i) => i.hubs[h].lmp)),
      energy: r2(avg((i) => i.hubs[h].energy)),
      congestion: r2(avg((i) => i.hubs[h].congestion)),
      loss: r2(avg((i) => i.hubs[h].loss)),
    };
  }
  const zones = {} as Record<WeatherZone, ZoneState>;
  for (const z of WEATHER_ZONES) zones[z] = { load_mw: r1(avg((i) => i.zones[z].load_mw)), temp_f: r1(avg((i) => i.zones[z].temp_f)) };
  return {
    ts,
    epoch_ms: Date.parse(ts),
    load_mw: r1(avg((i) => i.load_mw)),
    load_forecast_mw: r1(avg((i) => i.load_forecast_mw)),
    net_load_mw: r1(avg((i) => i.net_load_mw)),
    gen,
    gen_total_mw: r1(avg((i) => i.gen_total_mw)),
    curtailment_mw: r1(avg((i) => i.curtailment_mw)),
    wind_capacity_mw: first.wind_capacity_mw,
    solar_capacity_mw: first.solar_capacity_mw,
    freq: {
      mean_hz: r4(avg((i) => i.freq.mean_hz)),
      min_hz: Math.min(...intervals.map((i) => i.freq.min_hz)),
      max_hz: Math.max(...intervals.map((i) => i.freq.max_hz)),
    },
    reserves: {
      prc_mw: Math.min(...intervals.map((i) => i.reserves.prc_mw)),
      regup_mw: r1(avg((i) => i.reserves.regup_mw)),
      regdown_mw: r1(avg((i) => i.reserves.regdown_mw)),
      rrs_mw: r1(avg((i) => i.reserves.rrs_mw)),
      ecrs_mw: r1(avg((i) => i.reserves.ecrs_mw)),
      nonspin_mw: r1(avg((i) => i.reserves.nonspin_mw)),
    },
    system_lambda: r2(avg((i) => i.system_lambda)),
    hubs,
    zones,
    active_events: [...new Set(intervals.flatMap((i) => i.active_events))],
    data_quality: intervals.some((i) => i.data_quality === 'STALE') ? 'STALE' : 'GOOD',
  };
}

/** Synthetic weather forecast for the forecasting agent: truth plus horizon-dependent error. */
export function forecastTemperature(targetMs: number, issuedMs: number, seed = DEFAULT_SEED): number {
  const horizonH = Math.max(0, (targetMs - issuedMs) / HOUR_MS);
  const errScale = 0.8 + 0.06 * horizonH;
  let t = 0;
  for (const z of WEATHER_ZONES) t += ZONE_PARAMS[z].share * zoneTemperature(targetMs, z, seed);
  return t + errScale * smooth(seed, `wxf-${Math.floor(issuedMs / HOUR_MS)}`, targetMs / HOUR_MS, 12);
}

/** Load-weighted system temperature from an interval's zone readings. */
export function systemTemperature(i: GridInterval): number {
  return WEATHER_ZONES.reduce((s, z) => s + ZONE_PARAMS[z].share * i.zones[z].temp_f, 0);
}
