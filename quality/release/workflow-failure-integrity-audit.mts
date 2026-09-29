import {
  stableSortFindings,
  type AuditSection,
  type Finding,
  type RepositoryInventory,
} from './contracts.mts';
import {
  firstWorkflowField,
  hasExpression,
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
  stepRunText,
  workflowStepBlocks,
  type WorkflowStepBlock,
} from './workflow-step-structure.mts';

export type FailureMaskScope = 'job' | 'step' | 'shell';
export type FailureMaskKind =
  | 'continue-on-error'
  | 'errexit-disabled'
  | 'shell-failure-swallow'
  | 'powershell-error-continue';

export interface WorkflowFailureIntegritySignal {
  readonly file: string;
  readonly job: string;
  readonly step: string | null;
  readonly scope: FailureMaskScope;
  readonly kind: FailureMaskKind;
  readonly line: number;
  readonly value: string;
  readonly gateLike: boolean;
  readonly privileged: boolean;
  readonly externalContribution: boolean;
  readonly dynamic: boolean;
}

export interface WorkflowFailureIntegritySummary {
  readonly workflowFiles: number;
  readonly jobs: number;
  readonly runSteps: number;
  readonly gateLikeSteps: number;
  readonly failureMaskSignals: number;
  readonly gateMaskSignals: number;
  readonly privilegedMaskSignals: number;
  readonly signals: readonly WorkflowFailureIntegritySignal[];
  readonly findings: readonly Finding[];
}

const TRUE = /^true$/i;
const FALSE = /^false$/i;
const GATE_WORD = /(?:^|[^a-z0-9])(?:test|tests|lint|typecheck|type-check|build|audit|scan|security|verify|verification|validate|validation|quality|regression|smoke|coverage|check|checks)(?:[^a-z0-9]|$)/i;
const SET_PLUS_E = /(?:^|\n)\s*set\s+\+e(?:\s|$)/i;
const SET_PLUS_ERREXIT = /(?:^|\n)\s*set\s+\+o\s+errexit(?:\s|$)/i;
const SHELL_SWALLOW = /(?:\|\|\s*(?:true\b|:\s*(?:$|[;#\n])|echo\b|printf\b))|(?:\b(?:true|:)\s*;\s*#?\s*(?:ignore|allow|non[- ]blocking|best[- ]effort))/im;
const POWERSHELL_CONTINUE = /\$ErrorActionPreference\s*=\s*['"](?:Continue|SilentlyContinue)['"]|-ErrorAction\s+(?:Continue|SilentlyContinue)\b/i;

function privileged(block: WorkflowJobBlock): boolean {
  return jobHasWriteAuthority(block) || jobHasSecrets(block) || jobUsesProtectedEnvironment(block);
}

function gateLikeStep(step: WorkflowStepBlock): boolean {
  const name = stepDisplayName(step);
  const run = stepRunText(step);
  const uses = firstWorkflowStepField(step, 'uses')?.value ?? '';
  return GATE_WORD.test(`${name}\n${run}\n${uses}`);
}

function gateLikeJob(block: WorkflowJobBlock): boolean {
  if (GATE_WORD.test(block.name)) return true;
  return workflowStepBlocks(block).some(gateLikeStep);
}

function signal(
  block: WorkflowJobBlock,
  step: WorkflowStepBlock | undefined,
  scope: FailureMaskScope,
  kind: FailureMaskKind,
  line: number,
  value: string,
  gateLike: boolean,
  dynamic = false,
): WorkflowFailureIntegritySignal {
  return {
    file: block.file.repositoryPath,
    job: block.name,
    step: step ? stepDisplayName(step) : null,
    scope,
    kind,
    line,
    value,
    gateLike,
    privileged: privileged(block),
    externalContribution: workflowTriggerProfile(block.file).externalContribution,
    dynamic,
  };
}

function continueSignals(block: WorkflowJobBlock): WorkflowFailureIntegritySignal[] {
  const signals: WorkflowFailureIntegritySignal[] = [];
  const jobField = firstWorkflowField(block, 'continue-on-error');
  if (jobField && !FALSE.test(jobField.value)) {
    signals.push(signal(
      block,
      undefined,
      'job',
      'continue-on-error',
      jobField.line,
      jobField.value,
      gateLikeJob(block),
      hasExpression(jobField.value),
    ));
  }

  for (const step of workflowStepBlocks(block)) {
    const field = firstWorkflowStepField(step, 'continue-on-error');
    if (!field || FALSE.test(field.value)) continue;
    signals.push(signal(
      block,
      step,
      'step',
      'continue-on-error',
      field.line,
      field.value,
      gateLikeStep(step),
      hasExpression(field.value),
    ));
  }
  return signals;
}

function shellSignals(block: WorkflowJobBlock): WorkflowFailureIntegritySignal[] {
  const result: WorkflowFailureIntegritySignal[] = [];
  for (const step of workflowStepBlocks(block)) {
    const runField = firstWorkflowStepField(step, 'run');
    if (!runField) continue;
    const run = stepRunText(step);
    const gateLike = gateLikeStep(step);
    if (SET_PLUS_E.test(run) || SET_PLUS_ERREXIT.test(run)) {
      result.push(signal(block, step, 'shell', 'errexit-disabled', runField.line, 'set +e / set +o errexit', gateLike));
    }
    if (SHELL_SWALLOW.test(run)) {
      result.push(signal(block, step, 'shell', 'shell-failure-swallow', runField.line, 'shell command failure is converted to success', gateLike));
    }
    if (POWERSHELL_CONTINUE.test(run)) {
      result.push(signal(block, step, 'shell', 'powershell-error-continue', runField.line, 'PowerShell non-terminating error policy', gateLike));
    }
  }
  return result;
}

function location(item: WorkflowFailureIntegritySignal) {
  return { file: item.file, line: item.line };
}

function finding(
  item: WorkflowFailureIntegritySignal,
  id: string,
  severity: Finding['severity'],
  title: string,
  message: string,
  remediation: string,
  blocking = false,
): Finding {
  return {
    id,
    domain: 'testing',
    severity,
    ...(blocking ? { blocking: true } : {}),
    title,
    message,
    location: location(item),
    evidence: {
      value: item.value,
      metadata: {
        job: item.job,
        step: item.step ?? 'job',
        scope: item.scope,
        kind: item.kind,
        gateLike: item.gateLike,
        privileged: item.privileged,
        externalContribution: item.externalContribution,
        dynamic: item.dynamic,
      },
    },
    remediation,
    tags: ['ci', 'failure-semantics', 'release-gate', 'regression', 'fail-closed'],
  };
}

function findingsFor(item: WorkflowFailureIntegritySignal): Finding[] {
  const highImpact = item.gateLike || item.privileged || item.externalContribution;
  const critical = item.gateLike && (item.privileged || item.externalContribution || item.scope === 'job');

  if (item.kind === 'continue-on-error') {
    if (item.dynamic) {
      return [finding(
        item,
        'ci-failure-dynamic-continue-policy',
        highImpact ? 'high' : 'medium',
        'Workflow failure propagation is expression-controlled',
        `${item.scope === 'job' ? `Job ${item.job}` : `Step ${item.step ?? 'unknown'} in job ${item.job}`} derives continue-on-error from an expression. Runtime/event/input data can therefore decide whether a failed command is allowed to keep the workflow green.`,
        'Use literal continue-on-error: false for release gates. If optional diagnostics are required, isolate them in a clearly non-gating job and keep gate jobs fail-closed.',
        critical,
      )];
    }

    if (TRUE.test(item.value)) {
      const severity: Finding['severity'] = critical ? 'critical' : highImpact ? 'high' : 'medium';
      return [finding(
        item,
        item.gateLike ? 'ci-failure-gate-continue-on-error' : 'ci-failure-continue-on-error',
        severity,
        item.gateLike ? 'Validation gate explicitly ignores failure' : 'Workflow step or job explicitly ignores failure',
        item.gateLike
          ? `${item.scope === 'job' ? `Job ${item.job}` : `Step ${item.step ?? 'unknown'} in job ${item.job}`} is validation-like but sets continue-on-error: true. A failing test, build, lint, audit, scan or verification command can stop enforcing the release gate.`
          : `${item.scope === 'job' ? `Job ${item.job}` : `Step ${item.step ?? 'unknown'} in job ${item.job}`} sets continue-on-error: true, so its failure is intentionally converted into a non-blocking outcome.`,
        item.gateLike
          ? 'Remove continue-on-error from validation/release gates. Put optional diagnostics in a separate non-required job that cannot publish, deploy, sign or mutate repository state.'
          : 'Confirm this step is genuinely best-effort. Prefer an isolated diagnostics job with explicit non-gating semantics instead of weakening failure propagation inline.',
        item.gateLike,
      )];
    }

    return [finding(
      item,
      'ci-failure-ambiguous-continue-policy',
      highImpact ? 'high' : 'medium',
      'Workflow uses a non-boolean continue-on-error value',
      `Failure propagation for ${item.scope === 'job' ? `job ${item.job}` : `step ${item.step ?? 'unknown'}`} is configured as ${item.value || '<empty>'}, which is not an explicit literal false policy.`,
      'Use continue-on-error: false or remove the field. Keep optional diagnostics separate from required validation and release authority.',
      critical,
    )];
  }

  if (item.kind === 'errexit-disabled') {
    return [finding(
      item,
      'ci-failure-errexit-disabled',
      item.gateLike ? 'critical' : highImpact ? 'high' : 'medium',
      'Run script disables fail-fast shell error handling',
      `Step ${item.step ?? 'unknown'} in job ${item.job} disables errexit. Subsequent command failures can be ignored unless every command is checked manually, which is unsafe for validation and release gates.`,
      'Keep the runner fail-fast shell contract enabled. For an expected individual failure, handle only that command explicitly and immediately validate its exit status.',
      item.gateLike,
    )];
  }

  if (item.kind === 'powershell-error-continue') {
    return [finding(
      item,
      'ci-failure-powershell-continue',
      item.gateLike ? 'critical' : highImpact ? 'high' : 'medium',
      'PowerShell step weakens error propagation',
      `Step ${item.step ?? 'unknown'} in job ${item.job} configures Continue/SilentlyContinue error behavior. Validation commands can emit errors without failing the gate.`,
      "Use $ErrorActionPreference = 'Stop' for required validation. Apply -ErrorAction only to narrowly scoped expected failures and assert the resulting state explicitly.",
      item.gateLike,
    )];
  }

  return [finding(
    item,
    'ci-failure-shell-swallow',
    item.gateLike ? 'critical' : highImpact ? 'high' : 'medium',
    item.gateLike ? 'Validation command failure is swallowed by shell fallback' : 'Shell fallback converts command failure into success',
    `Step ${item.step ?? 'unknown'} in job ${item.job} contains a shell fallback such as || true/:/echo that can replace a failing command status with success.`,
    item.gateLike
      ? 'Remove failure-swallowing fallbacks from tests, builds, audits, scans, lint/typecheck and release verification. Capture output separately while preserving the original non-zero exit status.'
      : 'Limit best-effort fallbacks to cleanup/diagnostics that are explicitly non-gating. Preserve failures for any command that protects build, security, publication or deployment integrity.',
    item.gateLike,
  )];
}

export function auditWorkflowFailureIntegrity(
  inventory: RepositoryInventory,
): AuditSection<WorkflowFailureIntegritySummary> {
  const started = performance.now();
  const files = workflowFiles(inventory);
  const jobs = files.flatMap(file => workflowJobBlocks(file));
  const steps = jobs.flatMap(block => workflowStepBlocks(block));
  const signals = jobs.flatMap(block => [...continueSignals(block), ...shellSignals(block)]);
  const findings = stableSortFindings(signals.flatMap(findingsFor));
  return {
    domain: 'testing',
    title: 'Workflow failure propagation and release-gate integrity audit',
    summary: {
      workflowFiles: files.length,
      jobs: jobs.length,
      runSteps: steps.filter(step => firstWorkflowStepField(step, 'run')).length,
      gateLikeSteps: steps.filter(gateLikeStep).length,
      failureMaskSignals: signals.length,
      gateMaskSignals: signals.filter(item => item.gateLike).length,
      privilegedMaskSignals: signals.filter(item => item.privileged).length,
      signals,
      findings,
    },
    findings,
    elapsedMs: Math.max(0, performance.now() - started),
  };
}
