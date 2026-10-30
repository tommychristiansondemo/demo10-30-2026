/** Structured logging + CloudWatch Embedded Metric Format via Powertools. */
import { Logger } from '@aws-lambda-powertools/logger';
import { Metrics, MetricUnit } from '@aws-lambda-powertools/metrics';

export const logger = new Logger({ serviceName: 'gridsight' });
export const metrics = new Metrics({ namespace: 'GridSight', serviceName: 'gridsight' });
export { MetricUnit };

/** Emit buffered metrics; call at the end of every handler. */
export function flushMetrics(): void {
  try {
    metrics.publishStoredMetrics();
  } catch (err) {
    logger.warn('metrics flush failed', { err });
  }
}
