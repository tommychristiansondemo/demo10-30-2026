/**
 * WebSocket $connect authorizer. Browsers cannot set headers on WebSocket upgrades, so the
 * Cognito access token is passed as ?token=…; it is verified here (signature, expiry, client id).
 */
import type { APIGatewayRequestAuthorizerEvent, APIGatewayAuthorizerResult } from 'aws-lambda';
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import { principalFromClaims } from '../lib/auth.js';
import { env } from '../lib/env.js';
import { logger } from '../lib/observability.js';
import { originAllowed } from '../lib/origin.js';

let verifier: ReturnType<typeof CognitoJwtVerifier.create<{ userPoolId: string; tokenUse: 'access'; clientId: string[] }>> | undefined;

export const handler = async (event: APIGatewayRequestAuthorizerEvent): Promise<APIGatewayAuthorizerResult> => {
  verifier ??= CognitoJwtVerifier.create({ userPoolId: env.userPoolId, tokenUse: 'access', clientId: env.userPoolClientIds });
  const deny = (reason: string): APIGatewayAuthorizerResult => {
    logger.warn('websocket connect denied', { reason });
    return { principalId: 'anonymous', policyDocument: { Version: '2012-10-17', Statement: [{ Action: 'execute-api:Invoke', Effect: 'Deny', Resource: event.methodArn }] } };
  };
  if (!(await originAllowed(event.headers as Record<string, string>))) return deny('origin');
  const token = event.queryStringParameters?.token;
  if (!token) return deny('missing token');
  try {
    const claims = await verifier.verify(token);
    const p = principalFromClaims(claims as unknown as Record<string, unknown>);
    return {
      principalId: p.sub,
      policyDocument: { Version: '2012-10-17', Statement: [{ Action: 'execute-api:Invoke', Effect: 'Allow', Resource: event.methodArn }] },
      context: { sub: p.sub, username: p.username, email: p.email ?? '', role: p.role, groups: p.groups.join(',') },
    };
  } catch (err) {
    return deny((err as Error).message);
  }
};
