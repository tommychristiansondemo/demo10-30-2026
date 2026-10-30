/** Typed access to Lambda environment variables (set by the CDK stacks). */
function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable ${name}`);
  return v;
}

export const env = {
  get stage() { return process.env.GRIDSIGHT_ENV ?? 'dev'; },
  get region() { return process.env.AWS_REGION ?? 'us-east-1'; },
  get metricsTable() { return req('METRICS_TABLE'); },
  get alertsTable() { return req('ALERTS_TABLE'); },
  get auditTable() { return req('AUDIT_TABLE'); },
  get sessionsTable() { return req('SESSIONS_TABLE'); },
  get connectionsTable() { return req('CONNECTIONS_TABLE'); },
  get lakeBucket() { return req('LAKE_BUCKET'); },
  get glueDatabase() { return req('GLUE_DATABASE'); },
  get athenaWorkgroup() { return req('ATHENA_WORKGROUP'); },
  get configParameter() { return req('CONFIG_PARAMETER'); },
  get knowledgeBaseId() { return process.env.KNOWLEDGE_BASE_ID ?? ''; },
  get wsManagementEndpoint() { return process.env.WS_MANAGEMENT_ENDPOINT ?? ''; },
  get chatWorkerFunction() { return req('CHAT_WORKER_FUNCTION'); },
  get userPoolId() { return req('USER_POOL_ID'); },
  get userPoolClientIds() { return req('USER_POOL_CLIENT_IDS').split(','); },
  get originVerifySecretArn() { return process.env.ORIGIN_VERIFY_SECRET_ARN ?? ''; },
  get enforceOriginVerify() { return process.env.ENFORCE_ORIGIN_VERIFY === 'true'; },
  get dataSeed() { return process.env.DATA_SEED ?? 'gridsight-ercot-v1'; },
  get hotDays() { return Number(process.env.HOT_DAYS ?? '30'); },
};
