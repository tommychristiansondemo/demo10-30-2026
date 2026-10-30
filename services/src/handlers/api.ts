/** REST API (API Gateway HTTP API, JWT-authorized). Routes are documented in api/openapi.yaml. */
import {
  AdminAddUserToGroupCommand,
  AdminListGroupsForUserCommand,
  AdminRemoveUserFromGroupCommand,
  CognitoIdentityProviderClient,
  ListUsersCommand,
  ListUsersInGroupCommand,
  type UserType,
} from '@aws-sdk/client-cognito-identity-provider';
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { chatTurn } from '../ai/chat-session.js';
import { generateSql } from '../ai/agent.js';
import { sqlSystemPrompt } from '../ai/prompts.js';
import { eventsBetween, HOUR_MS } from '../data/generator.js';
import type { Alert } from '../data/types.js';
import { runQuery } from '../lib/athena.js';
import { ROLES } from '../lib/auth.js';
import { getConfig, publicConfig, putConfig } from '../lib/config.js';
import { env } from '../lib/env.js';
import * as grid from '../lib/grid-service.js';
import { HttpError, json, Router, type RequestContext } from '../lib/http.js';
import { flushMetrics, logger, metrics, MetricUnit } from '../lib/observability.js';
import { originAllowed } from '../lib/origin.js';
import * as repo from '../lib/repo.js';
import { SqlRejected } from '../lib/sql-guard.js';
import { broadcast } from '../lib/ws.js';

const cognito = new CognitoIdentityProviderClient({});
const isoOr = (v: string | undefined, fallback: number) => (v && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : new Date(fallback).toISOString());
const intParam = (v: string | undefined, def: number, min: number, max: number) => Math.min(max, Math.max(min, Number.parseInt(v ?? '', 10) || def));

async function audit(ctx: RequestContext, action: string, resource: string, details?: Record<string, unknown>, outcome: 'SUCCESS' | 'DENIED' | 'ERROR' = 'SUCCESS') {
  await repo.writeAudit({ actor: ctx.principal.sub, actorEmail: ctx.principal.email, role: ctx.principal.role, action, resource, outcome, details, requestId: ctx.requestId, sourceIp: ctx.sourceIp });
}

async function requireFeature(flag: keyof Awaited<ReturnType<typeof getConfig>>['config']['features']) {
  const { config } = await getConfig();
  if (!config.features[flag]) throw new HttpError(503, 'feature_disabled', `Feature '${flag}' is disabled`);
  return config;
}

function wrapNotReady<T>(p: Promise<T>): Promise<T> {
  return p.catch((err) => {
    if (err instanceof grid.NotReadyError) throw new HttpError(503, 'not_ready', err.message);
    throw err;
  });
}

const router = new Router()
  .get('/v1/health', 'public', async () => ({ status: 'ok', env: env.stage, time: new Date().toISOString() }))

  .get('/v1/me', 'Viewer', async (ctx) => {
    const { config } = await getConfig();
    return { user: ctx.principal, config: publicConfig(config) };
  })

  // ---- Grid data ---------------------------------------------------------------
  .get('/v1/grid/current', 'Viewer', async () => wrapNotReady(grid.snapshot()))
  .get('/v1/grid/series', 'Viewer', async (ctx) => {
    const end = Date.now();
    const startIso = isoOr(ctx.query.start, end - 24 * HOUR_MS);
    const endIso = isoOr(ctx.query.end, end);
    if (Date.parse(endIso) - Date.parse(startIso) > 31 * 24 * HOUR_MS) throw new HttpError(400, 'range_too_large', 'Maximum range is 31 days; use /v1/query/sql for longer history');
    const resolution = ctx.query.resolution === '5m' || ctx.query.resolution === '1h' ? ctx.query.resolution : undefined;
    return grid.series(startIso, endIso, resolution);
  })
  .get('/v1/grid/events', 'Viewer', async (ctx) => {
    const end = Date.now();
    const s = Date.parse(isoOr(ctx.query.start, end - 7 * 24 * HOUR_MS));
    const e = Math.min(end, Date.parse(isoOr(ctx.query.end, end)));
    return { events: eventsBetween(s, e, env.dataSeed).filter((x) => Date.parse(x.start) <= end).reverse() };
  })

  // ---- Analytics -----------------------------------------------------------------
  .get('/v1/forecast/load', 'Analyst', async (ctx) => {
    await requireFeature('forecasting');
    return wrapNotReady(grid.loadForecast(intParam(ctx.query.hours, 48, 1, 72)));
  })
  .get('/v1/anomalies', 'Analyst', async (ctx) => {
    const { config } = await getConfig();
    return wrapNotReady(grid.anomalies(intParam(ctx.query.hours, 24, 1, 72), config.anomaly));
  })

  // ---- Alerts --------------------------------------------------------------------
  .get('/v1/alerts', 'Viewer', async (ctx) => {
    const status = (['OPEN', 'ACKNOWLEDGED', 'RESOLVED'] as const).find((s) => s === ctx.query.status) ?? 'OPEN';
    return { alerts: await repo.listAlerts(status, intParam(ctx.query.limit, 100, 1, 500)) };
  })
  .post('/v1/alerts', 'Operator', async (ctx) => {
    const body = ctx.body(z.object({ title: z.string().min(3).max(200), message: z.string().max(4000), severity: z.enum(['INFO', 'WARNING', 'CRITICAL']), zone: z.string().max(40).optional() }));
    const ts = new Date().toISOString();
    const alert: Alert = { id: `MANUAL#${randomUUID()}`, ts, type: 'MANUAL', metric: 'n/a', status: 'OPEN', source: 'manual', updated_by: ctx.principal.email ?? ctx.principal.sub, ...body };
    await repo.createAlertIfAbsent(alert);
    await audit(ctx, 'alert.create', alert.id, { title: body.title, severity: body.severity });
    await broadcast({ type: 'alert.new', data: alert });
    return alert;
  })
  .post('/v1/alerts/{id}/ack', 'Operator', async (ctx) => alertTransition(ctx, 'ACKNOWLEDGED'))
  .post('/v1/alerts/{id}/resolve', 'Operator', async (ctx) => alertTransition(ctx, 'RESOLVED'))

  // ---- AI ----------------------------------------------------------------------
  .post('/v1/ai/ask', 'Analyst', async (ctx) => {
    const body = ctx.body(z.object({ message: z.string().min(1).max(8000), sessionId: z.string().uuid().optional() }));
    // API Gateway HTTP APIs time out at 30 s, so the synchronous endpoint caps tool iterations.
    // Use the WebSocket API for streaming and longer multi-step analyses.
    const r = await chatTurn({ principal: ctx.principal, sessionId: body.sessionId, message: body.message, requestId: ctx.requestId, sourceIp: ctx.sourceIp, channel: 'rest', maxIterations: 3 });
    return { sessionId: r.sessionId, turn: r.turn, answer: r.text, model: r.model, tools: r.tools, usage: r.usage };
  })
  .get('/v1/ai/sessions', 'Analyst', async (ctx) => ({ sessions: await repo.listSessions(ctx.principal.sub) }))
  .get('/v1/ai/sessions/{id}', 'Analyst', async (ctx) => {
    const meta = await repo.getSessionMeta(ctx.principal.sub, ctx.params.id);
    if (!meta) throw new HttpError(404, 'session_not_found', 'Chat session not found');
    const turns = await repo.loadTurns(ctx.params.id);
    return { ...meta, turns: turns.map((t) => ({ turn: t.turn, at: t.at, ...t.display })) };
  })
  .post('/v1/ai/sql', 'Analyst', async (ctx) => {
    const config = await requireFeature('nlToSql');
    const body = ctx.body(z.object({ question: z.string().min(3).max(2000), execute: z.boolean().default(true) }));
    const gen = await generateSql(body.question, config, sqlSystemPrompt(env.glueDatabase));
    let result: Awaited<ReturnType<typeof runQuery>> | undefined;
    let error: string | undefined;
    if (body.execute) {
      try { result = await runQuery(gen.sql, { maxRows: 1000 }); } catch (err) { error = (err as Error).message; }
    }
    await audit(ctx, 'ai.nl_to_sql', 'athena', { question: body.question, sql: gen.sql, executed: body.execute, error, bytesScanned: result?.stats.bytesScanned }, error ? 'ERROR' : 'SUCCESS');
    return { question: body.question, sql: result?.sql ?? gen.sql, explanation: gen.explanation, result, error };
  })
  .post('/v1/query/sql', 'Analyst', async (ctx) => {
    const body = ctx.body(z.object({ sql: z.string().min(10).max(8000), maxRows: z.number().int().min(1).max(10000).default(1000) }));
    try {
      const r = await runQuery(body.sql, { maxRows: body.maxRows });
      metrics.addMetric('SqlBytesScanned', MetricUnit.Bytes, r.stats.bytesScanned);
      await audit(ctx, 'query.sql', 'athena', { sql: r.sql, rows: r.rows.length, bytesScanned: r.stats.bytesScanned });
      return r;
    } catch (err) {
      if (err instanceof SqlRejected) {
        await audit(ctx, 'query.sql', 'athena', { sql: body.sql, reason: err.message }, 'DENIED');
        throw new HttpError(400, 'sql_rejected', err.message);
      }
      throw new HttpError(400, 'query_failed', (err as Error).message);
    }
  })
  .get('/v1/kb/search', 'Analyst', async (ctx) => {
    await requireFeature('knowledgeSearch');
    if (!ctx.query.q) throw new HttpError(400, 'missing_query', 'Query parameter q is required');
    return { passages: await wrapNotReady(grid.searchKnowledge(ctx.query.q, intParam(ctx.query.limit, 5, 1, 10))) };
  })

  // ---- Admin -------------------------------------------------------------------
  .get('/v1/admin/config', 'Admin', async () => getConfig(true))
  .put('/v1/admin/config', 'Admin', async (ctx) => {
    const before = (await getConfig(true)).config;
    const next = ctx.body(z.record(z.unknown()));
    const saved = await putConfig(next);
    await audit(ctx, 'admin.config.update', 'config', { version: saved.version, before, after: saved.config });
    return saved;
  })
  .get('/v1/admin/audit', 'Admin', async (ctx) => {
    const day = /^\d{4}-\d{2}-\d{2}$/.test(ctx.query.date ?? '') ? ctx.query.date! : new Date().toISOString().slice(0, 10);
    return { date: day, events: await repo.queryAudit(day, intParam(ctx.query.limit, 200, 1, 1000), ctx.query.actor) };
  })
  .get('/v1/admin/users', 'Admin', async () => {
    // Students may each register several accounts, so page through the whole pool (capped). Group
    // membership comes from one paged listing per role group rather than a call per user (throttling).
    const listAll = async (fetchPage: (token?: string) => Promise<{ Users?: UserType[]; next?: string }>) => {
      const out: UserType[] = [];
      let token: string | undefined;
      do {
        const page = await fetchPage(token);
        out.push(...(page.Users ?? []));
        token = page.next;
      } while (token && out.length < 2000);
      return out;
    };
    const [all, ...members] = await Promise.all([
      listAll(async (PaginationToken) => {
        const r = await cognito.send(new ListUsersCommand({ UserPoolId: env.userPoolId, Limit: 60, PaginationToken }));
        return { Users: r.Users, next: r.PaginationToken };
      }),
      ...ROLES.map((GroupName) =>
        listAll(async (NextToken) => {
          const r = await cognito.send(new ListUsersInGroupCommand({ UserPoolId: env.userPoolId, GroupName, Limit: 60, NextToken }));
          return { Users: r.Users, next: r.NextToken };
        }),
      ),
    ]);
    const groupsOf = new Map<string, string[]>();
    ROLES.forEach((role, i) => members[i].forEach((u) => groupsOf.set(u.Username!, [...(groupsOf.get(u.Username!) ?? []), role])));
    const users = all
      .sort((x, y) => (y.UserCreateDate?.getTime() ?? 0) - (x.UserCreateDate?.getTime() ?? 0))
      .map((u) => ({
        username: u.Username,
        email: u.Attributes?.find((a) => a.Name === 'email')?.Value,
        status: u.UserStatus,
        enabled: u.Enabled,
        createdAt: u.UserCreateDate,
        groups: groupsOf.get(u.Username!) ?? [],
      }));
    return { users };
  })
  .put('/v1/admin/users/{username}/role', 'Admin', async (ctx) => {
    const { role } = ctx.body(z.object({ role: z.enum(ROLES) }));
    const username = ctx.params.username;
    if (username === ctx.principal.username && role !== 'Admin') throw new HttpError(400, 'self_demotion', 'Admins cannot remove their own Admin role');
    const current = await cognito.send(new AdminListGroupsForUserCommand({ UserPoolId: env.userPoolId, Username: username }));
    for (const g of current.Groups ?? []) {
      if (ROLES.includes(g.GroupName as any) && g.GroupName !== role) {
        await cognito.send(new AdminRemoveUserFromGroupCommand({ UserPoolId: env.userPoolId, Username: username, GroupName: g.GroupName! }));
      }
    }
    await cognito.send(new AdminAddUserToGroupCommand({ UserPoolId: env.userPoolId, Username: username, GroupName: role }));
    await audit(ctx, 'admin.user.role', `user/${username}`, { role, previous: (current.Groups ?? []).map((g) => g.GroupName) });
    return { username, role, note: 'The new role applies when the user next refreshes their token (within 1 hour) or signs in again.' };
  });

async function alertTransition(ctx: RequestContext, status: 'ACKNOWLEDGED' | 'RESOLVED') {
  const { note } = ctx.body(z.object({ note: z.string().max(2000).optional() }));
  const existing = await repo.getAlert(ctx.params.id);
  if (!existing) throw new HttpError(404, 'alert_not_found', 'Alert not found');
  if (existing.status === 'RESOLVED') throw new HttpError(409, 'alert_resolved', 'Alert is already resolved');
  const updated = await repo.updateAlertStatus(ctx.params.id, status, ctx.principal.email ?? ctx.principal.sub, note);
  await audit(ctx, status === 'ACKNOWLEDGED' ? 'alert.acknowledge' : 'alert.resolve', `alert/${ctx.params.id}`, { from: existing.status, note });
  await broadcast({ type: 'alert.updated', data: updated });
  return updated;
}

export const handler = async (event: APIGatewayProxyEventV2WithJWTAuthorizer) => {
  logger.addContext({ awsRequestId: event.requestContext.requestId } as any);
  logger.appendKeys({ route: `${event.requestContext.http.method} ${event.rawPath}` });
  try {
    if (!(await originAllowed(event.headers))) return json(403, { error: { code: 'forbidden', message: 'Direct access is not allowed; use the CloudFront endpoint' } });
    const res = await router.handle(event);
    logger.info('request', { status: res.statusCode, user: event.requestContext.authorizer?.jwt?.claims?.sub });
    return res;
  } catch (err) {
    logger.error('unhandled error', err as Error);
    metrics.addMetric('ApiErrors', MetricUnit.Count, 1);
    return json(500, { error: { code: 'internal_error', message: 'Internal error', requestId: event.requestContext.requestId } });
  } finally {
    flushMetrics();
  }
};
