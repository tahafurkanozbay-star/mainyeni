import {
  stableSortFindings,
  type AuditSection,
  type Finding,
  type RepositoryInventory,
} from './contracts.mts';
import {
  jobHasSecrets,
  jobHasWriteAuthority,
  workflowFiles,
  workflowJobBlocks,
  workflowTriggerProfile,
  type WorkflowJobBlock,
} from './workflow-structure.mts';
import {
  stepDisplayName,
  stepNestedMapping,
  stepRunText,
  workflowStepBlocks,
  type WorkflowStepBlock,
} from './workflow-step-structure.mts';

export interface GitHubMutationSignal {
  readonly file: string;
  readonly job: string;
  readonly step: string;
  readonly mutationCommands: number;
  readonly dynamicTargets: number;
  readonly dynamicPayloads: number;
  readonly externalContribution: boolean;
  readonly writeAuthority: boolean;
  readonly secretBearing: boolean;
  readonly line: number;
}

export interface GitHubMutationBoundarySummary {
  readonly workflowFiles: number;
  readonly mutationSteps: number;
  readonly mutationCommands: number;
  readonly dynamicTargets: number;
  readonly dynamicPayloads: number;
  readonly externalMutationSteps: number;
  readonly signals: readonly GitHubMutationSignal[];
  readonly findings: readonly Finding[];
}

const GH_API_MUTATION = /\bgh\s+api\b[^\n]*(?:-X|--method)\s+(?:POST|PUT|PATCH|DELETE)\b[^\n]*/gi;
const GH_COMMAND_MUTATION = /\bgh\s+(?:pr\s+(?:merge|edit|comment|close|reopen|ready)|issue\s+(?:edit|comment|close|reopen|delete)|release\s+(?:create|edit|delete|upload|delete-asset)|workflow\s+run|run\s+(?:cancel|delete|rerun)|repo\s+edit)\b[^\n]*/gi;
const CURL_GITHUB_MUTATION = /\bcurl\b[^\n]*(?:-X|--request)\s+(?:POST|PUT|PATCH|DELETE)\b[^\n]*(?:api\.github\.com|github\.com\/api)[^\n]*/gi;
const UNTRUSTED = /\$\{\{[\s\S]*?(?:github\.event\.|github\.head_ref\b|inputs\.|github\.event\.inputs\.|needs\.[A-Za-z0-9_-]+\.outputs\.|steps\.[A-Za-z0-9_-]+\.outputs\.|matrix\.)[\s\S]*?\}\}/i;
const EVENT_TEXT = /\$\{\{[\s\S]*?github\.event\.(?:pull_request\.(?:title|body)|issue\.(?:title|body)|comment\.body|review(?:_comment)?\.body|discussion\.(?:title|body))[\s\S]*?\}\}/i;
const TARGET_FLAG = /(?:^|\s)(?:--repo|-R|--hostname|--head|--base|--branch|--ref|--repo-id)\s+(?:"([^"]+)"|'([^']+)'|([^\s'"`]+))/i;
const API_PATH = /\bgh\s+api\b(?:\s+(?:-X|--method)\s+\S+)*\s+(?:"([^"]+)"|'([^']+)'|([^\s'"`]+))/i;
const PAYLOAD_FLAG = /(?:^|\s)(?:-f|--raw-field|-F|--field|--input)\s+[^\n]*/i;
const BODY_FLAG = /(?:^|\s)(?:--body|-b|--title|-t|--notes|--notes-file|--comment)\s+[^\n]*/i;
const SAFE_LITERAL_REPOSITORY = /^(?:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+|\$\{\{\s*github\.repository\s*\}\})$/;

function allMatches(text: string): string[] {
  const patterns = [GH_API_MUTATION, GH_COMMAND_MUTATION, CURL_GITHUB_MUTATION];
  const values: string[] = [];
  for (const pattern of patterns) {
    const matcher = new RegExp(pattern.source, pattern.flags);
    let match: RegExpExecArray | null;
    while ((match = matcher.exec(text)) !== null) values.push(match[0]);
  }
  return values;
}

function capturedScalar(match: RegExpMatchArray | null): string {
  return (match?.[1] ?? match?.[2] ?? match?.[3] ?? '').trim();
}

function secretEnvNames(step: WorkflowStepBlock): string[] {
  return [...stepNestedMapping(step, 'env').entries()]
    .filter(([, value]) => /\$\{\{\s*secrets\./i.test(value))
    .map(([name]) => name);
}

function untrustedEnvNames(step: WorkflowStepBlock): string[] {
  return [...stepNestedMapping(step, 'env').entries()]
    .filter(([, value]) => UNTRUSTED.test(value))
    .map(([name]) => name);
}

function referencesVariable(text: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:\\$\\{${escaped}\\}|\\$${escaped}\\b|\\$env:${escaped}\\b|%${escaped}%)`, 'i').test(text);
}

function dynamicTarget(command: string, untrustedEnv: readonly string[]): boolean {
  const target = capturedScalar(command.match(TARGET_FLAG));
  if (target) {
    if (UNTRUSTED.test(target) || untrustedEnv.some(name => referencesVariable(target, name))) return true;
    if (!SAFE_LITERAL_REPOSITORY.test(target) && /\$|%/.test(target)) return true;
  }
  const apiPath = capturedScalar(command.match(API_PATH));
  return Boolean(apiPath && (UNTRUSTED.test(apiPath) || untrustedEnv.some(name => referencesVariable(apiPath, name))));
}

function dynamicPayload(command: string, untrustedEnv: readonly string[]): boolean {
  if (!PAYLOAD_FLAG.test(command) && !BODY_FLAG.test(command) && !/\b(?:gh\s+api|curl)\b/i.test(command)) return false;
  return EVENT_TEXT.test(command) || UNTRUSTED.test(command) || untrustedEnv.some(name => referencesVariable(command, name));
}

function signal(block: WorkflowJobBlock, step: WorkflowStepBlock): GitHubMutationSignal | undefined {
  const run = stepRunText(step);
  const commands = allMatches(run);
  if (commands.length === 0) return undefined;
  const trigger = workflowTriggerProfile(block.file);
  const untrustedEnv = untrustedEnvNames(step);
  return {
    file: block.file.repositoryPath,
    job: block.name,
    step: stepDisplayName(step),
    mutationCommands: commands.length,
    dynamicTargets: commands.filter(command => dynamicTarget(command, untrustedEnv)).length,
    dynamicPayloads: commands.filter(command => dynamicPayload(command, untrustedEnv)).length,
    externalContribution: trigger.externalContribution,
    writeAuthority: jobHasWriteAuthority(block),
    secretBearing: jobHasSecrets(block) || secretEnvNames(step).length > 0,
    line: step.startLine,
  };
}

function finding(step: WorkflowStepBlock, id: string, severity: Finding['severity'], title: string, message: string, remediation: string, blocking = false): Finding {
  return {
    id,
    domain: 'security',
    severity,
    ...(blocking ? { blocking: true } : {}),
    title,
    message,
    location: { file: step.job.file.repositoryPath, line: step.startLine },
    evidence: { excerpt: stepRunText(step).slice(0, 440), metadata: { job: step.job.name, step: stepDisplayName(step) } },
    remediation,
    tags: ['ci', 'github-api', 'mutation', 'authorization', 'trust-boundary'],
  };
}

function auditStep(block: WorkflowJobBlock, step: WorkflowStepBlock): Finding[] {
  const current = signal(block, step);
  if (!current) return [];
  const findings: Finding[] = [];
  const privileged = current.writeAuthority || current.secretBearing;

  if (current.externalContribution && current.mutationCommands > 0) {
    findings.push(finding(
      step,
      'ci-github-mutation-external-trigger',
      privileged ? 'critical' : 'high',
      'Externally influenced workflow performs GitHub mutation',
      `Step ${current.step} can mutate GitHub repository state from a contribution-controlled trigger. Event authorization and token permissions must not allow untrusted content to choose mutation targets or payloads.`,
      'Move repository mutations to a trusted follow-up workflow/job. Pass only validated immutable identifiers from external validation and keep contribution jobs read-only.',
      privileged,
    ));
  }

  if (current.dynamicTargets > 0) {
    findings.push(finding(
      step,
      'ci-github-mutation-dynamic-target',
      privileged ? 'critical' : 'high',
      'GitHub mutation target is expression-controlled',
      `Step ${current.step} derives a mutation endpoint/repository/ref target from event, input, matrix, or output data. A caller can redirect otherwise legitimate write authority.`,
      'Validate target identifiers against the current repository and a closed operation-specific allowlist. Use literal API paths/repositories/refs for privileged mutations.',
      privileged,
    ));
  }

  if (current.dynamicPayloads > 0) {
    findings.push(finding(
      step,
      'ci-github-mutation-dynamic-payload',
      privileged ? 'critical' : 'high',
      'GitHub mutation payload contains unvalidated dynamic data',
      `Step ${current.step} passes event/input/output-controlled data into a GitHub mutation payload or body. Text fields can be legitimate, but identifiers, refs, states, paths, and structured JSON require closed-schema validation before mutation.`,
      'Pass untrusted text as quoted data only after normalization/length bounds. Validate every identifier/state/ref field against an allowlist before constructing API payloads.',
      privileged && current.externalContribution,
    ));
  }

  return findings;
}

export function auditGitHubMutationBoundaries(inventory: RepositoryInventory): AuditSection<GitHubMutationBoundarySummary> {
  const started = performance.now();
  const files = workflowFiles(inventory);
  const jobs = files.flatMap(file => workflowJobBlocks(file));
  const pairs = jobs.flatMap(job => workflowStepBlocks(job).map(step => ({ job, step })));
  const signals = pairs.map(({ job, step }) => signal(job, step)).filter((item): item is GitHubMutationSignal => item !== undefined);
  const findings = stableSortFindings(pairs.flatMap(({ job, step }) => auditStep(job, step)));
  return {
    domain: 'security',
    title: 'GitHub API and repository mutation boundary audit',
    summary: {
      workflowFiles: files.length,
      mutationSteps: signals.length,
      mutationCommands: signals.reduce((sum, item) => sum + item.mutationCommands, 0),
      dynamicTargets: signals.reduce((sum, item) => sum + item.dynamicTargets, 0),
      dynamicPayloads: signals.reduce((sum, item) => sum + item.dynamicPayloads, 0),
      externalMutationSteps: signals.filter(item => item.externalContribution).length,
      signals,
      findings,
    },
    findings,
    elapsedMs: Math.max(0, performance.now() - started),
  };
}
