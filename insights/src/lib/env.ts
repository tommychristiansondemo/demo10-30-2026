/** Environment for the Course Insights Lambdas (set by InsightsStack). Getters, so tests can import freely. */
function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable ${name}`);
  return v;
}

export const env = {
  get region() { return process.env.AWS_REGION ?? 'us-east-1'; },
  get envName() { return process.env.GRIDSIGHT_ENV ?? 'dev'; },
  /** CloudFormation stacks whose names start with this prefix are "the deployment". */
  get stackPrefix() { return process.env.STACK_PREFIX ?? `GridSight-${this.envName}`; },
  get knowledgeBucket() { return req('KNOWLEDGE_BUCKET'); },
  get knowledgeKey() { return process.env.KNOWLEDGE_KEY ?? 'projectknowledge.md'; },
  get baseKnowledgeKey() { return process.env.BASE_KNOWLEDGE_KEY ?? 'base/projectknowledge.base.md'; },
  get gridsightConfigParameter() { return process.env.GRIDSIGHT_CONFIG_PARAMETER ?? `/gridsight/${this.envName}/app-config`; },
  get modelId() { return process.env.INSIGHTS_MODEL_ID ?? 'us.anthropic.claude-sonnet-4-6'; },
  get userPoolId() { return req('USER_POOL_ID'); },
  get userPoolClientIds() { return req('USER_POOL_CLIENT_IDS').split(','); },
  get originVerifySecretArn() { return process.env.ORIGIN_VERIFY_SECRET_ARN ?? ''; },
  get appUrl() { return process.env.GRIDSIGHT_APP_URL ?? ''; },
  get insightsUrl() { return process.env.INSIGHTS_URL ?? ''; },
};
