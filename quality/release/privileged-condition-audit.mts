import {
  stableSortFindings,
  type AuditSection,
  type Finding,
  type RepositoryInventory,
} from './contracts.mts';
import {
  firstWorkflowField,
  jobHasSecrets,
  jobHasWriteAuthority,
  jobUsesProtectedEnvironment,
  workflowFiles,
  workflowJobBlocks,
  workflowTriggerProfile,
  type WorkflowJobBlock,
} from './workflow-structure.mts';
import {
  firstWorkflowStepField,
  stepDisplayName,
  workflowStepBlocks,
  type WorkflowStepBlock,
} from './workflow-step-structure.mts';

export type PrivilegedConditionScope = 'job' | 'step';
export type ConditionProvenance = 'event' | 'input' | 'output' | 'matrix' | 'vars' | 'trusted' | 'none';

export interface PrivilegedConditionSignal {
  readonly file: string;
  readonly job: string;
  readonly step: string | null;
  readonly scope: PrivilegedConditionScope;
  readonly line: number;
  readonly condition: string;
  readonly provenance: readonly ConditionProvenance[];
  readonly externalContribution: boolean;
  readonly writeAuthority: boolean;
  readonly secrets: boolean;
  readonly protectedEnvironment: boolean;
  readonly failureOverride: boolean;
}

export interface PrivilegedConditionSummary {
  readonly workflowFiles: number;
  readonly privilegedJobs: number;
  readonly conditionedPrivilegedJobs: number;
  readonly conditionedPrivilegedSteps: number;
  readonly externallyControlledConditions: number;
  readonly failureOverrideConditions: number;
  readonly signals: readonly PrivilegedConditionSignal[];
  readonly findings: readonly Finding[];
}

const EVENT_CONTROL = /(?:github\.head_ref\b|github\.event\.pull_request\.head\.(?:ref|sha)\b|github\.event\.(?:pull_request\.(?:title|body)|issue\.(?:title|body)|comment\.body|review\.body|review_comment\.body|discussion\.(?:title|body)|head_commit\.message))/i;
const INPUT_CONTROL = /(?:^|[^A-Za-z0-9_])(?:inputs\.|github\.event\.inputs\.)/i;
const OUTPUT_CONTROL = /(?:needs\.[A-Za-z0-9_.-]+\.outputs\.|steps\.[A-Za-z0-9_.-]+\.outputs\.)/i;
const MATRIX_CONTROL = /(?:^|[^A-Za-z0-9_])matrix\./i;
const VARS_CONTROL = /(?:^|[^A-Za-z0-9_])vars\./i;
const TRUSTED_FACT = /(?:github\.(?:repository|sha|ref|ref_name|base_ref|event_name|actor|triggering_actor)\b|needs\.[A-Za-z0-9_.-]+\.result\b)/i;
const FAILURE_OVERRIDE = /\b(?:always|failure)\s*\(\s*\)/i;
const CANCELLATION_OVERRIDE = /!\s*cancelled\s*\(\s*\)|\bcancelled\s*\(\s*\)\s*==\s*false/i;

function provenance(condition: string): ConditionProvenance[] {
  const result = new Set<ConditionProvenance>();
  if (EVENT_CONTROL.test(condition)) result.add('event');
  if (INPUT_CONTROL.test(condition)) result.add('input');
  if (OUTPUT_CONTROL.test(condition)) result.add('output');
  if (MATRIX_CONTROL.test(condition)) result.add('matrix');
  if (VARS_CONTROL.test(condition)) result.add('vars');
  if (TRUSTED_FACT.test(condition)) result.add('trusted');
  if (result.size === 0) result.add('none');
  return [...result].sort((left, right) => left.localeCompare(right, 'en'));
}

function privileged(block: WorkflowJobBlock): boolean {
  return jobHasWriteAuthority(block) || jobHasSecrets(block) || jobUsesProtectedEnvironment(block);
}

function baseSignal(
  block: WorkflowJobBlock,
  condition: string,
  line: number,
  scope: PrivilegedConditionScope,
  step: string | null,
): PrivilegedConditionSignal {
  const trigger = workflowTriggerProfile(block.file);
  return {
    file: block.file.repositoryPath,
    job: block.name,
    step,
    scope,
    line,
    condition,
    provenance: provenance(condition),
    externalContribution: trigger.externalContribution,
    writeAuthority: jobHasWriteAuthority(block),
    secrets: jobHasSecrets(block),
    protectedEnvironment: jobUsesProtectedEnvironment(block),
    failureOverride: FAILURE_OVERRIDE.test(condition) || CANCELLATION_OVERRIDE.test(condition),
  };
}

function jobCondition(block: WorkflowJobBlock): PrivilegedConditionSignal | undefined {
  if (!privileged(block)) return undefined;
  const field = firstWorkflowField(block, 'if');
  if (!field) return undefined;
  return baseSignal(block, field.value, field.line, 'job', null);
}

function stepCondition(block: WorkflowJobBlock, step: WorkflowStepBlock): PrivilegedConditionSignal | undefined {
  if (!privileged(block)) return undefined;
  const field = firstWorkflowStepField(step, 'if');
  if (!field) return undefined;
  return baseSignal(block, field.value, field.line, 'step', stepDisplayName(step));
}

function signalsFor(block: WorkflowJobBlock): PrivilegedConditionSignal[] {
  if (!privileged(block)) return [];
  const result: PrivilegedConditionSignal[] = [];
  const job = jobCondition(block);
  if (job) result.push(job);
  for (const step of workflowStepBlocks(block)) {
    const current = stepCondition(block, step);
    if (current) result.push(current);
  }
  return result;
}

function location(item: PrivilegedConditionSignal) {
  return { file: item.file, line: item.line };
}

function finding(
  item: PrivilegedConditionSignal,
  id: string,
  severity: Finding['severity'],
  title: string,
  message: string,
  remediation: string,
  blocking = false,
): Finding {
  return {
    id,
    domain: 'security',
    severity,
    title,
    message,
    location: location(item),
    evidence: {
      value: item.condition,
      metadata: {
        job: item.job,
        step: item.step ?? 'job',
        scope: item.scope,
        provenance: item.provenance.join(','),
      },
    },
    remediation,
    ...(blocking ? { blocking: true } : {}),
    tags: ['ci', 'condition', 'privilege', 'trust-boundary'],
  };
}

function findingsFor(item: PrivilegedConditionSignal): Finding[] {
  const findings: Finding[] = [];
  const event = item.provenance.includes('event');
  const input = item.provenance.includes('input');
  const output = item.provenance.includes('output');
  const matrix = item.provenance.includes('matrix');
  const vars = item.provenance.includes('vars');
  const sensitive = item.writeAuthority || item.secrets;

  if (event) {
    const critical = item.externalContribution || sensitive;
    findings.push(finding(
      item,
      'ci-privileged-condition-event-controlled',
      critical ? 'critical' : 'high',
      'Contribution-controlled event data gates privileged execution',
      `Privileged ${item.scope} condition depends on pull-request/head/event content that an external contributor can influence. A crafted event can steer whether privileged code executes.`,
      'Gate privilege on trusted repository/ref/environment facts and validated maintainer-controlled state. Never use PR text, comments, or head refs as privileged authorization conditions.',
      critical,
    ));
  }

  if (input) {
    findings.push(finding(
      item,
      'ci-privileged-condition-input-controlled',
      sensitive ? 'high' : 'medium',
      'Caller input gates privileged execution',
      `Privileged ${item.scope} condition is controlled by a workflow/reusable-call input. Caller authorization and input validation become part of the privilege boundary.`,
      'Map inputs to a closed policy decision in trusted workflow code. For write/secret operations, require protected environment or trusted ref checks in addition to caller input.',
    ));
  }

  if (output) {
    findings.push(finding(
      item,
      'ci-privileged-condition-output-controlled',
      sensitive ? 'high' : 'medium',
      'Upstream step or job output gates privileged execution',
      `Privileged ${item.scope} condition depends on an upstream output. If the producer executes contribution-controlled code, the output can become an implicit authorization channel.`,
      'Treat upstream outputs as untrusted data unless their producer is isolated from contribution-controlled code. Validate outputs against a closed schema before using them to authorize privileged work.',
    ));
  }

  if (matrix || vars) {
    findings.push(finding(
      item,
      'ci-privileged-condition-indirect-policy',
      sensitive ? 'medium' : 'low',
      'Privileged condition depends on indirect configuration',
      `Condition policy depends on ${[matrix ? 'matrix' : '', vars ? 'vars' : ''].filter(Boolean).join(' and ')} values, so privilege behavior can change outside the conditioned step.`,
      'Keep privilege predicates small and explicit. Use literal trusted refs/environments or a centrally reviewed policy output with a closed value domain.',
    ));
  }

  if (item.failureOverride) {
    const critical = item.externalContribution && sensitive;
    findings.push(finding(
      item,
      'ci-privileged-condition-failure-override',
      critical ? 'critical' : 'high',
      'Privileged execution can run after validation failure',
      `Condition ${item.condition} uses always()/failure()/cancellation override semantics in a privileged context. Mutation or secret-bearing work may execute after an upstream validation gate fails.`,
      'Keep always()/failure() for cleanup and diagnostics only. Require success() or an explicit successful validation result before write, secret, signing, publication, or deployment steps.',
      critical,
    ));
  }

  return findings;
}

export function auditPrivilegedConditions(
  inventory: RepositoryInventory,
): AuditSection<PrivilegedConditionSummary> {
  const started = performance.now();
  const files = workflowFiles(inventory);
  const jobs = files.flatMap(file => workflowJobBlocks(file));
  const privilegedJobs = jobs.filter(privileged);
  const signals = privilegedJobs.flatMap(signalsFor);
  const findings = stableSortFindings(signals.flatMap(findingsFor));
  return {
    domain: 'security',
    title: 'Privileged workflow condition provenance audit',
    summary: {
      workflowFiles: files.length,
      privilegedJobs: privilegedJobs.length,
      conditionedPrivilegedJobs: signals.filter(item => item.scope === 'job').length,
      conditionedPrivilegedSteps: signals.filter(item => item.scope === 'step').length,
      externallyControlledConditions: signals.filter(item => item.provenance.includes('event') || item.provenance.includes('input')).length,
      failureOverrideConditions: signals.filter(item => item.failureOverride).length,
      signals,
      findings,
    },
    findings,
    elapsedMs: Math.max(0, performance.now() - started),
  };
}
