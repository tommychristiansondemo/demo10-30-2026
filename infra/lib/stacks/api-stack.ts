import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import * as apigw from 'aws-cdk-lib/aws-apigateway';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpJwtAuthorizer, WebSocketLambdaAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import { HttpLambdaIntegration, WebSocketLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import type * as cognito from 'aws-cdk-lib/aws-cognito';
import type * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import type * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import type * as s3 from 'aws-cdk-lib/aws-s3';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import type * as ssm from 'aws-cdk-lib/aws-ssm';
import * as triggers from 'aws-cdk-lib/triggers';
import { Construct } from 'constructs';
import type { EnvironmentConfig } from '../../config/environments';
import { ServiceFunction } from '../constructs/service-function';

export interface ApiStackProps extends StackProps {
  config: EnvironmentConfig;
  tables: { metrics: dynamodb.ITable; alerts: dynamodb.ITable; audit: dynamodb.ITable; sessions: dynamodb.ITable; connections: dynamodb.ITable };
  lakeBucket: s3.IBucket;
  athenaResultsBucket: s3.IBucket;
  glueDatabaseName: string;
  workgroupName: string;
  configParameter: ssm.IStringParameter;
  userPool: cognito.IUserPool;
  clientIds: string[];
  knowledgeBaseId: string;
  knowledgeBaseArn: string;
  vpc?: ec2.IVpc;
  securityGroup?: ec2.ISecurityGroup;
}

/** Compute and API layer: HTTP API (REST, JWT), WebSocket API (streaming chat + live updates), schedulers. */
export class ApiStack extends Stack {
  readonly httpApi: apigwv2.HttpApi;
  readonly wsApi: apigwv2.WebSocketApi;
  readonly wsStage: apigwv2.WebSocketStage;
  readonly originSecret: secretsmanager.Secret;
  readonly functions: Record<string, ServiceFunction> = {};
  readonly apiAccessLogs: logs.LogGroup;

  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);
    const { config, tables } = props;
    const name = `gridsight-${config.envName}`;

    this.originSecret = new secretsmanager.Secret(this, 'OriginVerifySecret', {
      description: 'Shared secret CloudFront adds to origin requests; the API rejects requests without it (when enforced)',
      generateSecretString: { passwordLength: 48, excludePunctuation: true },
    });

    const commonEnv: Record<string, string> = {
      GRIDSIGHT_ENV: config.envName,
      METRICS_TABLE: tables.metrics.tableName,
      ALERTS_TABLE: tables.alerts.tableName,
      AUDIT_TABLE: tables.audit.tableName,
      SESSIONS_TABLE: tables.sessions.tableName,
      CONNECTIONS_TABLE: tables.connections.tableName,
      LAKE_BUCKET: props.lakeBucket.bucketName,
      GLUE_DATABASE: props.glueDatabaseName,
      ATHENA_WORKGROUP: props.workgroupName,
      CONFIG_PARAMETER: props.configParameter.parameterName,
      KNOWLEDGE_BASE_ID: props.knowledgeBaseId,
      USER_POOL_ID: props.userPool.userPoolId,
      USER_POOL_CLIENT_IDS: props.clientIds.join(','),
      ORIGIN_VERIFY_SECRET_ARN: this.originSecret.secretArn,
      ENFORCE_ORIGIN_VERIFY: String(config.api.enforceOriginVerify),
      DATA_SEED: config.data.seed,
      HOT_DAYS: String(config.data.hotDays),
    };
    const fn = (id: string, p: { entry: string; handler?: string; memorySize?: number; timeout?: Duration; description: string; env?: Record<string, string> }) => {
      const f = new ServiceFunction(this, id, {
        ...p,
        environment: { ...commonEnv, ...p.env },
        logRetentionDays: config.observability.logRetentionDays,
        removalPolicy: config.retainData ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
        vpc: props.vpc,
        securityGroup: props.securityGroup,
      });
      this.functions[id] = f;
      return f;
    };

    const api = fn('Api', { entry: 'api.ts', memorySize: 1024, description: 'GridSight REST API' });
    const chatWorker = fn('ChatWorker', { entry: 'chat-worker.ts', memorySize: 1024, timeout: Duration.minutes(5), description: 'Streams AI agent turns over WebSocket' });
    const generator = fn('Generator', { entry: 'generator.ts', memorySize: 1024, timeout: Duration.minutes(2), description: 'Synthetic 5-minute grid data, rollups, lake files, anomaly detection' });
    const backfill = fn('Backfill', { entry: 'backfill.ts', memorySize: 3008, timeout: Duration.minutes(14), description: 'Deploy-time data seeding', env: { BACKFILL_DAYS: String(config.data.backfillDays) } });
    const wsAuthorizer = fn('WsAuthorizer', { entry: 'ws-authorizer.ts', memorySize: 256, description: 'Verifies Cognito access tokens on WebSocket connect' });
    const wsConnect = fn('WsConnect', { entry: 'ws-connection.ts', handler: 'connect', memorySize: 256, description: 'WebSocket $connect' });
    const wsDisconnect = fn('WsDisconnect', { entry: 'ws-connection.ts', handler: 'disconnect', memorySize: 256, description: 'WebSocket $disconnect' });
    const wsMessage = fn('WsMessage', { entry: 'ws-message.ts', memorySize: 256, description: 'WebSocket chat/ping routes' });

    // ---- HTTP API ------------------------------------------------------------------------
    this.httpApi = new apigwv2.HttpApi(this, 'HttpApi', {
      apiName: name,
      description: 'GridSight REST API (JWT-authorized). Public entry point is CloudFront + WAF.',
      createDefaultStage: false,
      corsPreflight: {
        allowOrigins: [`https://${config.domain.appHost}`, 'http://localhost:5173'],
        allowHeaders: ['authorization', 'content-type'],
        allowMethods: [apigwv2.CorsHttpMethod.GET, apigwv2.CorsHttpMethod.POST, apigwv2.CorsHttpMethod.PUT, apigwv2.CorsHttpMethod.OPTIONS],
        maxAge: Duration.hours(1),
      },
    });
    this.apiAccessLogs = new logs.LogGroup(this, 'HttpApiAccessLogs', {
      retention: config.observability.logRetentionDays as logs.RetentionDays,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    new apigwv2.HttpStage(this, 'HttpDefaultStage', {
      httpApi: this.httpApi,
      stageName: '$default',
      autoDeploy: true,
      throttle: { rateLimit: config.api.throttleRate, burstLimit: config.api.throttleBurst },
      accessLogSettings: {
        destination: new apigwv2.LogGroupLogDestination(this.apiAccessLogs),
        format: apigw.AccessLogFormat.custom(
          JSON.stringify({
            requestId: '$context.requestId',
            ip: '$context.identity.sourceIp',
            method: '$context.httpMethod',
            path: '$context.path',
            status: '$context.status',
            latencyMs: '$context.responseLatency',
            integrationLatencyMs: '$context.integrationLatency',
            user: '$context.authorizer.claims.sub',
            authError: '$context.authorizer.error',
            userAgent: '$context.identity.userAgent',
          }),
        ),
      },
    });
    const jwt = new HttpJwtAuthorizer('Cognito', `https://cognito-idp.${this.region}.amazonaws.com/${props.userPool.userPoolId}`, {
      jwtAudience: props.clientIds,
      identitySource: ['$request.header.Authorization'],
    });
    const apiIntegration = new HttpLambdaIntegration('ApiIntegration', api);
    this.httpApi.addRoutes({ path: '/v1/health', methods: [apigwv2.HttpMethod.GET], integration: apiIntegration });
    this.httpApi.addRoutes({
      path: '/v1/{proxy+}',
      methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.POST, apigwv2.HttpMethod.PUT, apigwv2.HttpMethod.DELETE],
      integration: apiIntegration,
      authorizer: jwt,
    });

    // ---- WebSocket API -----------------------------------------------------------------------
    this.wsApi = new apigwv2.WebSocketApi(this, 'WsApi', {
      apiName: `${name}-ws`,
      description: 'GridSight streaming AI chat and live grid/alert updates',
      routeSelectionExpression: '$request.body.action',
      connectRouteOptions: {
        integration: new WebSocketLambdaIntegration('ConnectIntegration', wsConnect),
        authorizer: new WebSocketLambdaAuthorizer('WsAuth', wsAuthorizer, { identitySource: ['route.request.querystring.token'] }),
      },
      disconnectRouteOptions: { integration: new WebSocketLambdaIntegration('DisconnectIntegration', wsDisconnect) },
      defaultRouteOptions: { integration: new WebSocketLambdaIntegration('DefaultIntegration', wsMessage) },
    });
    this.wsApi.addRoute('chat', { integration: new WebSocketLambdaIntegration('ChatIntegration', wsMessage) });
    this.wsApi.addRoute('ping', { integration: new WebSocketLambdaIntegration('PingIntegration', wsMessage) });
    // Stage is named "ws" so CloudFront can route the /ws path straight to it.
    this.wsStage = new apigwv2.WebSocketStage(this, 'WsStage', {
      webSocketApi: this.wsApi,
      stageName: 'ws',
      autoDeploy: true,
      throttle: { rateLimit: config.api.throttleRate, burstLimit: config.api.throttleBurst },
    });
    const wsEnv = { WS_MANAGEMENT_ENDPOINT: this.wsStage.callbackUrl };
    for (const f of [api, chatWorker, generator, wsMessage]) {
      f.addEnvironment('WS_MANAGEMENT_ENDPOINT', wsEnv.WS_MANAGEMENT_ENDPOINT);
      this.wsApi.grantManageConnections(f);
    }
    wsMessage.addEnvironment('CHAT_WORKER_FUNCTION', chatWorker.functionName);
    chatWorker.grantInvoke(wsMessage);

    // ---- Schedules & seeding --------------------------------------------------------------------
    new events.Rule(this, 'GeneratorSchedule', {
      description: 'Produce a synthetic SCED interval every 5 minutes',
      schedule: events.Schedule.rate(Duration.minutes(5)),
      targets: [new targets.LambdaFunction(generator, { retryAttempts: 1 })],
    });
    new triggers.Trigger(this, 'BackfillTrigger', { handler: backfill, timeout: Duration.minutes(14), executeOnHandlerChange: true });

    // ---- Least-privilege grants ------------------------------------------------------------------
    tables.metrics.grantReadData(api);
    tables.metrics.grantReadData(chatWorker);
    tables.metrics.grantReadWriteData(generator);
    tables.metrics.grantWriteData(backfill);
    tables.alerts.grantReadWriteData(api);
    tables.alerts.grantReadData(chatWorker);
    tables.alerts.grantReadWriteData(generator);
    tables.alerts.grantWriteData(backfill);
    for (const f of [api, chatWorker]) {
      tables.audit.grantReadWriteData(f);
      tables.sessions.grantReadWriteData(f);
    }
    for (const f of [api, chatWorker, generator, wsConnect, wsDisconnect, wsMessage]) tables.connections.grantReadWriteData(f);

    for (const f of [api, chatWorker, generator, backfill]) props.configParameter.grantRead(f);
    props.configParameter.grantWrite(api);
    for (const f of [api, wsAuthorizer]) this.originSecret.grantRead(f);

    // Lake: writers (generator, backfill) and Athena readers (api, chat worker)
    for (const f of [generator, backfill]) {
      f.addToRolePolicy(new iam.PolicyStatement({ actions: ['s3:PutObject', 's3:DeleteObject'], resources: [props.lakeBucket.arnForObjects('curated/*')] }));
      f.addToRolePolicy(new iam.PolicyStatement({ actions: ['s3:ListBucket'], resources: [props.lakeBucket.bucketArn] }));
    }
    const athenaReader = [
      new iam.PolicyStatement({
        actions: ['athena:StartQueryExecution', 'athena:GetQueryExecution', 'athena:GetQueryResults', 'athena:StopQueryExecution', 'athena:GetWorkGroup'],
        resources: [`arn:aws:athena:${this.region}:${this.account}:workgroup/${props.workgroupName}`],
      }),
      new iam.PolicyStatement({
        actions: ['glue:GetDatabase', 'glue:GetTable', 'glue:GetTables', 'glue:GetPartitions'],
        resources: [
          `arn:aws:glue:${this.region}:${this.account}:catalog`,
          `arn:aws:glue:${this.region}:${this.account}:database/${props.glueDatabaseName}`,
          `arn:aws:glue:${this.region}:${this.account}:table/${props.glueDatabaseName}/*`,
        ],
      }),
      new iam.PolicyStatement({ actions: ['s3:GetObject'], resources: [props.lakeBucket.arnForObjects('curated/*')] }),
      new iam.PolicyStatement({ actions: ['s3:ListBucket', 's3:GetBucketLocation'], resources: [props.lakeBucket.bucketArn, props.athenaResultsBucket.bucketArn] }),
      new iam.PolicyStatement({ actions: ['s3:GetObject', 's3:PutObject', 's3:AbortMultipartUpload'], resources: [props.athenaResultsBucket.arnForObjects('athena/*')] }),
    ];
    for (const f of [api, chatWorker]) {
      athenaReader.forEach((s) => f.addToRolePolicy(s));
      // Claude in Amazon Bedrock: Mantle endpoint (Opus 4.7+) and the runtime via cross-region
      // inference profiles (Opus/Sonnet 4.6 and older), which route to foundation models in any US region.
      f.addToRolePolicy(new iam.PolicyStatement({ actions: ['bedrock-mantle:CreateInference'], resources: ['*'] }));
      f.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
          resources: [
            `arn:aws:bedrock:${this.region}:${this.account}:inference-profile/*anthropic.claude-*`,
            'arn:aws:bedrock:*::foundation-model/anthropic.claude-*',
          ],
        }),
      );
      f.addToRolePolicy(new iam.PolicyStatement({ actions: ['bedrock:Retrieve'], resources: [props.knowledgeBaseArn] }));
    }
    api.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['cognito-idp:ListUsers', 'cognito-idp:ListUsersInGroup', 'cognito-idp:AdminListGroupsForUser', 'cognito-idp:AdminAddUserToGroup', 'cognito-idp:AdminRemoveUserFromGroup'],
        resources: [props.userPool.userPoolArn],
      }),
    );

    new CfnOutput(this, 'HttpApiEndpoint', { value: this.httpApi.apiEndpoint, description: 'Direct execute-api endpoint (prefer the CloudFront domain)' });
    new CfnOutput(this, 'WebSocketDirectUrl', { value: this.wsStage.url });
  }
}
