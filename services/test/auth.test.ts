import { describe, expect, it } from 'vitest';
import { effectiveRole, hasRole, principalFromClaims } from '../src/lib/auth.js';
import { Router } from '../src/lib/http.js';

describe('roles', () => {
  it('picks the highest group and defaults to Viewer', () => {
    expect(effectiveRole([])).toBe('Viewer');
    expect(effectiveRole(['Analyst', 'Operator'])).toBe('Operator');
    expect(effectiveRole(['admin'])).toBe('Admin');
  });
  it('parses API Gateway flattened group claims', () => {
    expect(principalFromClaims({ sub: 'u1', 'cognito:groups': '[Viewer Analyst]' }).role).toBe('Analyst');
  });
  it('enforces hierarchy', () => {
    const p = principalFromClaims({ sub: 'u', 'cognito:groups': ['Operator'] });
    expect(hasRole(p, 'Analyst')).toBe(true);
    expect(hasRole(p, 'Admin')).toBe(false);
  });
});

describe('router', () => {
  const router = new Router()
    .get('/v1/health', 'public', async () => ({ ok: true }))
    .get('/v1/admin/thing/{id}', 'Admin', async (ctx) => ({ id: ctx.params.id }));
  const ev = (path: string, groups?: string[]) =>
    ({
      rawPath: path,
      requestContext: { requestId: 'r', http: { method: 'GET', sourceIp: '1.1.1.1' }, authorizer: groups ? { jwt: { claims: { sub: 'u', 'cognito:groups': groups } } } : undefined },
    }) as any;

  it('serves public routes without a token', async () => {
    expect((await router.handle(ev('/v1/health'))).statusCode).toBe(200);
  });
  it('returns 401/403/404 appropriately', async () => {
    expect((await router.handle(ev('/v1/admin/thing/1'))).statusCode).toBe(401);
    expect((await router.handle(ev('/v1/admin/thing/1', ['Analyst']))).statusCode).toBe(403);
    expect((await router.handle(ev('/v1/nope', ['Admin']))).statusCode).toBe(404);
    const ok = await router.handle(ev('/v1/admin/thing/42', ['Admin']));
    expect(JSON.parse(ok.body ?? "{}")).toEqual({ id: '42' });
  });
});
