/**
 * Role model. Roles are Cognito groups; each role inherits everything below it.
 *   Viewer  → read dashboards, alerts
 *   Analyst → + AI assistant, forecasts, SQL/NL queries, knowledge search
 *   Operator→ + acknowledge/resolve alerts, create manual alerts
 *   Admin   → + feature flags/model config, audit log, user role management
 */
export const ROLES = ['Viewer', 'Analyst', 'Operator', 'Admin'] as const;
export type Role = (typeof ROLES)[number];

export interface Principal {
  sub: string;
  username: string;
  email?: string;
  groups: string[];
  role: Role;
}

const rank = (r: Role) => ROLES.indexOf(r);

/** Highest role among the user's Cognito groups (defaults to Viewer). */
export function effectiveRole(groups: string[]): Role {
  let best: Role = 'Viewer';
  for (const g of groups) {
    const r = ROLES.find((x) => x.toLowerCase() === g.toLowerCase());
    if (r && rank(r) > rank(best)) best = r;
  }
  return best;
}

export function hasRole(p: Principal, required: Role): boolean {
  return rank(p.role) >= rank(required);
}

function parseGroups(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw === 'string') {
    // API Gateway HTTP API flattens array claims to "[a b c]"
    return raw.replace(/^\[|\]$/g, '').split(/[\s,]+/).filter(Boolean);
  }
  return [];
}

export function principalFromClaims(claims: Record<string, unknown>): Principal {
  const groups = parseGroups(claims['cognito:groups']);
  return {
    sub: String(claims.sub ?? ''),
    username: String(claims.username ?? claims['cognito:username'] ?? claims.sub ?? ''),
    email: claims.email ? String(claims.email) : undefined,
    groups,
    role: effectiveRole(groups),
  };
}
