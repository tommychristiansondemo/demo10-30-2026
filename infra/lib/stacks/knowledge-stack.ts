import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import * as bedrock from 'aws-cdk-lib/aws-bedrock';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as s3vectors from 'aws-cdk-lib/aws-s3vectors';
import * as triggers from 'aws-cdk-lib/triggers';
import { Construct } from 'constructs';
import type { EnvironmentConfig } from '../../config/environments';
import { REPO_ROOT, ServiceFunction } from '../constructs/service-function';

export interface KnowledgeStackProps extends StackProps {
  config: EnvironmentConfig;
}

const EMBEDDING_MODEL = 'amazon.titan-embed-text-v2:0';
const EMBEDDING_DIMENSIONS = 1024;

/**
 * RAG: Bedrock Knowledge Base over the synthetic operational documents in /knowledge, stored in
 * Amazon S3 Vectors (pay-per-use, no always-on cluster; see ADR-0002).
 */
export class KnowledgeStack extends Stack {
  readonly knowledgeBaseId: string;
  readonly knowledgeBaseArn: string;

  constructor(scope: Construct, id: string, props: KnowledgeStackProps) {
    super(scope, id, props);
    const { config } = props;
    const removalPolicy = config.retainData ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY;
    const docsDir = path.join(REPO_ROOT, 'knowledge');

    const docsBucket = new s3.Bucket(this, 'Docs', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: true,
      removalPolicy,
      autoDeleteObjects: !config.retainData,
    });
    const docsDeployment = new s3deploy.BucketDeployment(this, 'DeployDocs', {
      sources: [s3deploy.Source.asset(docsDir)],
      destinationBucket: docsBucket,
      destinationKeyPrefix: 'docs/',
      prune: true,
      memoryLimit: 512,
    });

    const vectorBucket = new s3vectors.CfnVectorBucket(this, 'VectorBucket', {
      vectorBucketName: `gridsight-${config.envName}-kb-${this.account}`,
    });
    const index = new s3vectors.CfnIndex(this, 'VectorIndex', {
      vectorBucketArn: vectorBucket.attrVectorBucketArn,
      indexName: 'gridsight-docs',
      dataType: 'float32',
      dimension: EMBEDDING_DIMENSIONS,
      distanceMetric: 'cosine',
      // Bedrock stores chunk text and metadata as non-filterable keys (S3 Vectors metadata limits).
      metadataConfiguration: { nonFilterableMetadataKeys: ['AMAZON_BEDROCK_TEXT', 'AMAZON_BEDROCK_METADATA'] },
    });
    vectorBucket.applyRemovalPolicy(removalPolicy);
    index.applyRemovalPolicy(removalPolicy);

    const embeddingModelArn = `arn:aws:bedrock:${this.region}::foundation-model/${EMBEDDING_MODEL}`;
    const kbRole = new iam.Role(this, 'KnowledgeBaseRole', {
      assumedBy: new iam.ServicePrincipal('bedrock.amazonaws.com', {
        conditions: {
          StringEquals: { 'aws:SourceAccount': this.account },
          ArnLike: { 'aws:SourceArn': `arn:aws:bedrock:${this.region}:${this.account}:knowledge-base/*` },
        },
      }),
      description: 'Bedrock Knowledge Base service role for GridSight',
    });
    const kbPolicy = new iam.Policy(this, 'KnowledgeBasePolicy', {
      roles: [kbRole],
      statements: [
        new iam.PolicyStatement({ actions: ['bedrock:InvokeModel'], resources: [embeddingModelArn] }),
        new iam.PolicyStatement({ actions: ['s3:GetObject'], resources: [docsBucket.arnForObjects('docs/*')] }),
        new iam.PolicyStatement({ actions: ['s3:ListBucket'], resources: [docsBucket.bucketArn] }),
        new iam.PolicyStatement({
          actions: ['s3vectors:PutVectors', 's3vectors:GetVectors', 's3vectors:DeleteVectors', 's3vectors:QueryVectors', 's3vectors:GetIndex'],
          resources: [index.attrIndexArn],
        }),
      ],
    });

    const kb = new bedrock.CfnKnowledgeBase(this, 'KnowledgeBase', {
      name: `gridsight-${config.envName}`,
      description: 'GridSight synthetic ERCOT operations knowledge: glossary, procedures, runbooks, incident reviews',
      roleArn: kbRole.roleArn,
      knowledgeBaseConfiguration: {
        type: 'VECTOR',
        vectorKnowledgeBaseConfiguration: {
          embeddingModelArn,
          embeddingModelConfiguration: { bedrockEmbeddingModelConfiguration: { dimensions: EMBEDDING_DIMENSIONS, embeddingDataType: 'FLOAT32' } },
        },
      },
      storageConfiguration: {
        type: 'S3_VECTORS',
        s3VectorsConfiguration: { indexArn: index.attrIndexArn },
      },
    });
    kb.node.addDependency(kbPolicy);

    const dataSource = new bedrock.CfnDataSource(this, 'DocsSource', {
      knowledgeBaseId: kb.attrKnowledgeBaseId,
      name: 'operational-docs',
      dataDeletionPolicy: 'DELETE',
      dataSourceConfiguration: {
        type: 'S3',
        s3Configuration: { bucketArn: docsBucket.bucketArn, inclusionPrefixes: ['docs/'] },
      },
      vectorIngestionConfiguration: {
        chunkingConfiguration: {
          chunkingStrategy: 'FIXED_SIZE',
          fixedSizeChunkingConfiguration: { maxTokens: 400, overlapPercentage: 15 },
        },
      },
    });

    // Re-run ingestion whenever the documents change.
    const docsHash = crypto.createHash('sha256');
    for (const f of fs.readdirSync(docsDir).sort()) docsHash.update(f).update(fs.readFileSync(path.join(docsDir, f)));
    const syncFn = new ServiceFunction(this, 'KbSync', {
      entry: 'kb-sync.ts',
      description: 'Start Bedrock Knowledge Base ingestion after document deployment',
      timeout: Duration.minutes(1),
      logRetentionDays: config.observability.logRetentionDays,
      removalPolicy: RemovalPolicy.DESTROY,
      environment: { KNOWLEDGE_BASE_ID: kb.attrKnowledgeBaseId, DATA_SOURCE_ID: dataSource.attrDataSourceId, DOCS_HASH: docsHash.digest('hex').slice(0, 16) },
    });
    syncFn.addToRolePolicy(new iam.PolicyStatement({ actions: ['bedrock:StartIngestionJob'], resources: [kb.attrKnowledgeBaseArn] }));
    new triggers.Trigger(this, 'KbSyncTrigger', { handler: syncFn, executeAfter: [docsDeployment, dataSource], timeout: Duration.minutes(1) });

    this.knowledgeBaseId = kb.attrKnowledgeBaseId;
    this.knowledgeBaseArn = kb.attrKnowledgeBaseArn;
    new CfnOutput(this, 'KnowledgeBaseId', { value: kb.attrKnowledgeBaseId });
    new CfnOutput(this, 'DocsBucketName', { value: docsBucket.bucketName });
  }
}
