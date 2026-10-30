/**
 * WebSocket message routes. `chat` validates the request and hands it to the chat worker
 * asynchronously (API Gateway WebSocket integrations time out at 29 s; agent turns can take longer).
 */
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import type { APIGatewayProxyWebsocketEventV2 } from 'aws-lambda';
import { z } from 'zod';
import { effectiveRole, hasRole } from '../lib/auth.js';
import { env } from '../lib/env.js';
import { logger } from '../lib/observability.js';
import { getConnection } from '../lib/repo.js';
import { postToConnection } from '../lib/ws.js';

const lambda = new LambdaClient({});

const ChatMessage = z.object({
  action: z.literal('chat'),
  requestId: z.string().min(1).max(64),
  sessionId: z.string().uuid().optional(),
  message: z.string().min(1).max(8000),
});

export const handler = async (event: APIGatewayProxyWebsocketEventV2) => {
  const connectionId = event.requestContext.connectionId;
  let body: any;
  try { body = JSON.parse(event.body ?? '{}'); } catch { body = {}; }

  if (body.action === 'ping') {
    await postToConnection(connectionId, { type: 'pong', ts: new Date().toISOString() });
    return { statusCode: 200 };
  }
  if (body.action !== 'chat') {
    await postToConnection(connectionId, { type: 'error', code: 'unknown_action', message: 'Supported actions: chat, ping' });
    return { statusCode: 200 };
  }

  const parsed = ChatMessage.safeParse(body);
  if (!parsed.success) {
    await postToConnection(connectionId, { type: 'chat.error', requestId: body.requestId, code: 'validation_error', message: parsed.error.issues.map((i) => i.message).join('; ') });
    return { statusCode: 200 };
  }
  const conn = await getConnection(connectionId);
  const role = effectiveRole([conn?.role ?? 'Viewer']);
  if (!conn || !hasRole({ sub: conn.sub, username: conn.email ?? '', groups: [role], role }, 'Analyst')) {
    await postToConnection(connectionId, { type: 'chat.error', requestId: parsed.data.requestId, code: 'forbidden', message: 'The AI assistant requires the Analyst role' });
    return { statusCode: 200 };
  }

  await lambda.send(
    new InvokeCommand({
      FunctionName: env.chatWorkerFunction,
      InvocationType: 'Event',
      Payload: Buffer.from(JSON.stringify({ connectionId, sub: conn.sub, username: conn.email, role, ...parsed.data, sourceIp: (event.requestContext as { identity?: { sourceIp?: string } }).identity?.sourceIp })),
    }),
  );
  await postToConnection(connectionId, { type: 'chat.accepted', requestId: parsed.data.requestId });
  logger.info('chat dispatched', { connectionId, requestId: parsed.data.requestId });
  return { statusCode: 200 };
};
