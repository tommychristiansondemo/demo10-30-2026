import { describe, expect, it } from 'vitest';
import { centralOffsetHours, eventsBetween, generateInterval, generateRange, HOUR_MS, INTERVAL_MS, rollup } from '../src/data/generator.js';
import { FUELS, WEATHER_ZONES } from '../src/data/types.js';

const t = Date.parse('2026-07-21T22:00:00Z'); // 5 pm CDT, summer peak hour

describe('synthetic grid generator', () => {
  it('is deterministic for the same timestamp and seed', () => {
    expect(generateInterval(t)).toEqual(generateInterval(t));
    expect(generateInterval(t, { seed: 'other' }).load_mw).not.toEqual(generateInterval(t).load_mw);
  });

  it('balances generation and load', () => {
    for (const iv of generateRange(t - 7 * 24 * HOUR_MS, t)) {
      expect(Math.abs(iv.gen_total_mw - iv.load_mw)).toBeLessThan(1);
      expect(FUELS.reduce((s, f) => s + iv.gen[f], 0)).toBeCloseTo(iv.gen_total_mw, 0);
    }
  });

  it('produces physically plausible ranges', () => {
    const xs = generateRange(t - 30 * 24 * HOUR_MS, t);
    for (const iv of xs) {
      expect(iv.load_mw).toBeGreaterThan(30_000);
      expect(iv.load_mw).toBeLessThan(95_000);
      expect(iv.freq.min_hz).toBeGreaterThan(59.7);
      expect(iv.freq.max_hz).toBeLessThan(60.1);
      expect(iv.gen.solar).toBeGreaterThanOrEqual(0);
      expect(iv.reserves.prc_mw).toBeGreaterThanOrEqual(800);
    }
    const night = generateInterval(Date.parse('2026-07-21T09:00:00Z')); // 4 am CDT
    expect(night.gen.solar).toBe(0);
    expect(generateInterval(t).load_mw).toBeGreaterThan(night.load_mw);
  });

  it('zone loads sum to system load', () => {
    const iv = generateInterval(t);
    const sum = WEATHER_ZONES.reduce((s, z) => s + iv.zones[z].load_mw, 0);
    expect(Math.abs(sum - iv.load_mw)).toBeLessThan(5);
  });

  it('unit trips cause a frequency dip proportional to MW lost', () => {
    const trips = eventsBetween(t - 60 * 24 * HOUR_MS, t).filter((e) => e.type === 'UNIT_TRIP');
    expect(trips.length).toBeGreaterThan(0);
    for (const e of trips.slice(0, 10)) {
      const iv = generateInterval(Date.parse(e.start));
      expect(iv.active_events).toContain(e.event_id);
      expect(iv.freq.min_hz).toBeLessThan(60 - 0.00008 * e.mw_impact);
    }
  });

  it('stale telemetry freezes the zone load', () => {
    const e = eventsBetween(t - 90 * 24 * HOUR_MS, t).find((x) => x.type === 'TELEMETRY_STALE')!;
    const s = Date.parse(e.start);
    const a = generateInterval(s + INTERVAL_MS);
    const b = generateInterval(s + 3 * INTERVAL_MS);
    expect(a.zones[e.zone].load_mw).toBe(b.zones[e.zone].load_mw);
    expect(a.data_quality).toBe('STALE');
  });

  it('uses US Central daylight time rules', () => {
    expect(centralOffsetHours(Date.parse('2026-07-01T12:00:00Z'))).toBe(-5);
    expect(centralOffsetHours(Date.parse('2026-12-01T12:00:00Z'))).toBe(-6);
    expect(centralOffsetHours(Date.parse('2026-03-08T07:59:00Z'))).toBe(-6);
    expect(centralOffsetHours(Date.parse('2026-03-08T08:00:00Z'))).toBe(-5);
  });

  it('rolls up intervals (min frequency, min PRC, mean load)', () => {
    const ivs = generateRange(t - HOUR_MS, t);
    expect(ivs).toHaveLength(12);
    const r = rollup(ivs, new Date(t).toISOString());
    expect(r.freq.min_hz).toBe(Math.min(...ivs.map((i) => i.freq.min_hz)));
    expect(r.reserves.prc_mw).toBe(Math.min(...ivs.map((i) => i.reserves.prc_mw)));
    expect(r.load_mw).toBeCloseTo(ivs.reduce((s, i) => s + i.load_mw, 0) / 12, 0);
  });
});
