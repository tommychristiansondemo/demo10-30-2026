/** DynamoDB repositories for metrics (hot store), alerts, audit, chat sessions and WebSocket connections. */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  BatchWriteCommand,
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { randomUUID } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import type { Alert, GridInterval } from '../data/types.js';
import { env } from './env.js';

export const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true, convertClassInstanceToMap: true },
});

const ttlIn = (days: number) => Math.floor(Date.now() / 1000) + days * 86_400;

// ---------------------------------------------------------------------------
// Metrics hot store
// ---------------------------------------------------------------------------
export type Resolution = '5m' | '1h';
const seriesKey = (r: Resolution) => `GRID#${r}`;

export async function putIntervals(items: GridInterval[], resolution: Resolution): Promise<void> {
  const ttlDays = resolution === '5m' ? env.hotDays : env.hotDays * 3;
  for (let i = 0; i < items.length; i += 25) {
    let request: Record<string, any[]> | undefined = {
      [env.metricsTable]: items.slice(i, i + 25).map((it) => ({
        PutRequest: { Item: { series: seriesKey(resolution), ts: it.ts, data: it, ttl: ttlIn(ttlDays) } },
      })),
    };
    for (let attempt = 0; request && Object.keys(request).length > 0 && attempt < 8; attempt++) {
      const res = await ddb.send(new BatchWriteCommand({ RequestItems: request }));
      request = res.UnprocessedItems as Record<string, any[]> | undefined;
      if (request && Object.keys(request).length > 0) await new Promise((r) => setTimeout(r, 50 * 2 ** attempt));
    }
  }
}

export async function queryIntervals(startIso: string, endIso: string, resolution: Resolution, limit = 5000): Promise<GridInterval[]> {
  const out: GridInterval[] = [];
  let lastKey: Record<string, unknown> | undefined;
  do {
    const res = await ddb.send(
      new QueryCommand({
        TableName: env.metricsTable,
        KeyConditionExpression: 'series = :s AND ts BETWEEN :a AND :b',
        ExpressionAttributeValues: { ':s': seriesKey(resolution), ':a': startIso, ':b': endIso },
        ExclusiveStartKey: lastKey,
      }),
    );
    for (const item of res.Items ?? []) out.push(item.data as GridInterval);
    lastKey = res.LastEvaluatedKey;
  } while (lastKey && out.length < limit);
  return out.slice(0, limit);
}

export async function latestIntervals(n: number, resolution: Resolution = '5m'): Promise<GridInterval[]> {
  const res = await ddb.send(
    new QueryCommand({
      TableName: env.metricsTable,
      KeyConditionExpression: 'series = :s',
      ExpressionAttributeValues: { ':s': seriesKey(resolution) },
      ScanIndexForward: false,
      Limit: n,
    }),
  );
  return (res.Items ?? []).map((i) => i.data as GridInterval).reverse();
}

// ---------------------------------------------------------------------------
// Alerts
// ---------------------------------------------------------------------------

/** Insert only if the deterministic alert id is new (idempotent detection). Returns true if created. */
export async function createAlertIfAbsent(alert: Alert): Promise<boolean> {
  try {
    await ddb.send(
      new PutCommand({
        TableName: env.alertsTable,
        Item: { ...alert, ttl: ttlIn(90) },
        ConditionExpression: 'attribute_not_exists(id)',
      }),
    );
    return true;
  } catch (err: any) {
    if (err?.name === 'ConditionalCheckFailedException') return false;
    throw err;
  }
}

export async function listAlerts(status: Alert['status'], limit = 100, sinceIso?: string): Promise<Alert[]> {
  const res = await ddb.send(
    new QueryCommand({
      TableName: env.alertsTable,
      IndexName: 'byStatus',
      KeyConditionExpression: sinceIso ? '#s = :s AND ts >= :since' : '#s = :s',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: sinceIso ? { ':s': status, ':since': sinceIso } : { ':s': status },
      ScanIndexForward: false,
      Limit: limit,
    }),
  );
  return (res.Items ?? []) as Alert[];
}

export async function getAlert(id: string): Promise<Alert | undefined> {
  const res = await ddb.send(new GetCommand({ TableName: env.alertsTable, Key: { id } }));
  return res.Item as Alert | undefined;
}

export async function updateAlertStatus(id: string, status: Alert['status'], by: string, note?: string): Promise<Alert> {
  const at = new Date().toISOString();
  const res = await ddb.send(
    new UpdateCommand({
      TableName: env.alertsTable,
      Key: { id },
      ConditionExpression: 'attribute_exists(id)',
      UpdateExpression: 'SET #s = :s, updated_at = :at, updated_by = :by, notes = list_append(if_not_exists(notes, :empty), :n)',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: {
        ':s': status,
        ':at': at,
        ':by': by,
        ':empty': [],
        ':n': [{ at, by, text: note ?? `Status changed to ${status}` }],
      },
      ReturnValues: 'ALL_NEW',
    }),
  );
  return res.Attributes as Alert;
}

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------
export interface AuditEvent {
  actor: string;
  actorEmail?: string;
  role?: string;
  action: string;
  resource?: string;
  outcome: 'SUCCESS' | 'DENIED' | 'ERROR';
  details?: Record<string, unknown>;
  requestId?: string;
  sourceIp?: string;
}

export async function writeAudit(e: AuditEvent): Promise<void> {
  const ts = new Date().toISOString();
  await ddb.send(
    new PutCommand({
      TableName: env.auditTable,
      Item: { day: ts.slice(0, 10), sk: `${ts}#${randomUUID()}`, ts, ...e, ttl: ttlIn(400) },
    }),
  );
}

export async function queryAudit(day: string, limit = 200, actor?: string): Promise<Record<string, unknown>[]> {
  const res = await ddb.send(
    actor
      ? new QueryCommand({
          TableName: env.auditTable,
          IndexName: 'byActor',
          KeyConditionExpression: 'actor = :a AND begins_with(ts, :d)',
          ExpressionAttributeValues: { ':a': actor, ':d': day },
          ScanIndexForward: false,
          Limit: limit,
        })
      : new QueryCommand({
          TableName: env.auditTable,
          KeyConditionExpression: '#d = :d',
          ExpressionAttributeNames: { '#d': 'day' },
          ExpressionAttributeValues: { ':d': day },
          ScanIndexForward: false,
          Limit: limit,
        }),
  );
  return res.Items ?? [];
}

// ---------------------------------------------------------------------------
// Chat sessions (append-only turns; required for thinking-block replay)
// ---------------------------------------------------------------------------
export interface SessionMeta {
  sessionId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  turns: number;
  model: string;
}

export async function getSessionMeta(owner: string, sessionId: string): Promise<SessionMeta | undefined> {
  const res = await ddb.send(new GetCommand({ TableName: env.sessionsTable, Key: { pk: `USER#${owner}`, sk: `SESSION#${sessionId}` } }));
  return res.Item as SessionMeta | undefined;
}

export async function listSessions(owner: string, limit = 50): Promise<SessionMeta[]> {
  const res = await ddb.send(
    new QueryCommand({
      TableName: env.sessionsTable,
      KeyConditionExpression: 'pk = :p AND begins_with(sk, :s)',
      ExpressionAttributeValues: { ':p': `USER#${owner}`, ':s': 'SESSION#' },
      ScanIndexForward: false,
      Limit: limit,
    }),
  );
  return (res.Items ?? []) as SessionMeta[];
}

/** A turn stores the exact API message objects appended during that turn. */
export interface SessionTurn {
  turn: number;
  at: string;
  messages: unknown[];
  display: { user: string; assistant: string; tools: unknown[] };
}

export async function loadTurns(sessionId: string): Promise<SessionTurn[]> {
  const out: SessionTurn[] = [];
  let lastKey: Record<string, unknown> | undefined;
  do {
    const res = await ddb.send(
      new QueryCommand({
        TableName: env.sessionsTable,
        KeyConditionExpression: 'pk = :p AND begins_with(sk, :t)',
        ExpressionAttributeValues: { ':p': `SESSION#${sessionId}`, ':t': 'TURN#' },
        ExclusiveStartKey: lastKey,
      }),
    );
    for (const i of res.Items ?? []) {
      // Messages are gzipped JSON (binary); tool results and thinking blocks compress well.
      const raw = i.messages instanceof Uint8Array ? gunzipSync(i.messages).toString('utf8') : String(i.messages);
      out.push({ turn: i.turn, at: i.at, messages: JSON.parse(raw), display: i.display });
    }
    lastKey = res.LastEvaluatedKey;
  } while (lastKey);
  return out;
}

export async function appendTurn(owner: string, sessionId: string, turn: SessionTurn, title: string, model: string): Promise<void> {
  await ddb.send(
    new PutCommand({
      TableName: env.sessionsTable,
      Item: {
        pk: `SESSION#${sessionId}`,
        sk: `TURN#${String(turn.turn).padStart(4, '0')}`,
        turn: turn.turn,
        at: turn.at,
        messages: gzipSync(JSON.stringify(turn.messages)),
        display: turn.display,
        ttl: ttlIn(90),
      },
      ConditionExpression: 'attribute_not_exists(pk)',
    }),
  );
  await ddb.send(
    new UpdateCommand({
      TableName: env.sessionsTable,
      Key: { pk: `USER#${owner}`, sk: `SESSION#${sessionId}` },
      UpdateExpression:
        'SET sessionId = :id, title = if_not_exists(title, :title), createdAt = if_not_exists(createdAt, :at), updatedAt = :at, turns = :n, model = :m, #ttl = :ttl',
      ExpressionAttributeNames: { '#ttl': 'ttl' },
      ExpressionAttributeValues: { ':id': sessionId, ':title': title, ':at': turn.at, ':n': turn.turn, ':m': model, ':ttl': ttlIn(90) },
    }),
  );
}

// ---------------------------------------------------------------------------
// WebSocket connections
// ---------------------------------------------------------------------------
export interface Connection { connectionId: string; sub: string; email?: string; role: string; connectedAt: string }

export async function putConnection(c: Connection): Promise<void> {
  await ddb.send(new PutCommand({ TableName: env.connectionsTable, Item: { ...c, ttl: ttlIn(1) } }));
}
export async function deleteConnection(connectionId: string): Promise<void> {
  await ddb.send(new DeleteCommand({ TableName: env.connectionsTable, Key: { connectionId } }));
}
export async function getConnection(connectionId: string): Promise<Connection | undefined> {
  const res = await ddb.send(new GetCommand({ TableName: env.connectionsTable, Key: { connectionId } }));
  return res.Item as Connection | undefined;
}
export async function allConnections(): Promise<Connection[]> {
  const out: Connection[] = [];
  let lastKey: Record<string, unknown> | undefined;
  do {
    const res = await ddb.send(new ScanCommand({ TableName: env.connectionsTable, ExclusiveStartKey: lastKey }));
    out.push(...((res.Items ?? []) as Connection[]));
    lastKey = res.LastEvaluatedKey;
  } while (lastKey);
  return out;
}
