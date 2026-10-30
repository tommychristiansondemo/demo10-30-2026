/**
 * Request guards for the Insights API (a Lambda function URL behind CloudFront):
 *  1. the CloudFront origin-verify header, so the function URL can't be called directly (bypassing WAF);
 *  2. a GridSight Cognito access token (any role) in `x-gs-token`. A custom header is used because
 *     CloudFront only forwards Authorization when it's part of the cache key.
 */
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import { timingSafeEqual } from 'node:crypto';
import { env } from './env.js';

export const ORIGIN_HEADER = 'x-insights-origin-verify';
export const TOKEN_HEADER = 'x-gs-token';

let originSecret: Promise<string> | undefined;
export function getOriginSecret(): Promise<string> {
  originSecret ??= env.originVerifySecretArn
    ? new SecretsManagerClient({}).send(new GetSecretValueCommand({ SecretId: env.originVerifySecretArn })).then((r) => r.SecretString ?? '')
    : Promise.resolve('');
  return originSecret;
}

export async function originOk(headers: Record<string, string | undefined>): Promise<boolean> {
  const expected = await getOriginSecret();
  if (!expected) return true; // local/dev without a secret configured
  const got = headers[ORIGIN_HEADER] ?? '';
  return got.length === expected.length && timingSafeEqual(Buffer.from(got), Buffer.from(expected));
}

let verifier: ReturnType<typeof CognitoJwtVerifier.create<{ userPoolId: string; tokenUse: 'access'; clientId: string[] }>> | undefined;

export interface Viewer { sub: string; username: string; groups: string[] }

export async function viewerFrom(headers: Record<string, string | undefined>): Promise<Viewer | undefined> {
  const token = headers[TOKEN_HEADER];
  if (!token) return undefined;
  verifier ??= CognitoJwtVerifier.create({ userPoolId: env.userPoolId, tokenUse: 'access', clientId: env.userPoolClientIds });
  try {
    const claims = await verifier.verify(token);
    return { sub: claims.sub, username: String(claims.username ?? claims.sub), groups: (claims['cognito:groups'] as string[] | undefined) ?? [] };
  } catch {
    return undefined;
  }
}
