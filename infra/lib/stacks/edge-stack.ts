import * as fs from 'node:fs';
import * as path from 'node:path';
import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as r53targets from 'aws-cdk-lib/aws-route53-targets';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import type * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import { Construct } from 'constructs';
import type { EnvironmentConfig } from '../../config/environments';
import { REPO_ROOT } from '../constructs/service-function';

export interface EdgeStackProps extends StackProps {
  config: EnvironmentConfig;
  httpApiId: string;
  wsApiId: string;
  wsDirectUrl: string;
  originSecret: secretsmanager.ISecret;
  runtimeConfig: Record<string, unknown>;
}

const ORIGIN_HEADER = 'x-gridsight-origin-verify';

/**
 * Public edge: ACM certificate, WAF, two CloudFront distributions, Route 53 records and the SPA.
 *   https://<appHost>       → S3 (SPA), /api/* → HTTP API (prefix stripped), /ws → WebSocket API
 *   https://<apiHost>       → HTTP API (developer endpoint), /ws → WebSocket API
 * API Gateway HTTP APIs can't attach WAF directly, so all API traffic enters through CloudFront.
 */
export class EdgeStack extends Stack {
  readonly webDistribution: cloudfront.Distribution;
  readonly apiDistribution: cloudfront.Distribution;
  readonly webAclName: string;

  constructor(scope: Construct, id: string, props: EdgeStackProps) {
    super(scope, id, props);
    const { config } = props;
    const { appHost, apiHost, zoneName, hostedZoneId } = config.domain;

    const zone = hostedZoneId
      ? route53.HostedZone.fromHostedZoneAttributes(this, 'Zone', { hostedZoneId, zoneName })
      : route53.HostedZone.fromLookup(this, 'Zone', { domainName: zoneName });

    const certificate = new acm.Certificate(this, 'Certificate', {
      domainName: appHost,
      subjectAlternativeNames: [apiHost],
      validation: acm.CertificateValidation.fromDns(zone),
    });

    // ---- WAF ---------------------------------------------------------------------------------
    this.webAclName = `gridsight-${config.envName}`;
    const managed = (priority: number, name: string, overrides: string[] = []): wafv2.CfnWebACL.RuleProperty => ({
      name,
      priority,
      overrideAction: { none: {} },
      statement: {
        managedRuleGroupStatement: {
          vendorName: 'AWS',
          name,
          ruleActionOverrides: overrides.map((o) => ({ name: o, actionToUse: { count: {} } })),
        },
      },
      visibilityConfig: { sampledRequestsEnabled: true, cloudWatchMetricsEnabled: true, metricName: name },
    });
    const webAcl = new wafv2.CfnWebACL(this, 'WebAcl', {
      name: this.webAclName,
      scope: 'CLOUDFRONT',
      defaultAction: { allow: {} },
      visibilityConfig: { sampledRequestsEnabled: true, cloudWatchMetricsEnabled: true, metricName: this.webAclName },
      rules: [
        managed(0, 'AWSManagedRulesAmazonIpReputationList'),
        // Chat prompts and SQL bodies can exceed the default 8 KB body inspection size.
        managed(1, 'AWSManagedRulesCommonRuleSet', ['SizeRestrictions_BODY']),
        managed(2, 'AWSManagedRulesKnownBadInputsRuleSet'),
        {
          name: 'RateLimitPerIp',
          priority: 3,
          action: { block: {} },
          statement: { rateBasedStatement: { limit: config.waf.rateLimitPer5Min, aggregateKeyType: 'IP' } },
          visibilityConfig: { sampledRequestsEnabled: true, cloudWatchMetricsEnabled: true, metricName: 'RateLimitPerIp' },
        },
        {
          name: 'RateLimitAiPerIp',
          priority: 4,
          action: { block: {} },
          statement: {
            rateBasedStatement: {
              limit: config.waf.aiRateLimitPer5Min,
              aggregateKeyType: 'IP',
              scopeDownStatement: {
                byteMatchStatement: {
                  fieldToMatch: { uriPath: {} },
                  positionalConstraint: 'CONTAINS',
                  searchString: '/v1/ai/',
                  textTransformations: [{ priority: 0, type: 'LOWERCASE' }],
                },
              },
            },
          },
          visibilityConfig: { sampledRequestsEnabled: true, cloudWatchMetricsEnabled: true, metricName: 'RateLimitAiPerIp' },
        },
      ],
    });
    const wafLogs = new logs.LogGroup(this, 'WafLogs', {
      logGroupName: `aws-waf-logs-gridsight-${config.envName}`,
      retention: config.observability.logRetentionDays as logs.RetentionDays,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    new wafv2.CfnLoggingConfiguration(this, 'WafLogging', {
      resourceArn: webAcl.attrArn,
      logDestinationConfigs: [wafLogs.logGroupArn],
      redactedFields: [{ singleHeader: { Name: 'authorization' } }, { queryString: {} }],
    });

    // ---- Origins & policies -------------------------------------------------------------------
    const originHeaders = { [ORIGIN_HEADER]: props.originSecret.secretValue.unsafeUnwrap() };
    const httpOrigin = new origins.HttpOrigin(`${props.httpApiId}.execute-api.${this.region}.amazonaws.com`, {
      protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
      customHeaders: originHeaders,
      readTimeout: Duration.seconds(30),
    });
    const wsOrigin = new origins.HttpOrigin(`${props.wsApiId}.execute-api.${this.region}.amazonaws.com`, {
      protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
      customHeaders: originHeaders,
    });

    const securityHeaders = new cloudfront.ResponseHeadersPolicy(this, 'SecurityHeaders', {
      responseHeadersPolicyName: `gridsight-${config.envName}-security`,
      securityHeadersBehavior: {
        strictTransportSecurity: { accessControlMaxAge: Duration.days(365), includeSubdomains: true, preload: false, override: true },
        contentTypeOptions: { override: true },
        frameOptions: { frameOption: cloudfront.HeadersFrameOption.DENY, override: true },
        referrerPolicy: { referrerPolicy: cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN, override: true },
        xssProtection: { protection: true, modeBlock: true, override: true },
        contentSecurityPolicy: {
          override: true,
          contentSecurityPolicy: [
            "default-src 'self'",
            "script-src 'self'",
            "style-src 'self' 'unsafe-inline'",
            "img-src 'self' data: blob:",
            "font-src 'self' data:",
            `connect-src 'self' wss://${appHost} https://${apiHost} wss://${apiHost} https://cognito-idp.${this.region}.amazonaws.com https://cognito-identity.${this.region}.amazonaws.com https://*.auth.${this.region}.amazoncognito.com wss://*.execute-api.${this.region}.amazonaws.com`,
            "frame-ancestors 'none'",
            "base-uri 'self'",
            `form-action 'self' https://*.auth.${this.region}.amazoncognito.com`,
          ].join('; '),
        },
      },
    });

    const stripApiPrefix = new cloudfront.Function(this, 'StripApiPrefix', {
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      comment: 'Map /api/v1/... on the app domain to /v1/... on the HTTP API',
      code: cloudfront.FunctionCode.fromInline(
        "function handler(event) { var r = event.request; r.uri = r.uri.replace(/^\\/api/, '') || '/'; return r; }",
      ),
    });
    const spaRouting = new cloudfront.Function(this, 'SpaRouting', {
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      comment: 'Serve index.html for client-side routes (paths without a file extension)',
      code: cloudfront.FunctionCode.fromInline(
        "function handler(event) { var r = event.request; if (r.uri.indexOf('.') === -1) { r.uri = '/index.html'; } return r; }",
      ),
    });

    // CloudFront forwards Authorization on GET/HEAD only when it is part of the cache key, so the API
    // behaviors use a zero-TTL policy keyed on it (API responses also send Cache-Control: no-store).
    const apiCachePolicy = new cloudfront.CachePolicy(this, 'ApiCachePolicy', {
      cachePolicyName: `gridsight-${config.envName}-api`,
      comment: 'Forward Authorization; effectively no caching',
      minTtl: Duration.seconds(0),
      defaultTtl: Duration.seconds(0),
      maxTtl: Duration.seconds(1),
      headerBehavior: cloudfront.CacheHeaderBehavior.allowList('Authorization'),
      queryStringBehavior: cloudfront.CacheQueryStringBehavior.all(),
      cookieBehavior: cloudfront.CacheCookieBehavior.none(),
    });
    const apiOriginRequestPolicy = new cloudfront.OriginRequestPolicy(this, 'ApiOriginRequestPolicy', {
      originRequestPolicyName: `gridsight-${config.envName}-api`,
      headerBehavior: cloudfront.OriginRequestHeaderBehavior.allowList('content-type', 'accept', 'user-agent', 'x-request-id'),
      queryStringBehavior: cloudfront.OriginRequestQueryStringBehavior.all(),
      cookieBehavior: cloudfront.OriginRequestCookieBehavior.none(),
    });

    const apiBehavior: cloudfront.BehaviorOptions = {
      origin: httpOrigin,
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
      allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
      cachePolicy: apiCachePolicy,
      originRequestPolicy: apiOriginRequestPolicy,
      responseHeadersPolicy: securityHeaders,
    };
    const wsBehavior: cloudfront.BehaviorOptions = {
      origin: wsOrigin,
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
      allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
      cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
      originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
    };

    // ---- SPA bucket & distribution ----------------------------------------------------------------
    const siteBucket = new s3.Bucket(this, 'Site', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });
    const logBucket = config.retainData
      ? new s3.Bucket(this, 'CdnLogs', {
          blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
          encryption: s3.BucketEncryption.S3_MANAGED,
          enforceSSL: true,
          objectOwnership: s3.ObjectOwnership.OBJECT_WRITER,
          lifecycleRules: [{ expiration: Duration.days(90) }],
          removalPolicy: RemovalPolicy.RETAIN,
        })
      : undefined;

    this.webDistribution = new cloudfront.Distribution(this, 'WebDistribution', {
      comment: `GridSight ${config.envName} web app`,
      domainNames: [appHost],
      certificate,
      webAclId: webAcl.attrArn,
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      defaultRootObject: 'index.html',
      enableLogging: !!logBucket,
      logBucket,
      logFilePrefix: 'web/',
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(siteBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy: securityHeaders,
        functionAssociations: [{ function: spaRouting, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST }],
      },
      additionalBehaviors: {
        '/api/*': { ...apiBehavior, functionAssociations: [{ function: stripApiPrefix, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST }] },
        '/ws': wsBehavior,
      },
    });

    this.apiDistribution = new cloudfront.Distribution(this, 'ApiDistribution', {
      comment: `GridSight ${config.envName} developer API`,
      domainNames: [apiHost],
      certificate,
      webAclId: webAcl.attrArn,
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      enableLogging: !!logBucket,
      logBucket,
      logFilePrefix: 'api/',
      defaultBehavior: apiBehavior,
      additionalBehaviors: { '/ws': wsBehavior },
    });

    for (const [host, dist, idSuffix] of [
      [appHost, this.webDistribution, 'App'],
      [apiHost, this.apiDistribution, 'Api'],
    ] as const) {
      const target = route53.RecordTarget.fromAlias(new r53targets.CloudFrontTarget(dist));
      new route53.ARecord(this, `${idSuffix}A`, { zone, recordName: host, target });
      new route53.AaaaRecord(this, `${idSuffix}Aaaa`, { zone, recordName: host, target });
    }

    // ---- Deploy the SPA + runtime config ------------------------------------------------------------
    const dist = path.join(REPO_ROOT, 'web/dist');
    if (!fs.existsSync(path.join(dist, 'index.html'))) {
      throw new Error('web/dist not found. Build the frontend first: npm run build -w web');
    }
    const assets = new s3deploy.BucketDeployment(this, 'DeployAssets', {
      sources: [s3deploy.Source.asset(dist, { exclude: ['index.html', 'config.json', 'openapi.yaml'] })],
      destinationBucket: siteBucket,
      cacheControl: [s3deploy.CacheControl.fromString('public, max-age=31536000, immutable')],
      prune: false,
      memoryLimit: 1024,
    });
    const shell = new s3deploy.BucketDeployment(this, 'DeployShell', {
      sources: [
        s3deploy.Source.asset(dist, { exclude: ['*', '!index.html', '!openapi.yaml'] }),
        s3deploy.Source.jsonData('config.json', {
          ...props.runtimeConfig,
          wsUrl: `wss://${appHost}/ws`,
          wsUrlDirect: props.wsDirectUrl,
          publicApiUrl: `https://${apiHost}`,
          appUrl: `https://${appHost}`,
        }),
      ],
      destinationBucket: siteBucket,
      cacheControl: [s3deploy.CacheControl.fromString('no-cache, must-revalidate')],
      prune: false,
      distribution: this.webDistribution,
      distributionPaths: ['/index.html', '/config.json', '/openapi.yaml', '/'],
    });
    shell.node.addDependency(assets);

    new CfnOutput(this, 'AppUrl', { value: `https://${appHost}` });
    new CfnOutput(this, 'ApiUrl', { value: `https://${apiHost}` });
    new CfnOutput(this, 'WebSocketUrl', { value: `wss://${apiHost}/ws` });
    new CfnOutput(this, 'WebDistributionId', { value: this.webDistribution.distributionId });
  }
}
