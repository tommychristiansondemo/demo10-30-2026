import * as path from 'node:path';
import { Duration, RemovalPolicy } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';

export const REPO_ROOT = path.resolve(__dirname, '../../..');
export const SERVICES_DIR = path.join(REPO_ROOT, 'services');

export interface ServiceFunctionProps {
  /** File under services/src/handlers, e.g. "api.ts" */
  entry: string;
  handler?: string;
  memorySize?: number;
  timeout?: Duration;
  environment?: Record<string, string>;
  logRetentionDays: number;
  vpc?: ec2.IVpc;
  securityGroup?: ec2.ISecurityGroup;
  description?: string;
  removalPolicy: RemovalPolicy;
}

/** Standard GridSight Lambda: Node.js 22 on Graviton, ESM bundle, X-Ray, JSON logs, explicit log group. */
export class ServiceFunction extends NodejsFunction {
  constructor(scope: Construct, id: string, props: ServiceFunctionProps) {
    const logGroup = new logs.LogGroup(scope, `${id}Logs`, {
      retention: props.logRetentionDays as logs.RetentionDays,
      removalPolicy: props.removalPolicy,
    });
    super(scope, id, {
      entry: path.join(SERVICES_DIR, 'src/handlers', props.entry),
      handler: props.handler ?? 'handler',
      description: props.description,
      projectRoot: REPO_ROOT,
      depsLockFilePath: path.join(REPO_ROOT, 'package-lock.json'),
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: props.memorySize ?? 512,
      timeout: props.timeout ?? Duration.seconds(29),
      tracing: lambda.Tracing.ACTIVE,
      loggingFormat: lambda.LoggingFormat.JSON,
      applicationLogLevelV2: lambda.ApplicationLogLevel.INFO,
      logGroup,
      environment: { NODE_OPTIONS: '--enable-source-maps', POWERTOOLS_SERVICE_NAME: 'gridsight', ...props.environment },
      vpc: props.vpc,
      vpcSubnets: props.vpc ? { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS } : undefined,
      securityGroups: props.securityGroup ? [props.securityGroup] : undefined,
      bundling: {
        format: OutputFormat.ESM,
        target: 'node22',
        minify: true,
        sourceMap: true,
        mainFields: ['module', 'main'],
        // Bundle the AWS SDK too, so behavior doesn't depend on the runtime's preinstalled SDK version.
        externalModules: [],
        banner: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
      },
    });
  }
}
