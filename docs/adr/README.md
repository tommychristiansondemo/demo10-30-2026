# Architecture Decision Records

| # | Decision | Status |
|---|---|---|
| [0001](0001-serverless-first.md) | Serverless-first: Lambda + API Gateway + DynamoDB | Accepted |
| [0002](0002-rag-on-s3-vectors.md) | RAG with Bedrock Knowledge Bases on S3 Vectors | Accepted |
| [0003](0003-network-topology.md) | VPC with private subnets in prod; no VPC in dev | Accepted |
| [0004](0004-synthetic-data-model.md) | Deterministic synthetic grid model | Accepted |
| [0005](0005-hot-and-cold-storage.md) | DynamoDB hot store + Parquet/Athena lake instead of Timestream | Accepted |
| [0006](0006-streaming-ai-over-websocket.md) | Streaming AI over WebSocket with an async worker | Accepted |
| [0007](0007-edge-and-dashboard-design.md) | CloudFront + WAF in front of every endpoint; dashboard design system | Accepted |
| [0008](0008-claude-agent-loop.md) | Claude on Bedrock with an owned agent loop and runtime config in SSM | Accepted |
| [0009](0009-identity-and-roles.md) | Cognito groups as roles; access tokens; identity pool for data access | Accepted |

Template: Context → Decision → Consequences. Add a new record rather than editing an accepted one.
