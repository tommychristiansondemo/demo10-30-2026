/**
 * Cognito Lambda triggers. Self-registration is deliberately low-friction for classroom use: users pick
 * a username, a password (6+ characters) and a role; accounts are confirmed immediately, no email needed.
 */
import { AdminAddUserToGroupCommand, CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import type { PostConfirmationTriggerEvent, PreSignUpTriggerEvent, PreTokenGenerationV2TriggerEvent } from 'aws-lambda';
import { ROLES, type Role } from '../lib/auth.js';

const cognito = new CognitoIdentityProviderClient({});
const ROLE_ATTRIBUTE = 'custom:role';

/** The role requested at sign-up, or the default group when absent. Unknown values are rejected earlier. */
export function requestedRole(attributes: Record<string, string | undefined>): Role {
  const raw = (attributes[ROLE_ATTRIBUTE] ?? '').trim().toLowerCase();
  return ROLES.find((r) => r.toLowerCase() === raw) ?? ((process.env.DEFAULT_GROUP ?? 'Viewer') as Role);
}

export const preSignUp = async (event: PreSignUpTriggerEvent) => {
  if (event.triggerSource === 'PreSignUp_ExternalProvider') return event; // corporate IdP already vetted the user
  const attrs = event.request.userAttributes;
  const raw = attrs[ROLE_ATTRIBUTE];
  if (raw && !ROLES.some((r) => r.toLowerCase() === raw.trim().toLowerCase())) {
    throw new Error(`Role must be one of: ${ROLES.join(', ')}`);
  }
  const allowed = (process.env.ALLOWED_EMAIL_DOMAINS ?? '').split(',').map((d) => d.trim().toLowerCase()).filter(Boolean);
  const email = (attrs.email ?? '').toLowerCase();
  if (allowed.length && !allowed.some((d) => email.endsWith(`@${d}`))) {
    throw new Error(`Sign-up is restricted to: ${allowed.join(', ')}`);
  }
  // No verification codes: the account is usable as soon as it is created.
  event.response.autoConfirmUser = true;
  return event;
};

export const postConfirmation = async (event: PostConfirmationTriggerEvent) => {
  if (event.triggerSource === 'PostConfirmation_ConfirmSignUp') {
    const GroupName = requestedRole(event.request.userAttributes);
    await cognito.send(new AdminAddUserToGroupCommand({ UserPoolId: event.userPoolId, Username: event.userName, GroupName }));
  }
  return event;
};

/**
 * Pre token generation (V2): copy the user's email (if any) into the access token so APIs and the audit
 * log can show it, and make sure a freshly registered user's first token already carries their role.
 * Groups changed later by an Admin take precedence; this only fills in a user who has no group yet.
 */
export const preTokenGeneration = async (event: PreTokenGenerationV2TriggerEvent) => {
  const attrs = event.request.userAttributes;
  const details: NonNullable<PreTokenGenerationV2TriggerEvent['response']['claimsAndScopeOverrideDetails']> = {
    ...event.response?.claimsAndScopeOverrideDetails,
  };
  if (attrs.email) details.accessTokenGeneration = { claimsToAddOrOverride: { email: attrs.email } };

  const groups = event.request.groupConfiguration?.groupsToOverride ?? [];
  if (groups.length === 0 && attrs['cognito:user_status'] !== 'EXTERNAL_PROVIDER') {
    const role = requestedRole(attrs);
    await cognito.send(new AdminAddUserToGroupCommand({ UserPoolId: event.userPoolId, Username: event.userName, GroupName: role }));
    details.groupOverrideDetails = { groupsToOverride: [role] };
  }
  event.response = { claimsAndScopeOverrideDetails: details };
  return event;
};
