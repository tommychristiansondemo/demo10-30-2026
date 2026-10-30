/**
 * Per-environment settings. Values can be overridden at deploy time with CDK context, e.g.
 *   npx cdk deploy --all -c env=prod -c hostedZoneId=Z123
 */
export type EnvName = 'dev' | 'prod';

export interface FederationConfig {
  /** SAML 2.0 IdP (e.g. Microsoft Entra ID, Okta, ADFS) */
  saml?: { name: string; metadataUrl: string };
  /** OIDC IdP; the client secret is read from Secrets Manager at deploy time */
  oidc?: { name: string; issuerUrl: string; clientId: string; clientSecretName: string };
}

export interface EnvironmentConfig {
  envName: EnvName;
  account?: string;
  region: string;
  domain: { zoneName: string; hostedZoneId?: string; appHost: string; apiHost: string };
  auth: {
    /** Anyone can register (username + password, no email, auto-confirmed) and pick a role. */
    selfSignUp: boolean;
    allowedEmailDomains: string[];
    mfa: 'OFF' | 'OPTIONAL' | 'REQUIRED';
    federation?: FederationConfig;
  };
  /** Explicit AZs keep synth deterministic (no EC2 lookups). */
  network: { mode: 'none' | 'private'; azs: string[]; natGateways: number };
  data: { backfillDays: number; hotDays: number; seed: string; athenaScanLimitBytes: number };
  api: { throttleRate: number; throttleBurst: number; enforceOriginVerify: boolean };
  waf: { rateLimitPer5Min: number; aiRateLimitPer5Min: number };
  observability: { alarmEmail?: string; logRetentionDays: number };
  retainData: boolean;
}

const ZONE = 'awsteach.com';

const base = {
  region: 'us-east-1',
  data: { backfillDays: 90, hotDays: 30, seed: 'gridsight-ercot-v1', athenaScanLimitBytes: 1_000_000_000 },
};

export const ENVIRONMENTS: Record<EnvName, EnvironmentConfig> = {
  dev: {
    ...base,
    envName: 'dev',
    domain: { zoneName: ZONE, appHost: `dev.gridsight.${ZONE}`, apiHost: `api.dev.gridsight.${ZONE}` },
    auth: { selfSignUp: true, allowedEmailDomains: [], mfa: 'OFF' },
    // Dev runs Lambdas outside a VPC to avoid NAT gateway cost (see ADR-0003).
    network: { mode: 'none', azs: [], natGateways: 0 },
    api: { throttleRate: 50, throttleBurst: 100, enforceOriginVerify: false },
    waf: { rateLimitPer5Min: 2000, aiRateLimitPer5Min: 300 },
    observability: { logRetentionDays: 14 },
    retainData: false,
  },
  prod: {
    ...base,
    envName: 'prod',
    domain: { zoneName: ZONE, appHost: `gridsight.${ZONE}`, apiHost: `api.gridsight.${ZONE}` },
    auth: { selfSignUp: true, allowedEmailDomains: [], mfa: 'OFF' },
    network: { mode: 'private', azs: ['us-east-1a', 'us-east-1b'], natGateways: 1 },
    api: { throttleRate: 200, throttleBurst: 400, enforceOriginVerify: true },
    waf: { rateLimitPer5Min: 2000, aiRateLimitPer5Min: 300 },
    observability: { logRetentionDays: 90 },
    retainData: true,
  },
};

type Ctx = { tryGetContext(key: string): unknown };

export function resolveConfig(app: Ctx): EnvironmentConfig {
  const name = String(app.tryGetContext('env') ?? 'dev') as EnvName;
  const cfg = ENVIRONMENTS[name];
  if (!cfg) throw new Error(`Unknown env "${name}". Use -c env=dev or -c env=prod`);
  const str = (k: string) => {
    const v = app.tryGetContext(k) ?? process.env[`GRIDSIGHT_${k.replace(/[A-Z]/g, (c) => `_${c}`).toUpperCase()}`];
    return v === undefined || v === '' ? undefined : String(v);
  };
  const domains = str('allowedEmailDomains');
  const samlUrl = str('samlMetadataUrl');
  const oidcIssuer = str('oidcIssuerUrl');
  return {
    ...cfg,
    account: process.env.CDK_DEFAULT_ACCOUNT,
    domain: { ...cfg.domain, hostedZoneId: str('hostedZoneId') ?? cfg.domain.hostedZoneId },
    auth: {
      ...cfg.auth,
      allowedEmailDomains: domains ? domains.split(',') : cfg.auth.allowedEmailDomains,
      federation: {
        ...cfg.auth.federation,
        ...(samlUrl ? { saml: { name: str('samlProviderName') ?? 'CorporateSAML', metadataUrl: samlUrl } } : {}),
        ...(oidcIssuer
          ? { oidc: { name: str('oidcProviderName') ?? 'CorporateOIDC', issuerUrl: oidcIssuer, clientId: str('oidcClientId') ?? '', clientSecretName: str('oidcClientSecretName') ?? `gridsight/${name}/oidc-client-secret` } }
          : {}),
      },
    },
    observability: { ...cfg.observability, alarmEmail: str('alarmEmail') ?? cfg.observability.alarmEmail },
  };
}
