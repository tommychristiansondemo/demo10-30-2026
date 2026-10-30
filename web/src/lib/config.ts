export interface RuntimeConfig {
  env: string;
  region: string;
  userPoolId: string;
  userPoolClientId: string;
  cliClientId: string;
  identityPoolId: string;
  cognitoDomain: string;
  federatedProviders: string[];
  apiBaseUrl: string;
  publicApiUrl: string;
  appUrl: string;
  wsUrl: string;
  wsUrlDirect: string;
}

let runtime: RuntimeConfig | undefined;

/** Loaded from /config.json, which the CDK deployment writes with the stack outputs. */
export async function loadConfig(): Promise<RuntimeConfig> {
  if (runtime) return runtime;
  const res = await fetch('/config.json', { cache: 'no-store' });
  if (!res.ok) throw new Error('Missing /config.json. Deploy the stack, or run `npm run pull-config -w web` for local development.');
  runtime = (await res.json()) as RuntimeConfig;
  return runtime;
}

export function config(): RuntimeConfig {
  if (!runtime) throw new Error('config not loaded');
  return runtime;
}
