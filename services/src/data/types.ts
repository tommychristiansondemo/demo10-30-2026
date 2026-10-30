/**
 * Domain types for the synthetic ERCOT-style grid model.
 * Units: power in MW, frequency in Hz, prices in $/MWh, temperature in °F.
 */

export const WEATHER_ZONES = [
  'COAST',
  'EAST',
  'FAR_WEST',
  'NORTH',
  'NORTH_CENTRAL',
  'SOUTH_CENTRAL',
  'SOUTHERN',
  'WEST',
] as const;
export type WeatherZone = (typeof WEATHER_ZONES)[number];

export const TRADING_HUBS = ['HB_NORTH', 'HB_HOUSTON', 'HB_WEST', 'HB_SOUTH', 'HB_PAN'] as const;
export type TradingHub = (typeof TRADING_HUBS)[number];

export const FUELS = ['gas', 'coal', 'nuclear', 'wind', 'solar', 'storage', 'hydro', 'other'] as const;
export type Fuel = (typeof FUELS)[number];

export type EventType =
  | 'UNIT_TRIP'
  | 'WIND_RAMP'
  | 'TRANSMISSION_OUTAGE'
  | 'TELEMETRY_STALE'
  | 'LOAD_FORECAST_MISS';

export type Severity = 'INFO' | 'WARNING' | 'CRITICAL';

export interface GridEvent {
  event_id: string;
  type: EventType;
  /** ISO timestamp when the event begins */
  start: string;
  /** ISO timestamp when the event ends (effects stop) */
  end: string;
  zone: WeatherZone;
  severity: Severity;
  mw_impact: number;
  description: string;
}

export interface HubPrice {
  lmp: number;
  energy: number;
  congestion: number;
  loss: number;
}

export interface ZoneState {
  load_mw: number;
  temp_f: number;
}

export interface GridInterval {
  /** ISO timestamp of the interval end (5-minute SCED-style interval) */
  ts: string;
  epoch_ms: number;
  load_mw: number;
  load_forecast_mw: number;
  net_load_mw: number;
  gen: Record<Fuel, number>;
  gen_total_mw: number;
  curtailment_mw: number;
  wind_capacity_mw: number;
  solar_capacity_mw: number;
  freq: { mean_hz: number; min_hz: number; max_hz: number };
  reserves: {
    prc_mw: number;
    regup_mw: number;
    regdown_mw: number;
    rrs_mw: number;
    ecrs_mw: number;
    nonspin_mw: number;
  };
  system_lambda: number;
  hubs: Record<TradingHub, HubPrice>;
  zones: Record<WeatherZone, ZoneState>;
  active_events: string[];
  data_quality: 'GOOD' | 'STALE';
}

export interface Alert {
  id: string;
  ts: string;
  type: string;
  metric: string;
  severity: Severity;
  status: 'OPEN' | 'ACKNOWLEDGED' | 'RESOLVED';
  title: string;
  message: string;
  value?: number;
  expected?: number;
  score?: number;
  zone?: string;
  source: 'detector' | 'manual';
  updated_at?: string;
  updated_by?: string;
  notes?: { at: string; by: string; text: string }[];
}
