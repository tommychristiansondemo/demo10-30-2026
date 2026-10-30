# GridSight Data Dictionary and API Map

> Generated documentation for the GridSight AI platform. Data in this environment is synthetic.

## Stores
| Store | Contents | Retention | Access |
|---|---|---|---|
| DynamoDB `metrics` (5m) | Full interval documents | 30 days | REST `/v1/grid/*`, agent tools |
| DynamoDB `metrics` (1h) | Hourly rollups (hour-ending) | 90 days | Forecasting, long-range charts |
| S3 data lake (Parquet) | Tables below, partitioned by `dt` | 90-day backfill, then grows | Athena SQL, `/v1/query/sql`, NL→SQL |
| DynamoDB `alerts` | Detector, contingency and manual alerts | 90 days | `/v1/alerts` |
| DynamoDB `audit` | AI and operational audit trail | 400 days | `/v1/admin/audit` (Admin) |

## Lake tables (Athena database `gridsight_<env>`)
### grid_interval: one row per 5-minute interval
`ts`, `load_mw`, `load_forecast_mw`, `net_load_mw`, `gen_gas_mw`, `gen_coal_mw`, `gen_nuclear_mw`, `gen_wind_mw`, `gen_solar_mw`, `gen_storage_mw` (negative = charging), `gen_hydro_mw`, `gen_other_mw`, `gen_total_mw`, `curtailment_mw`, `freq_mean_hz`, `freq_min_hz`, `freq_max_hz`, `prc_mw`, `regup_mw`, `regdown_mw`, `rrs_mw`, `ecrs_mw`, `nonspin_mw`, `system_lambda`, `data_quality`, `active_event_count`, partition `dt`.

### zone_load: per weather zone per interval
`ts`, `zone`, `load_mw`, `temp_f`, `dt`.

### hub_price: per trading hub per interval
`ts`, `hub`, `lmp`, `energy`, `congestion`, `loss`, `dt`.

### grid_event: contingencies and data-quality events
`event_id`, `type`, `start_ts`, `end_ts`, `zone`, `severity`, `mw_impact`, `description`, `dt` (start date).

## Query tips
- Always filter `dt` (string `'YYYY-MM-DD'`, UTC) to limit the data scanned. The Athena workgroup enforces a per-query scan limit.
- Convert to Central time with `at_timezone(ts, 'America/Chicago')`.
- Data lands in the lake hourly. For the last hour, use the real-time REST endpoints.

## REST API map
| Endpoint | Role | Description |
|---|---|---|
| `GET /v1/grid/current` | Viewer | Latest interval plus derived status |
| `GET /v1/grid/series?start&end&resolution` | Viewer | Time series (5m or 1h) |
| `GET /v1/grid/events` | Viewer | Contingency events |
| `GET /v1/alerts?status=OPEN` | Viewer | Alerts |
| `POST /v1/alerts/{id}/ack` and `/resolve` | Operator | Alert workflow |
| `GET /v1/forecast/load?hours=48` | Analyst | Load forecast |
| `GET /v1/anomalies?hours=24` | Analyst | On-demand anomaly scan |
| `POST /v1/query/sql` | Analyst | Guarded Athena SQL |
| `POST /v1/ai/sql` | Analyst | Natural language to SQL |
| `POST /v1/ai/ask` | Analyst | Synchronous AI answer |
| `wss://…/ws` action `chat` | Analyst | Streaming AI chat |
| `GET/PUT /v1/admin/config` | Admin | Feature flags and model settings |
| `GET /v1/admin/audit` | Admin | Audit log |
