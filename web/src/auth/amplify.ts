import { Amplify } from 'aws-amplify';
import { fetchAuthSession } from 'aws-amplify/auth';
import type { RuntimeConfig } from '../lib/config';

export function configureAmplify(cfg: RuntimeConfig) {
  const origin = `${window.location.origin}/`;
  Amplify.configure({
    Auth: {
      Cognito: {
        userPoolId: cfg.userPoolId,
        userPoolClientId: cfg.userPoolClientId,
        identityPoolId: cfg.identityPoolId,
        loginWith: {
          email: true,
          oauth: {
            domain: cfg.cognitoDomain,
            scopes: ['openid', 'email', 'profile'],
            redirectSignIn: [origin],
            redirectSignOut: [origin],
            responseType: 'code',
            providers: cfg.federatedProviders.map((custom) => ({ custom })),
          },
        },
      },
    },
  });
}

/** Cognito access token (carries cognito:groups); refreshed automatically by Amplify. */
export async function accessToken(): Promise<string> {
  const session = await fetchAuthSession();
  const token = session.tokens?.accessToken?.toString();
  if (!token) throw new Error('Not signed in');
  return token;
}
