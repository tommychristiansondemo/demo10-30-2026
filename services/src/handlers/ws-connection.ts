/** $connect / $disconnect: track live connections for broadcasts and chat streaming. */
import type { APIGatewayProxyWebsocketEventV2 } from 'aws-lambda';
import { deleteConnection, putConnection } from '../lib/repo.js';
import { logger } from '../lib/observability.js';

type WsEvent = APIGatewayProxyWebsocketEventV2 & { requestContext: { authorizer?: Record<string, string> } };

export const connect = async (event: WsEvent) => {
  const a = event.requestContext.authorizer ?? {};
  await putConnection({ connectionId: event.requestContext.connectionId, sub: a.sub, role: a.role, email: a.email || a.username, connectedAt: new Date().toISOString() });
  logger.info('ws connect', { connectionId: event.requestContext.connectionId, sub: a.sub });
  return { statusCode: 200 };
};

export const disconnect = async (event: WsEvent) => {
  await deleteConnection(event.requestContext.connectionId);
  return { statusCode: 200 };
};
