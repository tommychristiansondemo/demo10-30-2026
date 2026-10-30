/**
 * Last line of defence before anything reaches a student: strip credentials, tokens and client IP
 * addresses from text (knowledge file, log rows, tool results). The tools never read secret values in
 * the first place; this catches anything that leaks into logs or documents by accident.
 */
const RULES: [RegExp, string][] = [
  // AWS access key IDs and secret keys written next to their names
  [/\b(AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}\b/g, '[redacted-aws-key-id]'],
  [/((?:aws_)?secret_?access_?key["']?\s*[:=]\s*["']?)[A-Za-z0-9/+=]{40}/gi, '$1[redacted]'],
  // JWTs (Cognito access/ID/refresh tokens) and bearer tokens
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[redacted-jwt]'],
  [/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi, '$1[redacted]'],
  // Anthropic / generic API keys
  [/\bsk-ant-[A-Za-z0-9_-]{10,}/g, '[redacted-api-key]'],
  // Origin-verify headers and well-known secret-bearing JSON/env keys
  [/(x-[a-z-]*origin-verify["']?\s*[:=]\s*["']?)[^"'\s,}]+/gi, '$1[redacted]'],
  [
    /(["']?\b(?:password|passwd|secret|secretString|SecretString|clientSecret|client_secret|apiKey|api_key|accessToken|idToken|refreshToken|authorization|x-gs-token)\b["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,}]+)/gi,
    '$1"[redacted]"',
  ],
  // Client IP addresses (students' home or campus networks)
  [/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[ip]'],
];

export function redact(text: string, extraSecrets: string[] = []): string {
  let out = text;
  for (const s of extraSecrets) if (s && s.length >= 8) out = out.split(s).join('[redacted]');
  for (const [re, replacement] of RULES) out = out.replace(re, replacement);
  return out;
}

/** Redact every string inside a JSON-compatible value. */
export function redactDeep<T>(value: T, extraSecrets: string[] = []): T {
  if (typeof value === 'string') return redact(value, extraSecrets) as T;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, extraSecrets)) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactDeep(v, extraSecrets)])) as T;
  }
  return value;
}

/** Findings for a build-time check that generated documents contain nothing secret-looking. */
export function secretFindings(text: string): string[] {
  const findings: string[] = [];
  for (const [re] of RULES.slice(0, 6)) {
    for (const m of text.matchAll(new RegExp(re.source, re.flags))) findings.push(m[0].slice(0, 40));
  }
  return findings;
}
