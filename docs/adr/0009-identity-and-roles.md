# ADR-0009: Cognito groups as roles; access tokens; identity pool for data access

**Context.** We need four roles, corporate federation readiness, JWT-authorized APIs and a path for analysts to use the data in notebooks.

**Decision.**
- Roles are Cognito groups `Viewer`, `Analyst`, `Operator`, `Admin`, ranked; the highest group wins. Self-registration is classroom-friendly: username + 6-character password, the user picks a role (stored as `custom:role`), and the pre-sign-up trigger auto-confirms the account (no email). The post-confirmation trigger adds the user to that group, and the pre-token-generation trigger fills it in if the user somehow has no group. There is no bootstrap admin and no preset credentials. Optional email-domain allow-listing (pre-sign-up trigger).
- APIs accept **access tokens** (they carry `cognito:groups`). The HTTP API JWT authorizer validates issuer and client ID; the router enforces the role per route. The WebSocket authorizer verifies tokens with `aws-jwt-verify`.
- Two app clients: `web` (SRP + authorization code with PKCE for the hosted UI and federated IdPs) and `cli` (USER_PASSWORD_AUTH for scripts and SDKs).
- SAML and OIDC identity providers are created from deploy-time context, and the sign-in page shows a button per provider.
- An identity pool maps groups to IAM roles with token-based role mapping. Analyst and above get read-only Athena/Glue/S3 access scoped to the GridSight workgroup, database and lake prefix. Viewer gets no AWS permissions.

**Consequences.** Anyone who can reach the sign-in page can become an Admin. That's acceptable for a teaching environment with synthetic data, and the README describes how to lock it down. Role changes take effect at the next token refresh (up to 1 hour). Group-to-role mapping for federated users needs a token-generation trigger (see docs/extending.md §10).
