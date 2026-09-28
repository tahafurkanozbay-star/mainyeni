import {
  stableSortFindings,
  type AuditSection,
  type Finding,
  type RepositoryInventory,
} from './contracts.mts';
import {
  expressionSources,
  fieldWithContinuation,
  firstWorkflowField,
  hasExpression,
  hasUntrustedExpression,
  jobHasSecrets,
  jobHasWriteAuthority,
  workflowFiles,
  workflowJobBlocks,
  workflowTriggerProfile,
  type WorkflowJobBlock,
} from './workflow-structure.mts';

export interface RunnerBoundarySignal {
  readonly file: string;
  readonly job: string;
  readonly runsOn: string;
  readonly selfHosted: boolean;
  readonly dynamic: boolean;
  readonly untrustedDynamic: boolean;
  readonly mutableHostedImage: boolean;
  readonly hasTimeout: boolean;
  readonly hasConcurrency: boolean;
  readonly externalTrigger: boolean;
  readonly writeAuthority: boolean;
  readonly secrets: boolean;
}

export interface RunnerBoundarySummary {
  readonly workflowFiles: number;
  readonly jobs: number;
  readonly selfHostedJobs: number;
  readonly dynamicRunnerJobs: number;
  readonly externalSelfHostedJobs: number;
  readonly signals: readonly RunnerBoundarySignal[];
  readonly findings: readonly Finding[];
}

const SELF_HOSTED = /(?:^|[\s,\[])self-hosted(?:$|[\s,\]])/i;
const HOSTED_LATEST = /\b(?:ubuntu|windows|macos)-latest\b/i;
const TIMEOUT = /^\s*timeout-minutes\s*:/im;
const JOB_CONCURRENCY = /^\s*concurrency\s*:/im;
const WORKFLOW_CONCURRENCY = /^\s{0,2}concurrency\s*:/im;

function signal(block: WorkflowJobBlock): RunnerBoundarySignal | undefined {
  const field = firstWorkflowField(block, 'runs-on');
  if (!field) return undefined;
  const runsOn = fieldWithContinuation(block, 'runs-on') || field.value;
  const triggers = workflowTriggerProfile(block.file);
  return {
    file: block.file.repositoryPath,
    job: block.name,
    runsOn,
    selfHosted: SELF_HOSTED.test(runsOn),
    dynamic: hasExpression(runsOn),
    untrustedDynamic: hasUntrustedExpression(runsOn),
    mutableHostedImage: HOSTED_LATEST.test(runsOn),
    hasTimeout: TIMEOUT.test(block.text),
    hasConcurrency: JOB_CONCURRENCY.test(block.text) || WORKFLOW_CONCURRENCY.test(block.file.text),
    externalTrigger: triggers.externalContribution,
    writeAuthority: jobHasWriteAuthority(block),
    secrets: jobHasSecrets(block),
  };
}

function findingLocation(block: WorkflowJobBlock) {
  const field = firstWorkflowField(block, 'runs-on');
  return { file: block.file.repositoryPath, line: field?.line ?? block.startLine };
}

function runnerFindings(block: WorkflowJobBlock): Finding[] {
  const current = signal(block);
  if (!current) return [];
  const findings: Finding[] = [];
  const location = findingLocation(block);
  const sources = expressionSources(current.runsOn);

  if (current.untrustedDynamic) {
    findings.push({
      id: 'ci-runner-untrusted-selection',
      domain: 'security',
      severity: 'critical',
      blocking: true,
      title: 'Runner identity is selected from untrusted workflow data',
      message: `Job ${block.name} constructs runs-on from attacker- or caller-controlled data (${sources.join(', ') || 'expression'}). Runner selection is an executable trust boundary.`,
      location,
      evidence: { value: current.runsOn },
      remediation: 'Map validated inputs to a closed set of literal runner labels in trusted workflow code. Never pass event text, refs, or free-form inputs directly to runs-on.',
      tags: ['ci', 'runner', 'self-hosted', 'expression-injection'],
    });
  } else if (current.dynamic) {
    findings.push({
      id: 'ci-runner-dynamic-selection-review',
      domain: 'security',
      severity: 'high',
      title: 'Runner identity is dynamically selected',
      message: `Job ${block.name} uses an expression-derived runner identity. Even trusted matrix or needs outputs can redirect execution to a different runner trust zone.`,
      location,
      evidence: { value: current.runsOn },
      remediation: 'Prefer literal runner labels. If matrix selection is required, define the matrix in reviewed workflow source and constrain it to an explicit allowlist.',
      tags: ['ci', 'runner', 'matrix', 'trust-boundary'],
    });
  }

  if (current.selfHosted && current.externalTrigger) {
    findings.push({
      id: 'ci-self-hosted-external-trigger',
      domain: 'security',
      severity: 'critical',
      blocking: true,
      title: 'Externally influenced workflow executes on a self-hosted runner',
      message: `Job ${block.name} can be reached from contribution-controlled events while running on self-hosted infrastructure. Untrusted code can persist on or pivot through the runner host.`,
      location,
      evidence: { value: current.runsOn },
      remediation: 'Run untrusted pull-request and discussion/issue-triggered workloads on isolated ephemeral hosted runners. Reserve self-hosted runners for trusted refs and protected environments.',
      tags: ['ci', 'runner', 'self-hosted', 'untrusted-code'],
    });
  }

  if (current.selfHosted && current.externalTrigger && current.writeAuthority) {
    findings.push({
      id: 'ci-self-hosted-external-write-authority',
      domain: 'security',
      severity: 'critical',
      blocking: true,
      title: 'External self-hosted job also has write-capable token authority',
      message: `Job ${block.name} combines a self-hosted runner, externally influenced trigger, and write permission. Compromise can escape the runner and mutate repository resources.`,
      location,
      remediation: 'Split privileged mutation into a trusted follow-up workflow. Keep external validation read-only and isolated from persistent runners.',
      tags: ['ci', 'runner', 'self-hosted', 'token', 'least-privilege'],
    });
  }

  if (current.selfHosted && current.externalTrigger && current.secrets) {
    findings.push({
      id: 'ci-self-hosted-external-secret-exposure',
      domain: 'security',
      severity: 'critical',
      blocking: true,
      title: 'External self-hosted job references repository secrets',
      message: `Job ${block.name} exposes a secret-bearing execution context to a contribution-controlled trigger on persistent infrastructure.`,
      location,
      remediation: 'Remove secrets from external validation. Use environment-protected trusted deployment jobs that never execute untrusted contribution code.',
      tags: ['ci', 'runner', 'self-hosted', 'secrets'],
    });
  }

  if (current.selfHosted && !current.hasTimeout) {
    findings.push({
      id: 'ci-self-hosted-timeout-missing',
      domain: 'security',
      severity: current.externalTrigger ? 'high' : 'medium',
      title: 'Self-hosted job has no execution timeout',
      message: `Job ${block.name} can occupy persistent runner capacity indefinitely if a command stalls or is intentionally held open.`,
      location,
      remediation: 'Set an explicit timeout-minutes value sized to the expected workload, and keep long-running deployment orchestration outside runner-critical sections.',
      tags: ['ci', 'runner', 'availability', 'resource-governance'],
    });
  }

  if (current.selfHosted && !current.hasConcurrency) {
    findings.push({
      id: 'ci-self-hosted-concurrency-missing',
      domain: 'performance',
      severity: current.externalTrigger ? 'high' : 'medium',
      title: 'Self-hosted workflow lacks concurrency control',
      message: `Job ${block.name} can enqueue overlapping executions against scarce persistent runner capacity.`,
      location,
      remediation: 'Define a bounded concurrency group with cancel-in-progress where safe, or use an explicit serialized deployment queue.',
      tags: ['ci', 'runner', 'concurrency', 'availability'],
    });
  }

  if (current.mutableHostedImage) {
    findings.push({
      id: 'ci-hosted-runner-latest-image',
      domain: 'build',
      severity: 'low',
      title: 'Workflow uses a moving hosted-runner image label',
      message: `Job ${block.name} uses ${current.runsOn}; the toolchain image can change without a repository diff.`,
      location,
      evidence: { value: current.runsOn },
      remediation: 'For release-critical jobs, prefer a versioned hosted image label such as ubuntu-24.04 and pin toolchains independently.',
      tags: ['ci', 'runner', 'reproducibility'],
    });
  }

  return findings;
}

export function auditRunnerBoundaries(inventory: RepositoryInventory): AuditSection<RunnerBoundarySummary> {
  const started = performance.now();
  const files = workflowFiles(inventory);
  const jobs = files.flatMap(file => workflowJobBlocks(file));
  const signals = jobs.map(signal).filter((item): item is RunnerBoundarySignal => item !== undefined);
  const findings = stableSortFindings(jobs.flatMap(runnerFindings));
  return {
    domain: 'security',
    title: 'CI runner identity and self-hosted trust-boundary audit',
    summary: {
      workflowFiles: files.length,
      jobs: signals.length,
      selfHostedJobs: signals.filter(item => item.selfHosted).length,
      dynamicRunnerJobs: signals.filter(item => item.dynamic).length,
      externalSelfHostedJobs: signals.filter(item => item.selfHosted && item.externalTrigger).length,
      signals,
      findings,
    },
    findings,
    elapsedMs: Math.max(0, performance.now() - started),
  };
}
