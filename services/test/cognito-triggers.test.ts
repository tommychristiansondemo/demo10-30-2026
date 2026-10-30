import { beforeEach, describe, expect, it, vi } from 'vitest';

const send = vi.fn();
vi.mock('@aws-sdk/client-cognito-identity-provider', () => ({
  CognitoIdentityProviderClient: class { send = send; },
  AdminAddUserToGroupCommand: class { constructor(public input: unknown) {} },
}));

const { preSignUp, postConfirmation, preTokenGeneration, requestedRole } = await import('../src/handlers/cognito-triggers.js');

// Minimal event shapes: the triggers only read the fields below.
const signUpEvent = (attrs: Record<string, string>) =>
  ({ triggerSource: 'PreSignUp_SignUp', userPoolId: 'pool', userName: 'student1', request: { userAttributes: attrs }, response: {} }) as never;

describe('cognito triggers', () => {
  beforeEach(() => send.mockReset());

  it('auto-confirms sign-ups and accepts any role name case-insensitively', async () => {
    const out = (await preSignUp(signUpEvent({ 'custom:role': 'operator' }))) as { response: { autoConfirmUser?: boolean } };
    expect(out.response.autoConfirmUser).toBe(true);
    expect(requestedRole({ 'custom:role': 'ADMIN' })).toBe('Admin');
    expect(requestedRole({})).toBe('Viewer');
  });

  it('rejects unknown roles', async () => {
    await expect(preSignUp(signUpEvent({ 'custom:role': 'Superuser' }))).rejects.toThrow(/Role must be one of/);
  });

  it('adds the confirmed user to the requested group', async () => {
    await postConfirmation({ triggerSource: 'PostConfirmation_ConfirmSignUp', userPoolId: 'pool', userName: 'student1', request: { userAttributes: { 'custom:role': 'Analyst' } }, response: {} } as never);
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0][0].input).toEqual({ UserPoolId: 'pool', Username: 'student1', GroupName: 'Analyst' });
  });

  it('fills in the role for a user with no group, and leaves existing groups alone', async () => {
    const event = (groups: string[]) =>
      ({ userPoolId: 'pool', userName: 'student1', request: { userAttributes: { 'custom:role': 'Operator' }, groupConfiguration: { groupsToOverride: groups } }, response: {} }) as never;
    const first = (await preTokenGeneration(event([]))) as { response: { claimsAndScopeOverrideDetails: { groupOverrideDetails?: { groupsToOverride: string[] } } } };
    expect(first.response.claimsAndScopeOverrideDetails.groupOverrideDetails?.groupsToOverride).toEqual(['Operator']);
    expect(send).toHaveBeenCalledOnce();

    send.mockReset();
    const later = (await preTokenGeneration(event(['Admin']))) as { response: { claimsAndScopeOverrideDetails: { groupOverrideDetails?: unknown } } };
    expect(later.response.claimsAndScopeOverrideDetails.groupOverrideDetails).toBeUndefined();
    expect(send).not.toHaveBeenCalled();
  });
});
