/**
 * Live inventory of everything deployed for the class, read from CloudFormation (the source of truth
 * for what CDK created): stacks, every resource and its type, and non-secret stack outputs.
 */
import {
  CloudFormationClient,
  DescribeStacksCommand,
  paginateListStackResources,
  paginateListStacks,
  type StackResourceSummary,
  type StackStatus,
} from '@aws-sdk/client-cloudformation';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { env } from './env.js';

const cfn = new CloudFormationClient({});
const ssm = new SSMClient({});

const LIVE: StackStatus[] = ['CREATE_COMPLETE', 'UPDATE_COMPLETE', 'UPDATE_ROLLBACK_COMPLETE', 'CREATE_IN_PROGRESS', 'UPDATE_IN_PROGRESS', 'UPDATE_COMPLETE_CLEANUP_IN_PROGRESS', 'ROLLBACK_COMPLETE'];

export interface StackInfo {
  name: string;
  description: string;
  status: string;
  createdAt?: string;
  updatedAt?: string;
  resourceCount: number;
  outputs: { key: string; value: string; description?: string }[];
  resources: { logicalId: string; type: string; physicalId?: string; status?: string }[];
}

export interface Inventory {
  generatedAt: string;
  stackPrefixes: string[];
  stacks: StackInfo[];
  totals: { stacks: number; resources: number; resourceTypes: number; awsServices: number };
  byType: { type: string; count: number }[];
  byService: { service: string; count: number }[];
  models: { gridsight?: Record<string, unknown>; insights: string };
}

/** Outputs that are CDK plumbing or name a secret are left out. */
const hiddenOutput = (key: string) => key.startsWith('ExportsOutput') || /secret/i.test(key);

/** "AWS::Lambda::Function" → "Lambda"; CDK custom resources count under "CloudFormation custom resource". */
export function serviceOf(type: string): string {
  if (type.startsWith('Custom::') || type === 'AWS::CloudFormation::CustomResource') return 'CloudFormation custom resource';
  return type.split('::')[1] ?? type;
}

async function stackResources(name: string): Promise<StackResourceSummary[]> {
  const out: StackResourceSummary[] = [];
  for await (const page of paginateListStackResources({ client: cfn }, { StackName: name })) out.push(...(page.StackResourceSummaries ?? []));
  return out;
}

export async function listStackNames(prefixes: string[]): Promise<string[]> {
  const names: string[] = [];
  for await (const page of paginateListStacks({ client: cfn }, { StackStatusFilter: LIVE })) {
    for (const s of page.StackSummaries ?? []) if (prefixes.some((p) => s.StackName?.startsWith(p))) names.push(s.StackName!);
  }
  return names.sort();
}

export async function getInventory(): Promise<Inventory> {
  const prefixes = [`${env.stackPrefix}-`, `GridSightInsights-${env.envName}`];
  const names = await listStackNames(prefixes);
  const stacks = await Promise.all(
    names.map(async (name): Promise<StackInfo> => {
      const [desc, resources] = await Promise.all([cfn.send(new DescribeStacksCommand({ StackName: name })), stackResources(name)]);
      const s = desc.Stacks?.[0];
      return {
        name,
        description: s?.Description ?? '',
        status: s?.StackStatus ?? 'UNKNOWN',
        createdAt: s?.CreationTime?.toISOString(),
        updatedAt: (s?.LastUpdatedTime ?? s?.CreationTime)?.toISOString(),
        resourceCount: resources.filter((r) => r.ResourceType !== 'AWS::CDK::Metadata').length,
        outputs: (s?.Outputs ?? []).filter((o) => !hiddenOutput(o.OutputKey ?? '')).map((o) => ({ key: o.OutputKey!, value: o.OutputValue ?? '', description: o.Description })),
        resources: resources
          .filter((r) => r.ResourceType !== 'AWS::CDK::Metadata')
          .map((r) => ({ logicalId: r.LogicalResourceId!, type: r.ResourceType!, physicalId: r.PhysicalResourceId, status: r.ResourceStatus })),
      };
    }),
  );

  const typeCounts = new Map<string, number>();
  for (const s of stacks) for (const r of s.resources) typeCounts.set(r.type, (typeCounts.get(r.type) ?? 0) + 1);
  const byType = [...typeCounts].map(([type, count]) => ({ type, count })).sort((a, b) => b.count - a.count || a.type.localeCompare(b.type));
  const serviceCounts = new Map<string, number>();
  for (const { type, count } of byType) serviceCounts.set(serviceOf(type), (serviceCounts.get(serviceOf(type)) ?? 0) + count);
  const byService = [...serviceCounts].map(([service, count]) => ({ service, count })).sort((a, b) => b.count - a.count);

  let gridsight: Record<string, unknown> | undefined;
  try {
    const p = await ssm.send(new GetParameterCommand({ Name: env.gridsightConfigParameter }));
    const cfg = JSON.parse(p.Parameter?.Value ?? '{}') as { ai?: Record<string, unknown> };
    const { chatModelId, fallbackModelId, sqlModelId, effort, promptVariant, maxToolIterations } = cfg.ai ?? {};
    gridsight = { chatModelId, fallbackModelId, sqlModelId, effort, promptVariant, maxToolIterations, embeddingModelId: 'amazon.titan-embed-text-v2:0' };
  } catch {
    gridsight = undefined;
  }

  return {
    generatedAt: new Date().toISOString(),
    stackPrefixes: prefixes,
    stacks,
    totals: {
      stacks: stacks.length,
      resources: stacks.reduce((n, s) => n + s.resourceCount, 0),
      resourceTypes: byType.length,
      awsServices: byService.filter((s) => s.service !== 'CloudFormation custom resource').length,
    },
    byType,
    byService,
    models: { gridsight, insights: env.modelId },
  };
}

/** Compact form for the chatbot: no per-resource physical IDs unless asked. */
export function summarize(inv: Inventory) {
  return {
    generatedAt: inv.generatedAt,
    totals: inv.totals,
    models: inv.models,
    byService: inv.byService,
    byType: inv.byType,
    stacks: inv.stacks.map((s) => ({ name: s.name, description: s.description, status: s.status, updatedAt: s.updatedAt, resourceCount: s.resourceCount, outputs: s.outputs })),
  };
}

/** Markdown section appended to projectknowledge.md by the refresher. */
export function inventoryMarkdown(inv: Inventory): string {
  const lines: string[] = [];
  lines.push(`# Part 2: Live deployment inventory`, '');
  lines.push(`_Auto-generated from CloudFormation at ${inv.generatedAt} by the knowledge refresher Lambda. It is rewritten whenever a GridSight stack finishes deploying, and hourly._`, '');
  lines.push(`## Totals`, '');
  lines.push(`- CloudFormation stacks: **${inv.totals.stacks}**`);
  lines.push(`- Resources (excluding CDK metadata): **${inv.totals.resources}**`);
  lines.push(`- Distinct resource types: **${inv.totals.resourceTypes}**`);
  lines.push(`- Distinct AWS services: **${inv.totals.awsServices}**`, '');
  lines.push(`## Models currently in use`, '');
  if (inv.models.gridsight) {
    const g = inv.models.gridsight;
    lines.push(`- GridSight AI assistant (chat): \`${g.chatModelId}\`, effort \`${g.effort}\`, prompt profile \`${g.promptVariant}\``);
    lines.push(`- GridSight fallback on refusal: \`${g.fallbackModelId}\``);
    lines.push(`- GridSight natural language → SQL: \`${g.sqlModelId}\``);
    lines.push(`- Knowledge Base embeddings: \`${g.embeddingModelId}\``);
  }
  lines.push(`- Course Insights chatbot (this assistant): \`${inv.models.insights}\``, '');
  lines.push(`## Resources by AWS service`, '', '| Service | Resources |', '|---|---:|');
  for (const s of inv.byService) lines.push(`| ${s.service} | ${s.count} |`);
  lines.push('', `## Resources by type`, '', '| Resource type | Count |', '|---|---:|');
  for (const t of inv.byType) lines.push(`| \`${t.type}\` | ${t.count} |`);
  lines.push('', `## Stacks`, '');
  for (const s of inv.stacks) {
    lines.push(`### ${s.name}`, '', `${s.description}`, '', `Status \`${s.status}\`, ${s.resourceCount} resources, created ${s.createdAt}, last updated ${s.updatedAt}.`, '');
    if (s.outputs.length) {
      lines.push('Outputs:', '');
      for (const o of s.outputs) lines.push(`- \`${o.key}\`: ${o.value}${o.description ? ` (${o.description})` : ''}`);
      lines.push('');
    }
    lines.push('<details><summary>Resources</summary>', '', '| Logical ID | Type |', '|---|---|');
    for (const r of s.resources) lines.push(`| ${r.logicalId} | \`${r.type}\` |`);
    lines.push('', '</details>', '');
  }
  return lines.join('\n');
}
