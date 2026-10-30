import { Duration, Stack, type StackProps } from 'aws-cdk-lib';
import type * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cwActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import type * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import type * as lambda from 'aws-cdk-lib/aws-lambda';
import type * as logs from 'aws-cdk-lib/aws-logs';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subs from 'aws-cdk-lib/aws-sns-subscriptions';
import { Construct } from 'constructs';
import type { EnvironmentConfig } from '../../config/environments';

export interface ObservabilityStackProps extends StackProps {
  config: EnvironmentConfig;
  httpApi: apigwv2.IHttpApi;
  functions: Record<string, lambda.IFunction>;
  tables: Record<string, dynamodb.ITable>;
  apiLogGroup: logs.ILogGroup;
  webDistributionId: string;
  apiDistributionId: string;
  webAclName: string;
}

/** CloudWatch dashboard and alarms covering API health, AI usage/cost drivers, the data pipeline and the edge. */
export class ObservabilityStack extends Stack {
  constructor(scope: Construct, id: string, props: ObservabilityStackProps) {
    super(scope, id, props);
    const { config, functions } = props;
    const name = `GridSight-${config.envName}`;

    const topic = new sns.Topic(this, 'AlarmTopic', { displayName: `${name} alarms` });
    if (config.observability.alarmEmail) topic.addSubscription(new subs.EmailSubscription(config.observability.alarmEmail));
    const notify = (a: cloudwatch.Alarm) => {
      a.addAlarmAction(new cwActions.SnsAction(topic));
      a.addOkAction(new cwActions.SnsAction(topic));
      return a;
    };

    const app = (metricName: string, statistic = 'Sum', period = Duration.minutes(5)) =>
      new cloudwatch.Metric({ namespace: 'GridSight', metricName, dimensionsMap: { service: 'gridsight' }, statistic, period });

    // ---- Alarms ------------------------------------------------------------------------------
    const api5xx = props.httpApi.metricServerError({ period: Duration.minutes(5), statistic: 'Sum' });
    const alarms = [
      notify(new cloudwatch.Alarm(this, 'Api5xx', {
        alarmDescription: 'REST API is returning 5xx errors',
        metric: api5xx, threshold: 5, evaluationPeriods: 3, datapointsToAlarm: 2,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      })),
      notify(new cloudwatch.Alarm(this, 'DataPipelineStale', {
        alarmDescription: 'No fresh grid data: the 5-minute generator has not written intervals for 15 minutes',
        metric: app('IntervalsWritten', 'Sum', Duration.minutes(15)), threshold: 1, evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.BREACHING,
      })),
      notify(new cloudwatch.Alarm(this, 'GeneratorErrors', {
        alarmDescription: 'Generator Lambda errors',
        metric: functions.Generator.metricErrors({ period: Duration.minutes(5) }), threshold: 1, evaluationPeriods: 2,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      })),
      notify(new cloudwatch.Alarm(this, 'ChatErrors', {
        alarmDescription: 'AI assistant failures (model, tool or persistence errors)',
        metric: app('ChatErrors', 'Sum', Duration.minutes(15)), threshold: 5, evaluationPeriods: 1,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      })),
      notify(new cloudwatch.Alarm(this, 'ChatTokenSpike', {
        alarmDescription: 'Unusually high AI output token usage in an hour (cost guardrail)',
        metric: app('ChatOutputTokens', 'Sum', Duration.hours(1)), threshold: 2_000_000, evaluationPeriods: 1,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      })),
      notify(new cloudwatch.Alarm(this, 'MetricsThrottles', {
        alarmDescription: 'DynamoDB throttling on the metrics table',
        metric: new cloudwatch.MathExpression({
          expression: 'r + w',
          usingMetrics: {
            r: props.tables.metrics.metric('ReadThrottleEvents', { statistic: 'Sum', period: Duration.minutes(5) }),
            w: props.tables.metrics.metric('WriteThrottleEvents', { statistic: 'Sum', period: Duration.minutes(5) }),
          },
          period: Duration.minutes(5),
        }),
        threshold: 10, evaluationPeriods: 2,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      })),
      notify(new cloudwatch.Alarm(this, 'WafBlockedSpike', {
        alarmDescription: 'WAF is blocking an unusual number of requests (possible attack or misconfigured client)',
        metric: new cloudwatch.Metric({ namespace: 'AWS/WAFV2', metricName: 'BlockedRequests', dimensionsMap: { WebACL: props.webAclName, Rule: 'ALL' }, statistic: 'Sum', period: Duration.minutes(5) }),
        threshold: 1000, evaluationPeriods: 1,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      })),
    ];

    // ---- Dashboard ------------------------------------------------------------------------------
    const dash = new cloudwatch.Dashboard(this, 'Dashboard', { dashboardName: name, defaultInterval: Duration.hours(6) });
    const fnMetrics = (f: (fn: lambda.IFunction) => cloudwatch.IMetric) => Object.values(functions).map(f);

    dash.addWidgets(
      new cloudwatch.TextWidget({
        markdown: `# GridSight AI · ${config.envName}\nApp: https://${config.domain.appHost} · API: https://${config.domain.apiHost} · Alarms → SNS \`${topic.topicName}\``,
        width: 24, height: 2,
      }),
      new cloudwatch.AlarmStatusWidget({ title: 'Alarm status', alarms, width: 24, height: 3 }),
    );
    dash.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'REST API requests and errors', width: 8,
        left: [props.httpApi.metricCount({ statistic: 'Sum' })],
        right: [props.httpApi.metricClientError({ statistic: 'Sum' }), api5xx],
      }),
      new cloudwatch.GraphWidget({
        title: 'REST API latency (ms)', width: 8,
        left: ['p50', 'p90', 'p99'].map((s) => props.httpApi.metricLatency({ statistic: s, label: s })),
      }),
      new cloudwatch.GraphWidget({
        title: 'CloudFront 5xx error rate (%)', width: 8,
        left: [props.webDistributionId, props.apiDistributionId].map((id, i) =>
          new cloudwatch.Metric({ namespace: 'AWS/CloudFront', metricName: '5xxErrorRate', dimensionsMap: { DistributionId: id, Region: 'Global' }, statistic: 'Average', label: i === 0 ? 'web' : 'api', region: 'us-east-1' }),
        ),
      }),
    );
    dash.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'AI assistant: requests, errors, tool errors', width: 8,
        left: [app('ChatRequests'), app('ChatErrors'), app('ToolErrors')],
      }),
      new cloudwatch.GraphWidget({
        title: 'AI tokens (input / output / cache read)', width: 8,
        left: [app('ChatInputTokens'), app('ChatOutputTokens'), app('ChatCacheReadTokens')],
      }),
      new cloudwatch.GraphWidget({
        title: 'AI turn latency (ms)', width: 8,
        left: [app('ChatLatency', 'p50'), app('ChatLatency', 'p90')],
      }),
    );
    dash.addWidgets(
      new cloudwatch.GraphWidget({ title: 'Data pipeline: intervals written / anomalies', width: 8, left: [app('IntervalsWritten')], right: [app('AnomaliesDetected')] }),
      new cloudwatch.GraphWidget({ title: 'Data lag (s)', width: 8, left: [app('DataLagSeconds', 'Maximum')] }),
      new cloudwatch.GraphWidget({ title: 'Athena bytes scanned by API', width: 8, left: [app('SqlBytesScanned')] }),
    );
    dash.addWidgets(
      new cloudwatch.GraphWidget({ title: 'Lambda errors', width: 8, left: fnMetrics((f) => f.metricErrors({ label: f.node.id })) }),
      new cloudwatch.GraphWidget({ title: 'Lambda duration p90 (ms)', width: 8, left: fnMetrics((f) => f.metricDuration({ statistic: 'p90', label: f.node.id })) }),
      new cloudwatch.GraphWidget({ title: 'Lambda throttles', width: 8, left: fnMetrics((f) => f.metricThrottles({ label: f.node.id })) }),
    );
    dash.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'WAF allowed vs blocked', width: 12,
        left: ['AllowedRequests', 'BlockedRequests'].map((m) => new cloudwatch.Metric({ namespace: 'AWS/WAFV2', metricName: m, dimensionsMap: { WebACL: props.webAclName, Rule: 'ALL' }, statistic: 'Sum', label: m })),
      }),
      new cloudwatch.LogQueryWidget({
        title: 'Top API routes (last interval)', width: 12,
        logGroupNames: [props.apiLogGroup.logGroupName],
        queryLines: ['fields method, path, status', 'stats count(*) as requests, avg(latencyMs) as avgMs by method, path, status', 'sort requests desc', 'limit 15'],
      }),
    );
  }
}
