import {
  stableSortFindings,
  type AuditSection,
  type Finding,
  type RepositoryInventory,
} from './contracts.mts';
import {
  expressionSources,
  firstWorkflowField,
  hasExpression,
  hasUntrustedExpression,
  jobHasSecrets,
  jobHasWriteAuthority,
  jobUsesProtectedEnvironment,
  workflowFieldBlockText,
  workflowFiles,
  workflowJobBlocks,
  workflowTopLevelBlock,
  workflowTriggerProfile,
  type WorkflowJobBlock,
} from './workflow-structure.mts';

export interface ConcurrencyBoundarySignal {
  readonly file: string;
  readonly scope: 'workflow' | 'job';
  readonly job?: string;
  readonly group: string;
  readonly cancelInProgress: string;
  readonly dynamicGroup: boolean;
  readonly untrustedGroup: boolean;
  readonly dynamicCancellation: boolean;
  readonly untrustedCancellation: boolean;
  readonly externalContribution: boolean;
  readonly privileged: boolean;
  readonly protectedEnvironment: boolean;
}

export interface ConcurrencyBoundarySummary {
  readonly workflowFiles: number;
  readonly scopes: number;
  readonly dynamicGroups: number;
  readonly untrustedGroups: number;
  readonly privilegedExternalJobsWithoutConcurrency: number;
  readonly signals: readonly ConcurrencyBoundarySignal[];
  readonly findings: readonly Finding[];
}

interface ConcurrencySpec {
  readonly group: string;
  readonly cancelInProgress: string;
  readonly line: number;
}

const GROUP_KEY = /^\s*group\s*:\s*(.*)$/i;
const CANCEL_KEY = /^\s*cancel-in-progress\s*:\s*(.*)$/i;
const TRUE = /^(?:true|yes|on)$/i;
const FALSE = /^(?:false|no|off)$/i;
const REF_DISCRIMINATOR = /(?:github\.(?:ref|ref_name|head_ref)|github\.event\.pull_request\.(?:number|head\.sha)|github\.run_id)/i;
const WORKFLOW_DISCRIMINATOR = /github\.workflow\b/i;
const ENVIRONMENT_DISCRIMINATOR = /(?:environment|deploy|production|staging)/i;

function clean(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function mappingValue(text: string, matcher: RegExp): string {
  for (const raw of text.split(/\r?\n/u)) {
    const match = raw.match(matcher);
    if (match) return clean(match[1] ?? '');
  }
  return '';
}

function workflowSpec(file: ReturnType<typeof workflowFiles>[number]): ConcurrencySpec | undefined {
  const block = workflowTopLevelBlock(file, 'concurrency');
  if (!block) return undefined;
  if (block.value) {
    return { group: clean(block.value), cancelInProgress: '', line: block.line.line };
  }
  return {
    group: mappingValue(block.text, GROUP_KEY),
    cancelInProgress: mappingValue(block.text, CANCEL_KEY),
    line: block.line.line,
  };
}

function jobSpec(block: WorkflowJobBlock): ConcurrencySpec | undefined {
  const field = firstWorkflowField(block, 'concurrency');
  if (!field) return undefined;
  if (field.value) {
    return { group: clean(field.value), cancelInProgress: '', line: field.line };
  }
  const text = workflowFieldBlockText(block, 'concurrency');
  return {
    group: mappingValue(text, GROUP_KEY),
    cancelInProgress: mappingValue(text, CANCEL_KEY),
    line: field.line,
  };
}

function signalFor(
  block: WorkflowJobBlock,
  scope: 'workflow' | 'job',
  spec: ConcurrencySpec,
): ConcurrencyBoundarySignal {
  const trigger = workflowTriggerProfile(block.file);
  const privileged = jobHasWriteAuthority(block) || jobHasSecrets(block) || jobUsesProtectedEnvironment(block);
  return {
    file: block.file.repositoryPath,
    scope,
    ...(scope === 'job' ? { job: block.name } : {}),
    group: spec.group,
    cancelInProgress: spec.cancelInProgress,
    dynamicGroup: hasExpression(spec.group),
    untrustedGroup: hasUntrustedExpression(spec.group),
    dynamicCancellation: hasExpression(spec.cancelInProgress),
    untrustedCancellation: hasUntrustedExpression(spec.cancelInProgress),
    externalContribution: trigger.externalContribution,
    privileged,
    protectedEnvironment: jobUsesProtectedEnvironment(block),
  };
}

function location(block: WorkflowJobBlock, spec: ConcurrencySpec) {
  return { file: block.file.repositoryPath, line: spec.line || block.startLine };
}

function groupFindings(block: WorkflowJobBlock, signal: ConcurrencyBoundarySignal, spec: ConcurrencySpec): Finding[] {
  const findings: Finding[] = [];
  const where = location(block, spec);
  const sources = expressionSources(signal.group);

  if (!signal.group) {
    findings.push({
      id: 'ci-concurrency-group-empty',
      domain: 'security',
      severity: signal.privileged ? 'high' : 'medium',
      title: 'Concurrency block does not define a stable group',
      message: `${signal.scope === 'job' ? `Job ${block.name}` : 'Workflow'} declares concurrency without a usable group identity. Cancellation and serialization behavior cannot be reasoned about deterministically.`,
      location: where,
      remediation: 'Define an explicit bounded concurrency group derived only from trusted workflow/ref identifiers.',
      tags: ['ci', 'concurrency', 'availability', 'determinism'],
    });
    return findings;
  }

  if (signal.untrustedGroup) {
    const cancel = TRUE.test(signal.cancelInProgress) || signal.dynamicCancellation;
    findings.push({
      id: 'ci-concurrency-untrusted-group',
      domain: 'security',
      severity: cancel ? 'critical' : 'high',
      ...(cancel ? { blocking: true } : {}),
      title: 'Concurrency group identity is controlled by untrusted workflow data',
      message: `${signal.scope === 'job' ? `Job ${block.name}` : 'Workflow'} derives its concurrency group from ${sources.join(', ') || 'untrusted expression data'}. An attacker can force collisions with other executions${cancel ? ' and trigger cancellation of trusted work' : ''}.`,
      location: where,
      evidence: { value: signal.group },
      remediation: 'Build concurrency groups only from trusted github.workflow plus immutable or repository-owned ref/run identifiers. Never use event titles, comments, free-form inputs, or client payload fields.',
      tags: ['ci', 'concurrency', 'denial-of-service', 'expression-injection'],
    });
  } else if (signal.dynamicGroup && signal.externalContribution && !REF_DISCRIMINATOR.test(signal.group)) {
    findings.push({
      id: 'ci-concurrency-external-group-provenance',
      domain: 'security',
      severity: 'medium',
      title: 'External workflow concurrency group lacks a per-ref discriminator',
      message: `${signal.scope === 'job' ? `Job ${block.name}` : 'Workflow'} uses a dynamic group for contribution-triggered work without a visible trusted ref/run discriminator. Independent contributions can collide unnecessarily.`,
      location: where,
      evidence: { value: signal.group },
      remediation: 'Include a trusted ref, pull-request number, immutable SHA, or run identity in the concurrency key while retaining a repository-owned workflow prefix.',
      tags: ['ci', 'concurrency', 'availability', 'pull-request'],
    });
  }

  if (!hasExpression(signal.group) && signal.externalContribution && signal.cancelInProgress && TRUE.test(signal.cancelInProgress)) {
    findings.push({
      id: 'ci-concurrency-static-cancel-collision',
      domain: 'security',
      severity: signal.privileged ? 'high' : 'medium',
      title: 'External runs share a static cancellation group',
      message: `${signal.scope === 'job' ? `Job ${block.name}` : 'Workflow'} uses the literal group "${signal.group}" with cancel-in-progress enabled. Any contribution can cancel unrelated executions sharing that group.`,
      location: where,
      remediation: 'Partition the concurrency group by trusted workflow and ref/PR identity before enabling cancellation.',
      tags: ['ci', 'concurrency', 'denial-of-service', 'pull-request'],
    });
  }

  if (!hasExpression(signal.group) && !WORKFLOW_DISCRIMINATOR.test(signal.group) && signal.scope === 'workflow' && signal.privileged) {
    findings.push({
      id: 'ci-concurrency-privileged-global-group-review',
      domain: 'security',
      severity: 'medium',
      title: 'Privileged workflow uses a repository-global literal concurrency group',
      message: `Privileged workflow concurrency group "${signal.group}" is not namespaced by workflow/ref identity. Future jobs or workflows can accidentally share the same serialization boundary.`,
      location: where,
      remediation: 'Namespace privileged groups with a stable workflow identifier and, where safe, a trusted deployment/ref dimension.',
      tags: ['ci', 'concurrency', 'deployment', 'reliability'],
    });
  }

  return findings;
}

function cancellationFindings(block: WorkflowJobBlock, signal: ConcurrencyBoundarySignal, spec: ConcurrencySpec): Finding[] {
  if (!signal.cancelInProgress) return [];
  const findings: Finding[] = [];
  const where = location(block, spec);

  if (signal.untrustedCancellation) {
    findings.push({
      id: 'ci-concurrency-untrusted-cancellation-policy',
      domain: 'security',
      severity: 'critical',
      blocking: true,
      title: 'Untrusted data controls whether in-flight work is cancelled',
      message: `${signal.scope === 'job' ? `Job ${block.name}` : 'Workflow'} derives cancel-in-progress from contribution-controlled data. Attackers can change availability and serialization semantics without source review.`,
      location: where,
      evidence: { value: signal.cancelInProgress },
      remediation: 'Use a literal cancellation policy or a trusted repository-owned expression. Never source cancellation policy from event text, inputs, or client payload.',
      tags: ['ci', 'concurrency', 'denial-of-service', 'expression-injection'],
    });
  }

  if (signal.protectedEnvironment && TRUE.test(signal.cancelInProgress)) {
    findings.push({
      id: 'ci-concurrency-deployment-cancel-review',
      domain: 'release',
      severity: 'high',
      title: 'Protected-environment job can be cancelled by a newer run',
      message: `Job ${block.name} targets a protected environment while cancel-in-progress is true. A later run can interrupt deployment after partial external side effects.`,
      location: where,
      remediation: 'Prefer serialized non-cancelling deployment concurrency. If cancellation is required, prove deployment operations are transactional or idempotent and resume-safe.',
      tags: ['ci', 'concurrency', 'deployment', 'atomicity'],
    });
  }

  if (!TRUE.test(signal.cancelInProgress) && !FALSE.test(signal.cancelInProgress) && !signal.dynamicCancellation) {
    findings.push({
      id: 'ci-concurrency-cancellation-value-review',
      domain: 'build',
      severity: 'low',
      title: 'Concurrency cancellation value is not a canonical boolean',
      message: `${signal.scope === 'job' ? `Job ${block.name}` : 'Workflow'} uses cancel-in-progress value "${signal.cancelInProgress}". Ambiguous YAML coercion makes release behavior harder to review.`,
      location: where,
      remediation: 'Use explicit true/false or a narrowly reviewed trusted boolean expression.',
      tags: ['ci', 'concurrency', 'yaml', 'determinism'],
    });
  }

  return findings;
}

function missingConcurrencyFindings(block: WorkflowJobBlock, workflow: ConcurrencySpec | undefined, job: ConcurrencySpec | undefined): Finding[] {
  if (workflow || job) return [];
  const trigger = workflowTriggerProfile(block.file);
  const privileged = jobHasWriteAuthority(block) || jobHasSecrets(block) || jobUsesProtectedEnvironment(block);
  if (!trigger.externalContribution || !privileged) return [];
  return [{
    id: 'ci-concurrency-external-privileged-missing',
    domain: 'security',
    severity: 'high',
    title: 'Externally influenced privileged job lacks concurrency governance',
    message: `Job ${block.name} combines contribution-triggered execution with privileged authority but has no workflow- or job-level concurrency group. Repeated events can queue overlapping privileged work.`,
    location: { file: block.file.repositoryPath, line: block.startLine },
    remediation: 'Define a trusted, ref-partitioned concurrency group. Serialize privileged mutation and keep contribution validation read-only.',
    tags: ['ci', 'concurrency', 'least-privilege', 'availability'],
  }];
}

export function auditConcurrencyBoundaries(inventory: RepositoryInventory): AuditSection<ConcurrencyBoundarySummary> {
  const started = performance.now();
  const files = workflowFiles(inventory);
  const signals: ConcurrencyBoundarySignal[] = [];
  const findings: Finding[] = [];
  let privilegedExternalJobsWithoutConcurrency = 0;

  for (const file of files) {
    const workflow = workflowSpec(file);
    for (const block of workflowJobBlocks(file)) {
      const job = jobSpec(block);
      const effective = job ?? workflow;
      if (effective) {
        const scope = job ? 'job' as const : 'workflow' as const;
        const current = signalFor(block, scope, effective);
        signals.push(current);
        findings.push(...groupFindings(block, current, effective));
        findings.push(...cancellationFindings(block, current, effective));
      } else {
        const missing = missingConcurrencyFindings(block, workflow, job);
        if (missing.length > 0) privilegedExternalJobsWithoutConcurrency += 1;
        findings.push(...missing);
      }
    }
  }

  const canonical = stableSortFindings(findings);
  return {
    domain: 'security',
    title: 'CI concurrency and cancellation trust-boundary audit',
    summary: {
      workflowFiles: files.length,
      scopes: signals.length,
      dynamicGroups: signals.filter(item => item.dynamicGroup).length,
      untrustedGroups: signals.filter(item => item.untrustedGroup).length,
      privilegedExternalJobsWithoutConcurrency,
      signals,
      findings: canonical,
    },
    findings: canonical,
    elapsedMs: Math.max(0, performance.now() - started),
  };
}
