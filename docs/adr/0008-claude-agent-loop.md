# ADR-0008: Claude on Bedrock with an owned agent loop; runtime config in SSM

**Context.** We need tool-using AI with streaming, auditable tool traces, per-request limits, model switching without redeploys, and data that never leaves AWS.

**Decision.**
- Call Claude through **Claude in Amazon Bedrock** with the official `@anthropic-ai/bedrock-sdk` and SigV4 from the Lambda role. The model ID picks the endpoint (`services/src/ai/models.ts`): cross-region inference profiles (`us.anthropic.…`) use the Bedrock runtime (`AnthropicBedrock`, `bedrock:InvokeModel*`) and bare `anthropic.claude-…` IDs (Opus 4.7 and newer) use the Mantle endpoint (`AnthropicBedrockMantle`, `bedrock-mantle:CreateInference`).
- The runtime client pins `anthropic_version` to `bedrock-2023-05-31`, because Bedrock accepts SDK 1.x's default `2026-10-21` only for Claude 4.7 and newer. Remove the override once the defaults move to a 4.7+ model.
- Default model `us.anthropic.claude-opus-4-6-v1` (the newest Claude the deployment account can invoke), with adaptive thinking and `effort: medium`. `us.anthropic.claude-sonnet-4-6` is the SQL model and the client-side fallback when the primary returns a `refusal` stop reason. Admins can switch to `anthropic.claude-opus-5-5` from the Admin page once the account has access.
- Own the loop (`services/src/ai/agent.ts`) instead of a framework: stream each step, execute tool calls in parallel, return all results in one user message, cap iterations, and on the last iteration force a final answer with `tool_choice: none`.
- Store each turn's raw message objects (including thinking blocks) append-only in DynamoDB and replay them unchanged on the next turn.
- Keep the system prompt static (schema, rules, profile) and inject the current time in the user turn so prompt caching applies: automatic caching on Mantle, an explicit breakpoint on the system prompt on the runtime (which rejects top-level `cache_control`).
- NL→SQL uses structured outputs (`output_config.format` JSON schema) and the same SQL guard as user queries.
- Runtime configuration (models, effort, prompt profile, tool toggles, feature flags, detector thresholds) lives in an SSM parameter validated with zod, cached for 60 seconds, edited from the Admin page and versioned by SSM.

**Consequences.**
- Full visibility: every tool call and token count is audited and graphed.
- Conversations have a turn cap (`maxSessionTurns`) because history is never truncated mid-conversation; users start a new chat when it's reached.
- Changing default config in code overwrites the deployed parameter on the next deploy (documented in the README).
