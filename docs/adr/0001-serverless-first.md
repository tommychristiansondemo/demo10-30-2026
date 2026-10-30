# ADR-0001: Serverless-first

**Context.** GridSight is a demonstration and extension platform with spiky, low-to-moderate traffic: dashboards poll, the generator runs every 5 minutes, and AI turns are bursty. Grid engineers extending it shouldn't have to run clusters.

**Decision.** Use Lambda (Node.js 22, arm64, esbuild-bundled ESM) behind API Gateway HTTP and WebSocket APIs, DynamoDB on-demand, S3, Athena and EventBridge. A single `api` function with an in-process router serves REST routes; separate functions handle WebSocket lifecycle, chat work, generation and backfill.

**Consequences.**
- Near-zero idle cost; the baseline is dominated by WAF, CloudWatch and (in prod) the NAT gateway.
- One router function means fewer cold-start sites and simpler IAM, at the cost of a broader role than per-route functions would need. Split routes into separate functions if their permissions diverge sharply.
- API Gateway's 30-second integration timeout bounds synchronous AI calls. Long agent turns go through WebSocket (ADR-0006); `/v1/ai/ask` caps tool iterations at 3.
- ECS/Fargate was considered for the agent (long-lived streaming) but rejected: the async-worker pattern gets the same streaming UX without a container platform.
