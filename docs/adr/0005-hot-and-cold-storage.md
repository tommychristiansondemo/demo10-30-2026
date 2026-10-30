# ADR-0005: DynamoDB hot store + Parquet/Athena lake

**Context.** Dashboards need low-latency reads of recent intervals; analysts and the NL→SQL agent need ad-hoc SQL over months of history. Amazon Timestream for LiveAnalytics is closed to new customers, and Timestream for InfluxDB is an always-on instance.

**Decision.**
- **Hot:** DynamoDB table keyed by `series` (`GRID#5m`, `GRID#1h`) and `ts`, storing the full interval document; TTL 30 days (5-minute) and 90 days (hourly).
- **Cold:** Parquet files in S3 under `curated/<table>/dt=YYYY-MM-DD/`, written by the generator hourly and compacted to one file per day after midnight UTC. Glue tables use **partition projection**, so there are no crawlers or `MSCK REPAIR`. Athena engine v3 queries through a workgroup with a 1 GB per-query scan limit.
- A single schema definition (`services/src/data/schema.ts`) drives Glue columns, the Parquet writer, the SQL guard allow-list and the AI prompt.

**Consequences.**
- Single-digit-millisecond dashboard reads and cheap SQL over history, both serverless.
- The lake is up to an hour behind real time; tools and docs steer "right now" questions to DynamoDB.
- Writing Parquet from Lambda uses the pure-JS `hyparquet-writer` (no native dependencies).
