# ADR-0006: Streaming AI over WebSocket with an async worker

**Context.** Agent turns with several tool calls can run well past API Gateway's 29–30 second integration limit, and users expect streamed tokens and visible tool progress.

**Decision.** The browser sends `{"action":"chat"}` on the WebSocket API. The `ws-message` Lambda validates the request and role, then invokes `chat-worker` asynchronously and returns immediately. The worker runs the agent loop (up to 5 minutes) and pushes `chat.delta` (coalesced to about 100 ms frames), `chat.tool`, `chat.done` and `chat.error` messages through the API Gateway management API. The same socket carries `grid.interval` and alert broadcasts. A synchronous REST endpoint (`/v1/ai/ask`, max 3 tool iterations) remains for scripts.

**Consequences.**
- Streaming UX without long-lived servers; the client falls back to REST if the socket is down.
- Authentication uses `?token=` on connect because browsers can't set headers on WebSocket upgrades. WAF and CloudFront logging redact query strings.
- Broadcasts scan the connections table: O(connections) per event, fine for hundreds of clients. Past that, fan out through SNS/EventBridge to parallel broadcasters or adopt AppSync Events.
