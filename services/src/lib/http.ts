/** Minimal router for API Gateway HTTP API (payload v2) with JWT claims, role checks and JSON errors. */
import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { ZodError, type ZodType } from 'zod';
import { hasRole, principalFromClaims, type Principal, type Role } from './auth.js';

export class HttpError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) {
    super(message);
  }
}

export interface RequestContext {
  event: APIGatewayProxyEventV2WithJWTAuthorizer;
  principal: Principal;
  params: Record<string, string>;
  query: Record<string, string>;
  requestId: string;
  sourceIp: string;
  body<T>(schema: ZodType<T>): T;
}

type Handler = (ctx: RequestContext) => Promise<unknown>;
interface Route { method: string; pattern: RegExp; keys: string[]; role: Role | 'public'; handler: Handler }

export class Router {
  private routes: Route[] = [];

  add(method: string, path: string, role: Role | 'public', handler: Handler): this {
    const keys: string[] = [];
    const pattern = new RegExp(
      '^' + path.replace(/\{(\w+)\}/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '/?$',
    );
    this.routes.push({ method, pattern, keys, role, handler });
    return this;
  }

  get(p: string, role: Role | 'public', h: Handler) { return this.add('GET', p, role, h); }
  post(p: string, role: Role | 'public', h: Handler) { return this.add('POST', p, role, h); }
  put(p: string, role: Role | 'public', h: Handler) { return this.add('PUT', p, role, h); }

  async handle(event: APIGatewayProxyEventV2WithJWTAuthorizer): Promise<APIGatewayProxyStructuredResultV2> {
    const method = event.requestContext.http.method;
    const path = event.rawPath;
    const requestId = event.requestContext.requestId;
    try {
      const matches = this.routes.filter((r) => r.pattern.test(path));
      if (matches.length === 0) throw new HttpError(404, 'not_found', `No route for ${path}`);
      const route = matches.find((r) => r.method === method);
      if (!route) throw new HttpError(405, 'method_not_allowed', `${method} not allowed on ${path}`);

      const claims = (event.requestContext.authorizer?.jwt?.claims ?? {}) as Record<string, unknown>;
      const principal = principalFromClaims(claims);
      if (route.role !== 'public') {
        if (!principal.sub) throw new HttpError(401, 'unauthorized', 'Missing or invalid token');
        if (!hasRole(principal, route.role)) {
          throw new HttpError(403, 'forbidden', `This action requires the ${route.role} role (you are ${principal.role})`);
        }
      }
      const m = path.match(route.pattern)!;
      const params = Object.fromEntries(route.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
      const ctx: RequestContext = {
        event,
        principal,
        params,
        query: (event.queryStringParameters ?? {}) as Record<string, string>,
        requestId,
        sourceIp: event.requestContext.http.sourceIp,
        body<T>(schema: ZodType<T>): T {
          let raw: unknown = {};
          if (event.body) {
            const text = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
            try { raw = JSON.parse(text); } catch { throw new HttpError(400, 'invalid_json', 'Request body is not valid JSON'); }
          }
          return schema.parse(raw);
        },
      };
      const result = await route.handler(ctx);
      return json(200, result, requestId);
    } catch (err) {
      if (err instanceof HttpError) return json(err.status, { error: { code: err.code, message: err.message, details: err.details, requestId } }, requestId);
      if (err instanceof ZodError) return json(400, { error: { code: 'validation_error', message: 'Invalid request', details: err.issues, requestId } }, requestId);
      throw err;
    }
  }
}

export function json(status: number, body: unknown, requestId?: string): APIGatewayProxyStructuredResultV2 {
  return {
    statusCode: status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      ...(requestId ? { 'x-request-id': requestId } : {}),
    },
    body: JSON.stringify(body),
  };
}
