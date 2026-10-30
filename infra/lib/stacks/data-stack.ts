import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as athena from 'aws-cdk-lib/aws-athena';
import * as glue from 'aws-cdk-lib/aws-glue';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import type { EnvironmentConfig } from '../../config/environments';
import { LAKE_PREFIX, LAKE_TABLES, PARTITION_KEY } from '../../../services/src/data/schema.js';
import { DEFAULT_CONFIG } from '../../../services/src/lib/config-schema.js';

export interface DataStackProps extends StackProps {
  config: EnvironmentConfig;
}

/** Persistence: DynamoDB hot store + S3/Parquet lake with Glue catalog and Athena workgroup. */
export class DataStack extends Stack {
  readonly metricsTable: dynamodb.Table;
  readonly alertsTable: dynamodb.Table;
  readonly auditTable: dynamodb.Table;
  readonly sessionsTable: dynamodb.Table;
  readonly connectionsTable: dynamodb.Table;
  readonly lakeBucket: s3.Bucket;
  readonly athenaResultsBucket: s3.Bucket;
  readonly glueDatabaseName: string;
  readonly workgroupName: string;
  readonly configParameter: ssm.StringParameter;
  readonly vpc?: ec2.Vpc;
  readonly lambdaSecurityGroup?: ec2.SecurityGroup;
  private pinnedAzs: string[] = [];

  /** Use the configured AZs instead of an EC2 context lookup during synth. */
  override get availabilityZones(): string[] {
    return this.pinnedAzs.length ? this.pinnedAzs : super.availabilityZones;
  }

  constructor(scope: Construct, id: string, props: DataStackProps) {
    super(scope, id, props);
    const { config } = props;
    this.pinnedAzs = config.network.azs;
    const removalPolicy = config.retainData ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY;
    const prefix = `gridsight-${config.envName}`;

    // ---- Network (prod): private subnets with NAT egress + free gateway endpoints ------------
    if (config.network.mode === 'private') {
      this.vpc = new ec2.Vpc(this, 'Vpc', {
        availabilityZones: config.network.azs,
        natGateways: config.network.natGateways,
        subnetConfiguration: [
          { name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
          { name: 'compute', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 22 },
        ],
        gatewayEndpoints: {
          S3: { service: ec2.GatewayVpcEndpointAwsService.S3 },
          DynamoDB: { service: ec2.GatewayVpcEndpointAwsService.DYNAMODB },
        },
      });
      this.vpc.addFlowLog('FlowLogs', { trafficType: ec2.FlowLogTrafficType.REJECT });
      this.lambdaSecurityGroup = new ec2.SecurityGroup(this, 'LambdaSg', {
        vpc: this.vpc,
        description: 'GridSight Lambda functions (egress only)',
        allowAllOutbound: true,
      });
    }

    // ---- DynamoDB ------------------------------------------------------------------------
    const tableDefaults = {
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: config.retainData },
      deletionProtection: config.retainData,
      removalPolicy,
    };

    this.metricsTable = new dynamodb.Table(this, 'Metrics', {
      ...tableDefaults,
      partitionKey: { name: 'series', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'ts', type: dynamodb.AttributeType.STRING },
      timeToLiveAttribute: 'ttl',
    });

    this.alertsTable = new dynamodb.Table(this, 'Alerts', {
      ...tableDefaults,
      partitionKey: { name: 'id', type: dynamodb.AttributeType.STRING },
      timeToLiveAttribute: 'ttl',
    });
    this.alertsTable.addGlobalSecondaryIndex({
      indexName: 'byStatus',
      partitionKey: { name: 'status', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'ts', type: dynamodb.AttributeType.STRING },
    });

    this.auditTable = new dynamodb.Table(this, 'Audit', {
      ...tableDefaults,
      partitionKey: { name: 'day', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      timeToLiveAttribute: 'ttl',
      // Audit records must survive stack deletion in every environment.
      removalPolicy: RemovalPolicy.RETAIN,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    });
    this.auditTable.addGlobalSecondaryIndex({
      indexName: 'byActor',
      partitionKey: { name: 'actor', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'ts', type: dynamodb.AttributeType.STRING },
    });

    this.sessionsTable = new dynamodb.Table(this, 'Sessions', {
      ...tableDefaults,
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      timeToLiveAttribute: 'ttl',
    });

    this.connectionsTable = new dynamodb.Table(this, 'Connections', {
      ...tableDefaults,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: false },
      deletionProtection: false,
      removalPolicy: RemovalPolicy.DESTROY,
      partitionKey: { name: 'connectionId', type: dynamodb.AttributeType.STRING },
      timeToLiveAttribute: 'ttl',
    });

    // ---- S3 data lake --------------------------------------------------------------------
    const bucketDefaults = {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy,
      autoDeleteObjects: !config.retainData,
    };
    this.lakeBucket = new s3.Bucket(this, 'Lake', {
      ...bucketDefaults,
      versioned: config.retainData,
      lifecycleRules: [
        { id: 'tier-old-partitions', prefix: `${LAKE_PREFIX}/`, transitions: [{ storageClass: s3.StorageClass.INTELLIGENT_TIERING, transitionAfter: Duration.days(30) }] },
        { id: 'expire-noncurrent', noncurrentVersionExpiration: Duration.days(30) },
      ],
    });
    this.athenaResultsBucket = new s3.Bucket(this, 'AthenaResults', {
      ...bucketDefaults,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      lifecycleRules: [{ id: 'expire-results', expiration: Duration.days(7) }],
    });

    // ---- Glue catalog (partition projection: no crawlers, no MSCK REPAIR) ------------------
    this.glueDatabaseName = `gridsight_${config.envName}`;
    const db = new glue.CfnDatabase(this, 'GlueDb', {
      catalogId: this.account,
      databaseInput: { name: this.glueDatabaseName, description: 'GridSight synthetic ERCOT-style grid data lake' },
    });
    for (const t of LAKE_TABLES) {
      const location = `s3://${this.lakeBucket.bucketName}/${LAKE_PREFIX}/${t.name}/`;
      const table = new glue.CfnTable(this, `Table-${t.name}`, {
        catalogId: this.account,
        databaseName: this.glueDatabaseName,
        tableInput: {
          name: t.name,
          description: t.description,
          tableType: 'EXTERNAL_TABLE',
          parameters: {
            classification: 'parquet',
            'projection.enabled': 'true',
            'projection.dt.type': 'date',
            'projection.dt.format': 'yyyy-MM-dd',
            'projection.dt.range': '2024-01-01,NOW',
            'projection.dt.interval': '1',
            'projection.dt.interval.unit': 'DAYS',
            'storage.location.template': `${location}dt=\${dt}`,
          },
          partitionKeys: [{ name: PARTITION_KEY.name, type: PARTITION_KEY.type, comment: PARTITION_KEY.description }],
          storageDescriptor: {
            location,
            inputFormat: 'org.apache.hadoop.hive.ql.io.parquet.MapredParquetInputFormat',
            outputFormat: 'org.apache.hadoop.hive.ql.io.parquet.MapredParquetOutputFormat',
            serdeInfo: { serializationLibrary: 'org.apache.hadoop.hive.ql.io.parquet.serde.ParquetHiveSerDe' },
            columns: t.columns.map((c) => ({ name: c.name, type: c.type, comment: c.description })),
          },
        },
      });
      table.node.addDependency(db);
    }

    // ---- Athena workgroup with a per-query scan limit -----------------------------------------
    this.workgroupName = prefix;
    new athena.CfnWorkGroup(this, 'Workgroup', {
      name: this.workgroupName,
      description: 'GridSight queries (API, NL→SQL, AI agent)',
      recursiveDeleteOption: true,
      state: 'ENABLED',
      workGroupConfiguration: {
        enforceWorkGroupConfiguration: true,
        publishCloudWatchMetricsEnabled: true,
        bytesScannedCutoffPerQuery: config.data.athenaScanLimitBytes,
        engineVersion: { selectedEngineVersion: 'Athena engine version 3' },
        resultConfiguration: {
          outputLocation: `s3://${this.athenaResultsBucket.bucketName}/athena/`,
          encryptionConfiguration: { encryptionOption: 'SSE_S3' },
        },
      },
    });

    // ---- Runtime config / feature flags (versioned by SSM) -----------------------------------
    this.configParameter = new ssm.StringParameter(this, 'AppConfig', {
      parameterName: `/gridsight/${config.envName}/app-config`,
      description: 'GridSight feature flags, model selection and detector thresholds (edit via Admin page)',
      stringValue: JSON.stringify(DEFAULT_CONFIG, null, 2),
      tier: ssm.ParameterTier.STANDARD,
    });

    new CfnOutput(this, 'LakeBucketName', { value: this.lakeBucket.bucketName });
    new CfnOutput(this, 'GlueDatabase', { value: this.glueDatabaseName });
    new CfnOutput(this, 'AthenaWorkgroup', { value: this.workgroupName });
    new CfnOutput(this, 'ConfigParameterName', { value: this.configParameter.parameterName });
  }
}
