#!/usr/bin/env node
/**
 * GridSight AI CDK app.
 *   npx cdk deploy --all -c env=dev
 *   npx cdk deploy --all -c env=prod -c alarmEmail=oncall@example.com
 */
import { App, Tags } from 'aws-cdk-lib';
import { resolveConfig } from '../config/environments';
import { ApiStack } from '../lib/stacks/api-stack';
import { AuthStack } from '../lib/stacks/auth-stack';
import { DataStack } from '../lib/stacks/data-stack';
import { EdgeStack } from '../lib/stacks/edge-stack';
import { KnowledgeStack } from '../lib/stacks/knowledge-stack';
import { ObservabilityStack } from '../lib/stacks/observability-stack';

const app = new App();
const config = resolveConfig(app.node);
const env = { account: config.account, region: config.region };
const p = `GridSight-${config.envName}`;

const data = new DataStack(app, `${p}-Data`, { env, config, description: 'GridSight AI: data lake, hot store, catalog, config' });

const auth = new AuthStack(app, `${p}-Auth`, {
  env,
  config,
  description: 'GridSight AI: Cognito user pool, role groups, federation, identity pool',
  lakeBucket: data.lakeBucket,
  athenaResultsBucket: data.athenaResultsBucket,
  glueDatabaseName: data.glueDatabaseName,
  workgroupName: data.workgroupName,
});

const knowledge = new KnowledgeStack(app, `${p}-Knowledge`, { env, config, description: 'GridSight AI: Bedrock Knowledge Base (S3 Vectors) for RAG' });

const api = new ApiStack(app, `${p}-Api`, {
  env,
  config,
  description: 'GridSight AI: Lambda, HTTP and WebSocket APIs, schedulers',
  tables: { metrics: data.metricsTable, alerts: data.alertsTable, audit: data.auditTable, sessions: data.sessionsTable, connections: data.connectionsTable },
  lakeBucket: data.lakeBucket,
  athenaResultsBucket: data.athenaResultsBucket,
  glueDatabaseName: data.glueDatabaseName,
  workgroupName: data.workgroupName,
  configParameter: data.configParameter,
  userPool: auth.userPool,
  clientIds: [auth.webClient.userPoolClientId, auth.cliClient.userPoolClientId],
  knowledgeBaseId: knowledge.knowledgeBaseId,
  knowledgeBaseArn: knowledge.knowledgeBaseArn,
  vpc: data.vpc,
  securityGroup: data.lambdaSecurityGroup,
});

const edge = new EdgeStack(app, `${p}-Edge`, {
  env,
  config,
  description: 'GridSight AI: CloudFront, WAF, ACM, Route 53, SPA hosting',
  httpApiId: api.httpApi.apiId,
  wsApiId: api.wsApi.apiId,
  wsDirectUrl: api.wsStage.url,
  originSecret: api.originSecret,
  runtimeConfig: {
    env: config.envName,
    region: config.region,
    userPoolId: auth.userPool.userPoolId,
    userPoolClientId: auth.webClient.userPoolClientId,
    cliClientId: auth.cliClient.userPoolClientId,
    identityPoolId: auth.identityPoolId,
    cognitoDomain: auth.cognitoDomain,
    federatedProviders: auth.federatedProviders,
    apiBaseUrl: '/api',
  },
});

new ObservabilityStack(app, `${p}-Observability`, {
  env,
  config,
  description: 'GridSight AI: CloudWatch dashboard and alarms',
  httpApi: api.httpApi,
  functions: api.functions,
  tables: { metrics: data.metricsTable },
  apiLogGroup: api.apiAccessLogs,
  webDistributionId: edge.webDistribution.distributionId,
  apiDistributionId: edge.apiDistribution.distributionId,
  webAclName: edge.webAclName,
});

Tags.of(app).add('Project', 'GridSight');
Tags.of(app).add('Environment', config.envName);
Tags.of(app).add('ManagedBy', 'CDK');
