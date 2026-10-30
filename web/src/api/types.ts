export type Fuel = 'gas' | 'coal' | 'nuclear' | 'wind' | 'solar' | 'storage' | 'hydro' | 'other';
export type Role = 'Viewer' | 'Analyst' | 'Operator' | 'Admin';
export type Severity = 'INFO' | 'WARNING' | 'CRITICAL';

export interface GridInterval {
  ts: string;
  epoch_ms: number;
  load_mw: number;
  load_forecast_mw: number;
  net_load_mw: number;
  gen: Record<Fuel, number>;
  gen_total_mw: number;
  curtailment_mw: number;
  freq: { mean_hz: number; min_hz: number; max_hz: number };
  reserves: { prc_mw: number; regup_mw: number; regdown_mw: number; rrs_mw: number; ecrs_mw: number; nonspin_mw: number };
  system_lambda: number;
  hubs: Record<string, { lmp: number; energy: number; congestion: number; loss: number }>;
  zones: Record<string, { load_mw: number; temp_f: number }>;
  active_events: string[];
  data_quality: 'GOOD' | 'STALE';
}

export interface GridEvent { event_id: string; type: string; start: string; end: string; zone: string; severity: Severity; mw_impact: number; description: string }

export interface Snapshot extends GridInterval {
  derived: { renewable_share_pct: number; reserve_status: 'NORMAL' | 'WATCH' | 'ADVISORY' | 'EMERGENCY'; forecast_error_pct: number; data_age_seconds: number };
  active_event_details: GridEvent[];
}

export interface Alert {
  id: string; ts: string; type: string; metric: string; severity: Severity; status: 'OPEN' | 'ACKNOWLEDGED' | 'RESOLVED';
  title: string; message: string; value?: number; expected?: number; score?: number; zone?: string; source: string;
  updated_at?: string; updated_by?: string; notes?: { at: string; by: string; text: string }[];
}

export interface Me {
  user: { sub: string; username: string; email?: string; groups: string[]; role: Role };
  config: { features: Record<string, boolean>; ai: { enabled: boolean; chatModelId: string; promptVariant: string } };
}

export interface ForecastResponse {
  model: string; issued_at: string; trained_on_hours: number;
  backtest: { horizon_hours: number; mape_pct: number; naive_mape_pct: number };
  points: { ts: string; forecast_mw: number; p10_mw: number; p90_mw: number; temp_forecast_f: number }[];
  recent_actuals: { ts: string; load_mw: number; official_forecast_mw: number }[];
}

export interface QueryResult {
  sql: string; columns: { name: string; type: string }[]; rows: Record<string, string | number | null>[]; truncated: boolean;
  stats: { queryExecutionId: string; bytesScanned: number; executionMs: number };
}

export interface ToolTrace { id: string; name: string; input?: unknown; ok?: boolean; summary?: string; durationMs?: number; status?: 'running' | 'done' | 'error' }
