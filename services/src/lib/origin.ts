/**
 * Origin verification: CloudFront adds a secret header to every origin request so the API can
 * reject traffic that bypassed CloudFront + WAF and hit execute-api directly.
 */
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { timingSafeEqual } from 'node:crypto';
import { env } from './env.js';

export const ORIGIN_HEADER = 'x-gridsight-origin-verify';
const sm = new SecretsManagerClient({});
let cached: { value: string; at: number } | undefined;

async function secret(): Promise<string> {
  if (cached && Date.now() - cached.at < 300_000) return cached.value;
  const res = await sm.send(new GetSecretValueCommand({ SecretId: env.originVerifySecretArn }));
  cached = { value: res.SecretString ?? '', at: Date.now() };
  return cached.value;
}

export async function originAllowed(headers: Record<string, string | undefined> | undefined): Promise<boolean> {
  if (!env.enforceOriginVerify) return true;
  const got = headers?.[ORIGIN_HEADER] ?? '';
  const want = await secret();
  if (!want || got.length !== want.length) return false;
  return timingSafeEqual(Buffer.from(got), Buffer.from(want));
}
