# ADR-0007: CloudFront + WAF in front of every endpoint; dashboard design system

**Context.** AWS WAF can't attach to API Gateway HTTP or WebSocket APIs directly. The requirements call for WAF in front of all public endpoints and custom domains.

**Decision (edge).**
- Two CloudFront distributions share one `CLOUDFRONT`-scope web ACL: `gridsight.awsteach.com` (SPA from S3 via OAC; `/api/*` → HTTP API with a CloudFront Function stripping `/api`; `/ws` → WebSocket API) and `api.gridsight.awsteach.com` (HTTP API; `/ws`).
- API behaviors use a zero-TTL cache policy keyed on `Authorization`, because CloudFront only forwards that header on GET when it's part of the cache key.
- CloudFront adds a secret header to origin requests; in prod the API and WebSocket authorizer reject requests without it, closing the execute-api bypass.
- SPA routing uses a viewer-request function rather than custom error responses, so API 403/404s aren't rewritten to `index.html`.

**Decision (dashboard).**
- ECharts with a validated categorical palette. The generation-mix stack order (nuclear, coal, hydro, gas, wind, solar, storage, other) was chosen so every adjacent pair passes color-vision-deficiency separation in light and dark modes.
- Status colors (good/warning/critical) are reserved for state and always paired with an icon and label. One y-axis per chart, recessive grids, crosshair tooltips. Every chart has a table view, which compensates for three light-mode series colors under 3:1 contrast.
- Times are displayed in Central Prevailing Time (ERCOT's operating zone) and stored in UTC.

**Consequences.** One security perimeter and one certificate cover the app and API. WebSocket through CloudFront needs `Sec-WebSocket-*` headers and query strings forwarded (done via the `AllViewerExceptHostHeader` origin request policy).
