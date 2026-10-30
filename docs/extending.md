# Extending GridSight

This guide is for engineers adding capabilities. Every recipe is a small, local change; the CDK app picks up new code on the next `cdk deploy`.

## 1. Add an AI tool

Tools live in `services/src/ai/tools.ts`. Each one has a JSON schema (what Claude sees), a zod validator, an implementation and an optional one-line summary for the UI trace.

```ts
// services/src/ai/tools.ts
get_outage_schedule: {
  spec: {
    name: 'get_outage_schedule',
    description: 'Planned generation and transmission outages overlapping a time window. Use for maintenance and capacity questions.',
    input_schema: obj({
      start: { type: 'string', description: 'ISO start time' },
      end: { type: 'string', description: 'ISO end time' },
    }),
    strict: true,
  },
  input: z.object({ start: z.string().datetime(), end: z.string().datetime() }),
  run: async (i) => outageClient.list(i.start, i.end),     // your integration
  summarize: (_i, o) => `${o.length} outages`,
} satisfies ToolDef<{ start: string; end: string }>,
```

Then:
1. Add `'get_outage_schedule'` to `AI_TOOLS` in `services/src/lib/config-schema.ts`. It appears as a toggle on **Admin → Feature flags & AI**.
2. Grant the chat worker and API functions any IAM permissions the tool needs in `infra/lib/stacks/api-stack.ts`.
3. Add a label in `web/src/components/ChatPanel.tsx` (`TOOL_LABEL`) for a friendly progress message.

Guidelines: write the description for the model (when to use it, what it returns); keep results compact (the executor truncates at 60k characters); return `{ error }` style failures. The loop already reports exceptions to the model as `is_error` tool results.

## 2. Change prompts

`services/src/ai/prompts.ts` holds the shared context and three profiles (`operations-analyst`, `developer-assistant`, `executive-brief`). Keep the system prompt free of timestamps or per-request values so the prompt cache keeps working; the agent injects the current time into the user turn instead. To add a profile, extend `PROMPT_VARIANTS` in `config-schema.ts` and `VARIANTS` in `prompts.ts`.

## 3. Switch models or tune cost

No deploy needed: **Admin → Feature flags & AI**, or

```bash
curl -X PUT -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  $API/v1/admin/config -d @config.json
```

Fields: `chatModelId`, `fallbackModelId`, `sqlModelId` (Bedrock model IDs with the `anthropic.` prefix), `effort` (`low`…`max`), `maxToolIterations`, `maxOutputTokens`, `promptVariant`, per-tool toggles. Lambdas pick up changes within 60 seconds. SSM keeps every version (`aws ssm get-parameter-history --name /gridsight/dev/app-config`).

## 4. Replace the forecaster

`services/src/analytics/forecast.ts` exports `forecastLoad(history, horizonHours, tempForecast)` returning `ForecastResult`. Keep that signature and the UI, REST API and AI tool keep working. Options:

- **Richer local model:** add features (holidays, humidity, lagged load) to `features()`.
- **SageMaker:** call an endpoint from `lib/grid-service.ts#loadForecast` with `@aws-sdk/client-sagemaker-runtime`, and grant `sagemaker:InvokeEndpoint` to the API and chat-worker roles.
- **Batch forecasts:** compute on a schedule, store them in DynamoDB, and have `loadForecast` read the latest.

`services/test/analytics.test.ts` asserts the model beats seasonal-naive on synthetic data; keep an equivalent test for your model.

## 5. Add an anomaly detector

Detectors are pure functions over `GridInterval[]` in `services/src/analytics/anomaly.ts`. Add a block in `detectAnomalies`, give it a deterministic `id` (type + metric + timestamp) so re-runs stay idempotent, and add thresholds to `AnomalyThresholds` and `DEFAULT_THRESHOLDS` so admins can tune them. The generator, the `/v1/anomalies` endpoint and the AI tool all pick it up.

## 6. Ingest real data

The platform reads `GridInterval` documents (see `services/src/data/types.ts`) from DynamoDB and Parquet rows from the lake. To use real feeds (ERCOT public reports, an internal historian, EMS exports):

1. Write an ingest Lambda or container that maps your source to `GridInterval` and calls `putIntervals(items, '5m')` and `writeIntervalsToLake(dt, file, items)`.
2. Remove the generator schedule in `api-stack.ts`, or point it at your ingest.
3. Keep the hourly rollup (`rollup()` → `putIntervals(..., '1h')`); the forecaster uses it.
4. Map your contingency feed into the `grid_event` table and alerts if you have one.

Field names are shared across the stack through `services/src/data/schema.ts`.

## 7. Add a lake table

Add a `TableDef` to `LAKE_TABLES` in `services/src/data/schema.ts`. That one change creates the Glue table (with partition projection) in the Data stack, makes the table writable by `toParquet()`, allows it in the SQL guard and documents it in the NL→SQL and agent prompts.

## 8. Add a REST endpoint

```ts
// services/src/handlers/api.ts
.get('/v1/grid/zones/{zone}', 'Viewer', async (ctx) => { … })
```

The router enforces the role, parses path parameters and turns `HttpError`/zod errors into JSON responses. Use `audit(ctx, action, resource, details)` for anything that changes state. Document it in `api/openapi.yaml` and, if useful, add it to both SDKs.

## 9. Add knowledge documents

Put Markdown, text, HTML, Word or PDF files into `knowledge/` and redeploy. The Knowledge stack hashes the folder; any change re-runs the ingestion job. Chunking is fixed-size (400 tokens, 15% overlap); adjust it in `knowledge-stack.ts`. Label documents clearly when they are unofficial summaries.

## 10. Map federated IdP groups to roles

Federated users start as Viewer. To derive roles from IdP groups, add a Cognito **pre token generation** trigger that reads the mapped IdP attribute (e.g. `custom:groups`) and sets `groupsToOverride`, or a post-authentication trigger that calls `AdminAddUserToGroup`. Wire it in `auth-stack.ts` next to the existing `preSignUp` and `postConfirmation` triggers.

## 11. Scale out WebSocket broadcasts

`lib/ws.ts#broadcast` scans the connections table, which is fine up to a few hundred clients. Beyond that, fan out with SNS or EventBridge to a broadcaster Lambda that pages through connections in parallel, or move live updates to AWS AppSync Events. See ADR-0006.
