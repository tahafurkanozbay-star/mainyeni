import {
  stableSortFindings,
  type AuditSection,
  type Finding,
  type RepositoryInventory,
} from './contracts.mts';
import {
  hasUntrustedExpression,
  jobHasWriteAuthority,
  workflowFiles,
  workflowJobBlocks,
  workflowTriggerProfile,
  type WorkflowJobBlock,
} from './workflow-structure.mts';
import {
  firstWorkflowStepField,
  stepDisplayName,
  stepNestedMapping,
  stepUsesIdentity,
  workflowStepBlocks,
  type WorkflowStepBlock,
} from './workflow-step-structure.mts';

export type WorkflowControlMutationKind =
  | 'dispatch'
  | 'rerun'
  | 'cancel'
  | 'enable'
  | 'disable'
  | 'delete-logs';

export interface WorkflowControlMutationSignal {
  readonly file: string;
  readonly job: string;
  readonly step: string;
  readonly line: number;
  readonly mutation: WorkflowControlMutationKind;
  readonly operation: string;
  readonly fields: readonly string[];
  readonly untrustedFields: readonly string[];
  readonly secretFields: readonly string[];
  readonly indirectSelectorFields: readonly string[];
  readonly writeAuthority: boolean;
  readonly externalContribution: boolean;
}

export interface WorkflowControlMutationSummary {
  readonly workflowFiles: number;
  readonly mutations: number;
  readonly dispatches: number;
  readonly runMutations: number;
  readonly workflowStateMutations: number;
  readonly untrustedMutations: number;
  readonly secretBearingMutations: number;
  readonly signals: readonly WorkflowControlMutationSignal[];
  readonly findings: readonly Finding[];
}

type FieldKind = 'workflow' | 'ref' | 'run' | 'inputs' | 'other';

interface OperationSpec {
  readonly pattern: RegExp;
  readonly kind: WorkflowControlMutationKind;
  readonly label: string;
}

interface ParsedField {
  readonly name: string;
  readonly value: string;
  readonly kind: FieldKind;
  readonly untrusted: boolean;
  readonly secret: boolean;
  readonly indirect: boolean;
}

const OPERATIONS: readonly OperationSpec[] = [
  { pattern: /\b(?:github\.)?rest\.actions\.createWorkflowDispatch\s*\(/i, kind: 'dispatch', label: 'actions.createWorkflowDispatch' },
  { pattern: /\b(?:github\.)?rest\.actions\.(?:reRunWorkflow|rerunWorkflow)\s*\(/i, kind: 'rerun', label: 'actions.reRunWorkflow' },
  { pattern: /\b(?:github\.)?rest\.actions\.(?:reRunWorkflowFailedJobs|rerunWorkflowFailedJobs)\s*\(/i, kind: 'rerun', label: 'actions.reRunWorkflowFailedJobs' },
  { pattern: /\b(?:github\.)?rest\.actions\.(?:reRunJobForWorkflowRun|rerunJobForWorkflowRun)\s*\(/i, kind: 'rerun', label: 'actions.reRunJobForWorkflowRun' },
  { pattern: /\b(?:github\.)?rest\.actions\.cancelWorkflowRun\s*\(/i, kind: 'cancel', label: 'actions.cancelWorkflowRun' },
  { pattern: /\b(?:github\.)?rest\.actions\.enableWorkflow\s*\(/i, kind: 'enable', label: 'actions.enableWorkflow' },
  { pattern: /\b(?:github\.)?rest\.actions\.disableWorkflow\s*\(/i, kind: 'disable', label: 'actions.disableWorkflow' },
  { pattern: /\b(?:github\.)?rest\.actions\.deleteWorkflowRunLogs\s*\(/i, kind: 'delete-logs', label: 'actions.deleteWorkflowRunLogs' },
];

const FIELD = /\b(workflow_id|workflowId|ref|run_id|runId|job_id|jobId|inputs)\b\s*:\s*((?:['"]?\$\{\{[\s\S]*?\}\}['"]?)|(?:[^,}\n]+))/gi;
const SECRET_EXPRESSION = /\$\{\{[\s\S]*?secrets\./i;
const ATTACKER_EXPRESSION = /\$\{\{[\s\S]*?(?:github\.event\.|github\.head_ref\b|inputs\.)/i;
const INDIRECT_EXPRESSION = /\$\{\{[\s\S]*?(?:steps\.|needs\.|matrix\.)/i;
const CONTEXT_ATTACKER = /\b(?:context|github\.context)\.payload\b|\b(?:pull_request|issue|comment|review|discussion)\b/i;
const PROCESS_ENV = /\bprocess\.env\.([A-Za-z_][A-Za-z0-9_]*)\b/g;
const SAFE_REF_EXPRESSION = /^['"]?\$\{\{\s*github\.(?:ref|ref_name)\s*\}\}['"]?$/i;
const SAFE_SHA_EXPRESSION = /^['"]?\$\{\{\s*github\.sha\s*\}\}['"]?$/i;
const LITERAL_WORKFLOW = /^['"][^'"\n]+\.ya?ml['"]$|^['"]?\d+['"]?$/i;
const LITERAL_RUN_ID = /^\d+$/;

function githubScript(step: WorkflowStepBlock): boolean {
  const identity = stepUsesIdentity(step);
  return identity?.owner?.toLowerCase() === 'actions'
    && identity.repository?.toLowerCase() === 'github-script';
}

function operation(step: WorkflowStepBlock): OperationSpec | undefined {
  return OPERATIONS.find(item => item.pattern.test(step.text));
}

function untrustedEnv(step: WorkflowStepBlock): Set<string> {
  const result = new Set<string>();
  for (const [name, value] of stepNestedMapping(step, 'env')) {
    if (ATTACKER_EXPRESSION.test(value) || hasUntrustedExpression(value)) result.add(name);
  }
  return result;
}

function secretEnv(step: WorkflowStepBlock): Set<string> {
  const result = new Set<string>();
  for (const [name, value] of stepNestedMapping(step, 'env')) {
    if (SECRET_EXPRESSION.test(value)) result.add(name);
  }
  return result;
}

function envReferences(value: string): Set<string> {
  const result = new Set<string>();
  const matcher = new RegExp(PROCESS_ENV.source, PROCESS_ENV.flags);
  let match: RegExpExecArray | null;
  while ((match = matcher.exec(value)) !== null) {
    const name = match[1];
    if (name) result.add(name);
  }
  return result;
}

function fieldKind(name: string): FieldKind {
  if (name === 'workflow_id' || name === 'workflowId') return 'workflow';
  if (name === 'ref') return 'ref';
  if (name === 'run_id' || name === 'runId' || name === 'job_id' || name === 'jobId') return 'run';
  if (name === 'inputs') return 'inputs';
  return 'other';
}

function parsedFields(step: WorkflowStepBlock): ParsedField[] {
  const untrustedNames = untrustedEnv(step);
  const secretNames = secretEnv(step);
  const result: ParsedField[] = [];
  const matcher = new RegExp(FIELD.source, FIELD.flags);
  let match: RegExpExecArray | null;
  while ((match = matcher.exec(step.text)) !== null) {
    const name = match[1] ?? 'unknown';
    const value = (match[2] ?? '').trim();
    const refs = envReferences(value);
    result.push({
      name,
      value,
      kind: fieldKind(name),
      untrusted: ATTACKER_EXPRESSION.test(value)
        || hasUntrustedExpression(value)
        || CONTEXT_ATTACKER.test(value)
        || [...refs].some(item => untrustedNames.has(item)),
      secret: SECRET_EXPRESSION.test(value) || [...refs].some(item => secretNames.has(item)),
      indirect: INDIRECT_EXPRESSION.test(value) || /\b(?:needs|steps|matrix)\./i.test(value),
    });
  }
  return result;
}

function signalFor(block: WorkflowJobBlock, step: WorkflowStepBlock): WorkflowControlMutationSignal | undefined {
  if (!githubScript(step)) return undefined;
  const spec = operation(step);
  if (!spec) return undefined;
  const fields = parsedFields(step);
  const trigger = workflowTriggerProfile(block.file);
  return {
    file: block.file.repositoryPath,
    job: block.name,
    step: stepDisplayName(step),
    line: firstWorkflowStepField(step, 'uses')?.line ?? step.startLine,
    mutation: spec.kind,
    operation: spec.label,
    fields: [...new Set(fields.map(item => item.name))].sort(),
    untrustedFields: [...new Set(fields.filter(item => item.untrusted).map(item => item.name))].sort(),
    secretFields: [...new Set(fields.filter(item => item.secret).map(item => item.name))].sort(),
    indirectSelectorFields: [...new Set(fields.filter(item => item.indirect && item.kind !== 'inputs').map(item => item.name))].sort(),
    writeAuthority: jobHasWriteAuthority(block),
    externalContribution: trigger.externalContribution,
  };
}

function finding(
  signal: WorkflowControlMutationSignal,
  id: string,
  severity: Finding['severity'],
  title: string,
  message: string,
  remediation: string,
  tags: readonly string[],
  blocking = false,
): Finding {
  return {
    id,
    domain: 'security',
    severity,
    ...(blocking ? { blocking: true } : {}),
    title,
    message,
    location: { file: signal.file, line: signal.line },
    evidence: {
      value: signal.operation,
      metadata: {
        job: signal.job,
        step: signal.step,
        mutation: signal.mutation,
        fields: signal.fields.join(','),
      },
    },
    remediation,
    tags,
  };
}

function targetFindings(step: WorkflowStepBlock, signal: WorkflowControlMutationSignal): Finding[] {
  const fields = parsedFields(step);
  const selectors = fields.filter(item => item.kind === 'workflow' || item.kind === 'run' || item.kind === 'ref');
  const untrusted = selectors.filter(item => item.untrusted);
  const results: Finding[] = [];
  if (untrusted.length > 0) {
    results.push(finding(
      signal,
      'ci-workflow-control-untrusted-target',
      'critical',
      'Workflow control mutation target is attacker-influenced',
      `Control selectors (${[...new Set(untrusted.map(item => item.name))].join(', ')}) can redirect privileged workflow execution/control toward an attacker-selected workflow, ref, run, or job.`,
      'Use literal workflow identities and trusted current-run/current-ref identifiers. Verify repository/workflow/ref identity before privileged dispatch, rerun, cancellation, or workflow-state mutation.',
      ['ci', 'workflow', 'control', 'target', 'provenance'],
      true,
    ));
  }

  const indirect = selectors.filter(item => item.indirect && !item.untrusted);
  if (indirect.length > 0) {
    results.push(finding(
      signal,
      'ci-workflow-control-indirect-target-review',
      'medium',
      'Workflow control target is inherited from an indirect output',
      `Selectors (${[...new Set(indirect.map(item => item.name))].join(', ')}) are forwarded from needs/steps/matrix output and need an explicit identity-binding review.`,
      'Resolve privileged workflow/run targets locally from a closed allowlist or validate the producer output against expected workflow/ref/run identity.',
      ['ci', 'workflow', 'control', 'target', 'review'],
      false,
    ));
  }
  return results;
}

function dispatchFindings(step: WorkflowStepBlock, signal: WorkflowControlMutationSignal): Finding[] {
  if (signal.mutation !== 'dispatch') return [];
  const fields = parsedFields(step);
  const results: Finding[] = [];
  const workflow = fields.find(item => item.kind === 'workflow');
  const ref = fields.find(item => item.kind === 'ref');
  const inputs = fields.find(item => item.kind === 'inputs');

  if (!workflow) {
    results.push(finding(
      signal,
      'ci-workflow-dispatch-missing-workflow-identity',
      'high',
      'Workflow dispatch mutation has no statically visible workflow identity',
      'A privileged dispatch should name the downstream workflow explicitly so review can bind authority to a known workflow contract.',
      'Use a literal workflow filename or numeric workflow id and keep it under repository review.',
      ['ci', 'workflow', 'dispatch', 'identity'],
      signal.writeAuthority,
    ));
  } else if (!workflow.untrusted && !workflow.indirect && !LITERAL_WORKFLOW.test(workflow.value)) {
    results.push(finding(
      signal,
      'ci-workflow-dispatch-dynamic-workflow-identity',
      'high',
      'Workflow dispatch uses a non-literal workflow identity',
      `workflow_id value '${workflow.value}' is not a reviewed literal workflow filename/id.`,
      'Use a literal workflow filename or numeric workflow id.',
      ['ci', 'workflow', 'dispatch', 'identity'],
      signal.writeAuthority,
    ));
  }

  if (!ref) {
    results.push(finding(
      signal,
      'ci-workflow-dispatch-missing-ref-binding',
      'high',
      'Workflow dispatch does not expose an explicit ref binding',
      'A downstream privileged workflow should run on a reviewed ref rather than an implicit or opaque target.',
      'Pass a literal trusted branch/tag or the current trusted github.ref/ref_name after event-boundary validation.',
      ['ci', 'workflow', 'dispatch', 'ref'],
      signal.writeAuthority,
    ));
  } else if (!ref.untrusted && !ref.indirect && !SAFE_REF_EXPRESSION.test(ref.value) && !SAFE_SHA_EXPRESSION.test(ref.value) && !/^['"][A-Za-z0-9._\/-]+['"]$/.test(ref.value)) {
    results.push(finding(
      signal,
      'ci-workflow-dispatch-opaque-ref',
      'high',
      'Workflow dispatch ref is not a canonical trusted selector',
      `Dispatch ref '${ref.value}' is neither a reviewed literal ref nor the current workflow ref/sha.`,
      'Use a literal reviewed ref or the current trusted github.ref/ref_name.',
      ['ci', 'workflow', 'dispatch', 'ref', 'canonicalization'],
      signal.writeAuthority,
    ));
  }

  if (inputs?.secret) {
    results.push(finding(
      signal,
      'ci-workflow-dispatch-secret-input',
      'critical',
      'Workflow dispatch forwards secret-derived data through ordinary inputs',
      'workflow_dispatch inputs are ordinary event payload data and should not be used as a secret transport channel.',
      'Use the downstream workflow secret contract or another explicitly protected credential channel instead of dispatch inputs.',
      ['ci', 'workflow', 'dispatch', 'input', 'secret'],
      true,
    ));
  }
  if (inputs?.untrusted) {
    results.push(finding(
      signal,
      'ci-workflow-dispatch-untrusted-input',
      signal.writeAuthority || signal.externalContribution ? 'critical' : 'high',
      'Workflow dispatch forwards attacker-influenced input data',
      'External event or free-form input content is forwarded into another workflow execution boundary where it can acquire different authority.',
      'Define a closed downstream input schema, sanitize/allowlist values before dispatch, and keep privileged workflow behavior independent of untrusted free-form fields.',
      ['ci', 'workflow', 'dispatch', 'input', 'provenance'],
      signal.writeAuthority || signal.externalContribution,
    ));
  }
  return results;
}

function runSelectorFindings(step: WorkflowStepBlock, signal: WorkflowControlMutationSignal): Finding[] {
  if (signal.mutation !== 'rerun' && signal.mutation !== 'cancel' && signal.mutation !== 'delete-logs') return [];
  const run = parsedFields(step).find(item => item.kind === 'run');
  if (!run) {
    return [finding(
      signal,
      'ci-workflow-control-missing-run-binding',
      'high',
      'Workflow run mutation has no statically visible run/job identity',
      'Privileged rerun/cancel/log-deletion authority should be visibly bound to a known current or verified run identity.',
      'Pass a trusted current/verified run_id or job_id and validate its repository/workflow/event identity before mutation.',
      ['ci', 'workflow', 'control', 'run'],
      signal.writeAuthority,
    )];
  }
  if (!run.untrusted && !run.indirect && !LITERAL_RUN_ID.test(run.value) && !/github\.run_id\b/i.test(run.value)) {
    return [finding(
      signal,
      'ci-workflow-control-opaque-run-selector',
      'high',
      'Workflow run mutation uses an opaque run/job selector',
      `Run selector '${run.value}' is not a literal id, current github.run_id, or reviewed producer output.`,
      'Bind run mutations to the current run or a separately verified run identity.',
      ['ci', 'workflow', 'control', 'run', 'canonicalization'],
      signal.writeAuthority,
    )];
  }
  return [];
}

function externalAuthorityFindings(signal: WorkflowControlMutationSignal): Finding[] {
  if (!signal.externalContribution || !signal.writeAuthority) return [];
  return [finding(
    signal,
    'ci-workflow-control-external-write-authority',
    'critical',
    'External contribution workflow can mutate workflow execution state',
    'A contribution-controlled trigger reaches GitHub write authority capable of dispatching, rerunning, cancelling, enabling, disabling, or deleting workflow-run evidence.',
    'Keep external-contribution workflows read-only. Perform workflow-control mutations only in a trusted follow-up workflow after validating producer repository, event, workflow, ref, conclusion, and immutable commit identity.',
    ['ci', 'workflow', 'control', 'external-event', 'authority'],
    true,
  )];
}

function analyze(block: WorkflowJobBlock, step: WorkflowStepBlock): { signal: WorkflowControlMutationSignal; findings: Finding[] } | undefined {
  const signal = signalFor(block, step);
  if (!signal) return undefined;
  return {
    signal,
    findings: [
      ...targetFindings(step, signal),
      ...dispatchFindings(step, signal),
      ...runSelectorFindings(step, signal),
      ...externalAuthorityFindings(signal),
    ],
  };
}

export function auditWorkflowControlMutations(
  inventory: RepositoryInventory,
): AuditSection<WorkflowControlMutationSummary> {
  const started = performance.now();
  const files = workflowFiles(inventory);
  const results = files.flatMap(file => workflowJobBlocks(file)
    .flatMap(block => workflowStepBlocks(block)
      .map(step => analyze(block, step))
      .filter((item): item is { signal: WorkflowControlMutationSignal; findings: Finding[] } => item !== undefined)));
  const signals = results.map(item => item.signal);
  const findings = stableSortFindings(results.flatMap(item => item.findings));
  return {
    domain: 'security',
    title: 'GitHub workflow-control mutation provenance audit',
    summary: {
      workflowFiles: files.length,
      mutations: signals.length,
      dispatches: signals.filter(item => item.mutation === 'dispatch').length,
      runMutations: signals.filter(item => item.mutation === 'rerun' || item.mutation === 'cancel' || item.mutation === 'delete-logs').length,
      workflowStateMutations: signals.filter(item => item.mutation === 'enable' || item.mutation === 'disable').length,
      untrustedMutations: signals.filter(item => item.untrustedFields.length > 0).length,
      secretBearingMutations: signals.filter(item => item.secretFields.length > 0).length,
      signals,
      findings,
    },
    findings,
    elapsedMs: Math.max(0, performance.now() - started),
  };
}
