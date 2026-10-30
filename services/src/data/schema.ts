/**
 * Data-lake table definitions: the single source of truth shared by
 *   - the Parquet writer (services/src/lib/lake.ts)
 *   - the Glue catalog tables (infra/lib/stacks/data-stack.ts)
 *   - the NL→SQL prompt (services/src/ai/prompts.ts) and docs/data-dictionary.md
 * Keep this file dependency-free so the CDK app can import it.
 */
export type ColumnType = 'timestamp' | 'double' | 'string' | 'int';

export interface ColumnDef { name: string; type: ColumnType; description: string }
export interface TableDef { name: string; description: string; columns: ColumnDef[] }

const mw = (name: string, description: string): ColumnDef => ({ name, type: 'double', description: `${description} (MW)` });

export const LAKE_TABLES: TableDef[] = [
  {
    name: 'grid_interval',
    description: 'One row per 5-minute interval with system-wide load, generation by fuel, frequency, reserves and system lambda.',
    columns: [
      { name: 'ts', type: 'timestamp', description: 'Interval end time (UTC)' },
      mw('load_mw', 'Actual system load'),
      mw('load_forecast_mw', 'Load forecast for this interval'),
      mw('net_load_mw', 'Load minus wind and solar'),
      mw('gen_gas_mw', 'Natural gas generation'),
      mw('gen_coal_mw', 'Coal and lignite generation'),
      mw('gen_nuclear_mw', 'Nuclear generation'),
      mw('gen_wind_mw', 'Wind generation'),
      mw('gen_solar_mw', 'Solar generation'),
      mw('gen_storage_mw', 'Battery storage net output (negative = charging)'),
      mw('gen_hydro_mw', 'Hydro generation'),
      mw('gen_other_mw', 'Biomass and other generation'),
      mw('gen_total_mw', 'Total generation'),
      mw('curtailment_mw', 'Wind+solar curtailment'),
      { name: 'freq_mean_hz', type: 'double', description: 'Mean system frequency in the interval (Hz)' },
      { name: 'freq_min_hz', type: 'double', description: 'Minimum system frequency in the interval (Hz)' },
      { name: 'freq_max_hz', type: 'double', description: 'Maximum system frequency in the interval (Hz)' },
      mw('prc_mw', 'Physical Responsive Capability'),
      mw('regup_mw', 'Regulation Up award'),
      mw('regdown_mw', 'Regulation Down award'),
      mw('rrs_mw', 'Responsive Reserve Service award'),
      mw('ecrs_mw', 'ERCOT Contingency Reserve Service award'),
      mw('nonspin_mw', 'Non-Spinning Reserve award'),
      { name: 'system_lambda', type: 'double', description: 'System lambda, the SCED marginal energy price ($/MWh)' },
      { name: 'data_quality', type: 'string', description: "'GOOD' or 'STALE' (telemetry problem in at least one zone)" },
      { name: 'active_event_count', type: 'int', description: 'Number of contingency/data events active in the interval' },
    ],
  },
  {
    name: 'zone_load',
    description: 'One row per 5-minute interval per weather zone (COAST, EAST, FAR_WEST, NORTH, NORTH_CENTRAL, SOUTH_CENTRAL, SOUTHERN, WEST).',
    columns: [
      { name: 'ts', type: 'timestamp', description: 'Interval end time (UTC)' },
      { name: 'zone', type: 'string', description: 'Weather zone code' },
      mw('load_mw', 'Zone load'),
      { name: 'temp_f', type: 'double', description: 'Zone temperature (°F)' },
    ],
  },
  {
    name: 'hub_price',
    description: 'One row per 5-minute interval per trading hub (HB_NORTH, HB_HOUSTON, HB_WEST, HB_SOUTH, HB_PAN) with LMP components.',
    columns: [
      { name: 'ts', type: 'timestamp', description: 'Interval end time (UTC)' },
      { name: 'hub', type: 'string', description: 'Trading hub code' },
      { name: 'lmp', type: 'double', description: 'Locational marginal price ($/MWh)' },
      { name: 'energy', type: 'double', description: 'Energy component ($/MWh)' },
      { name: 'congestion', type: 'double', description: 'Congestion component ($/MWh)' },
      { name: 'loss', type: 'double', description: 'Loss component ($/MWh)' },
    ],
  },
  {
    name: 'grid_event',
    description: 'Contingencies and data-quality events (unit trips, wind ramps, transmission outages, stale telemetry, load forecast misses). Partitioned by the event start date.',
    columns: [
      { name: 'event_id', type: 'string', description: 'Event identifier' },
      { name: 'type', type: 'string', description: 'UNIT_TRIP | WIND_RAMP | TRANSMISSION_OUTAGE | TELEMETRY_STALE | LOAD_FORECAST_MISS' },
      { name: 'start_ts', type: 'timestamp', description: 'Event start (UTC)' },
      { name: 'end_ts', type: 'timestamp', description: 'Event end (UTC)' },
      { name: 'zone', type: 'string', description: 'Affected weather zone' },
      { name: 'severity', type: 'string', description: 'INFO | WARNING | CRITICAL' },
      { name: 'mw_impact', type: 'double', description: 'MW impact (percent for LOAD_FORECAST_MISS)' },
      { name: 'description', type: 'string', description: 'Human-readable description' },
    ],
  },
];

export const PARTITION_KEY = { name: 'dt', type: 'string', description: "Partition date 'YYYY-MM-DD' (UTC). Always filter on dt for efficient scans." } as const;
export const LAKE_PREFIX = 'curated';
