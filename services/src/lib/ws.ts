/** Push messages to WebSocket clients through the API Gateway management API. */
import { ApiGatewayManagementApiClient, GoneException, PostToConnectionCommand } from '@aws-sdk/client-apigatewaymanagementapi';
import { env } from './env.js';
import { allConnections, deleteConnection } from './repo.js';
import { logger } from './observability.js';

let client: ApiGatewayManagementApiClient | undefined;
function mgmt(): ApiGatewayManagementApiClient {
  client ??= new ApiGatewayManagementApiClient({ endpoint: env.wsManagementEndpoint });
  return client;
}

/** Returns false if the connection is gone (and removes it). */
export async function postToConnection(connectionId: string, payload: unknown): Promise<boolean> {
  try {
    await mgmt().send(new PostToConnectionCommand({ ConnectionId: connectionId, Data: Buffer.from(JSON.stringify(payload)) }));
    return true;
  } catch (err) {
    if (err instanceof GoneException || (err as any)?.$metadata?.httpStatusCode === 410) {
      await deleteConnection(connectionId);
      return false;
    }
    throw err;
  }
}

/** Fan out to every connected client. Fine for hundreds of clients; see ADR-0006 for scaling options. */
export async function broadcast(payload: unknown): Promise<number> {
  if (!env.wsManagementEndpoint) return 0;
  const conns = await allConnections();
  const results = await Promise.allSettled(conns.map((c) => postToConnection(c.connectionId, payload)));
  const failed = results.filter((r) => r.status === 'rejected');
  if (failed.length) logger.warn('broadcast failures', { failed: failed.length });
  return results.filter((r) => r.status === 'fulfilled' && r.value).length;
}
