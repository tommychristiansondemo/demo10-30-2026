/** Starts a Bedrock Knowledge Base ingestion job after the documents are (re)deployed. */
import { BedrockAgentClient, StartIngestionJobCommand } from '@aws-sdk/client-bedrock-agent';
import { logger } from '../lib/observability.js';

const client = new BedrockAgentClient({});

export const handler = async () => {
  const res = await client.send(
    new StartIngestionJobCommand({
      knowledgeBaseId: process.env.KNOWLEDGE_BASE_ID!,
      dataSourceId: process.env.DATA_SOURCE_ID!,
      description: `GridSight document sync (${process.env.DOCS_HASH ?? 'manual'})`,
    }),
  );
  logger.info('ingestion started', { jobId: res.ingestionJob?.ingestionJobId, status: res.ingestionJob?.status });
  return { ingestionJobId: res.ingestionJob?.ingestionJobId };
};
