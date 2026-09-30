import {
  stableSortFindings,
  type AuditSection,
  type Finding,
  type RepositoryInventory,
  type SourceFile,
} from './contracts.mts';
import {
  firstWorkflowField,
  jobHasSecrets,
  jobHasWriteAuthority,
  jobUsesProtectedEnvironment,
  unquoteYamlScalar,
  workflowFiles,
  workflowJobBlocks,
  workflowTopLevelBlock,
  workflowTriggerProfile,
  type WorkflowJobBlock,
  type WorkflowLine,
} from './workflow-structure.mts';

export interface WorkflowRunProducerContract {
  readonly name: string;
  readonly file: string;
  readonly push: boolean;
  readonly pullRequest: boolean;
  readonly pullRequestTarget: boolean;
  readonly workflowDispatch: boolean;
  readonly workflowCall: boolean;
  readonly workflowRun: boolean;
  readonly externalContribution: boolean;
}

export interface WorkflowRunEventChainSignal {
  readonly file: string;
  readonly job: string;
  readonly line: number;
  readonly privileged: boolean;
  readonly producerNames: readonly string[];
  readonly dynamicProducerName: boolean;
  readonly producerCount: number;
  readonly unresolvedProducerNames: readonly string[];
  readonly ambiguousProducerNames: readonly string[];
  readonly producerHasExternalTrigger: boolean;
  readonly producerHasPushTrigger: boolean;
  readonly producerHasWorkflowRunTrigger: boolean;
  readonly completedOnly: boolean;
  readonly eventGuard: readonly string[];
  readonly trustedEventGuard: boolean;
}

export interface WorkflowRunEventChainSummary {
  readonly workflowFiles: number;
  readonly namedProducerWorkflows: number;
  readonly workflowRunJobs: number;
  readonly privilegedWorkflowRunJobs: number;
  readonly mixedTrustProducerJobs: number;
  readonly unresolvedProducerJobs: number;
  readonly signals: readonly WorkflowRunEventChainSignal[];
  readonly findings: readonly Finding[];
}

interface WorkflowRunTriggerContract {
  readonly line: number;
  readonly workflows: readonly string[];
  readonly types: readonly string[];
  readonly dynamicWorkflow: boolean;
}

const EXPRESSION = /\$\{\{[\s\S]*?\}\}/;
const EVENT_GUARD = /github\.event\.workflow_run\.event\s*==\s*['"]([A-Za-z0-9_.-]+)['"]|['"]([A-Za-z0-9_.-]+)['"]\s*==\s*github\.event\.workflow_run\.event/gi;
const TRUSTED_EVENTS = new Set(['push', 'workflow_dispatch', 'schedule', 'release']);
const MAPPING_FIELD = /^\s*([A-Za-z0-9_.-]+)\s*:\s*(.*)$/;

function privileged(block: WorkflowJobBlock): boolean {
  return jobHasWriteAuthority(block) || jobHasSecrets(block) || jobUsesProtectedEnvironment(block);
}

function workflowName(file: SourceFile): string | undefined {
  const value = workflowTopLevelBlock(file, 'name')?.value.trim();
  return value ? unquoteYamlScalar(value) : undefined;
}

function producerContracts(files: readonly SourceFile[]): ReadonlyMap<string, readonly WorkflowRunProducerContract[]> {
  const contracts = new Map<string, WorkflowRunProducerContract[]>();
  for (const file of files) {
    const name = workflowName(file);
    if (!name) continue;
    const trigger = workflowTriggerProfile(file);
    const contract: WorkflowRunProducerContract = {
      name,
      file: file.repositoryPath,
      push: trigger.push,
      pullRequest: trigger.pullRequest,
      pullRequestTarget: trigger.pullRequestTarget,
      workflowDispatch: trigger.workflowDispatch,
      workflowCall: trigger.workflowCall,
      workflowRun: trigger.workflowRun,
      externalContribution: trigger.externalContribution,
    };
    const current = contracts.get(name) ?? [];
    current.push(contract);
    contracts.set(name, current);
  }
  return contracts;
}

function nestedRegion(lines: readonly WorkflowLine[], start: WorkflowLine): WorkflowLine[] {
  const region: WorkflowLine[] = [];
  for (const line of lines) {
    if (line.line <= start.line) continue;
    if (line.trimmed && line.indent <= start.indent) break;
    region.push(line);
  }
  return region;
}

function listValues(lines: readonly WorkflowLine[], fieldName: string): string[] {
  const field = lines.find(line => {
    const match = line.text.match(MAPPING_FIELD);
    return match?.[1]?.toLowerCase() === fieldName.toLowerCase();
  });
  if (!field) return [];
  const tail = unquoteYamlScalar(field.text.match(MAPPING_FIELD)?.[2] ?? '').trim();
  if (tail.startsWith('[') && tail.endsWith(']')) {
    return tail.slice(1, -1)
      .split(',')
      .map(item => unquoteYamlScalar(item).trim())
      .filter(Boolean);
  }
  if (tail) return [unquoteYamlScalar(tail).trim()].filter(Boolean);
  const values: string[] = [];
  for (const line of nestedRegion(lines, field)) {
    const match = line.trimmed.match(/^-\s*([^#]+?)(?:\s+#.*)?$/);
    if (!match) continue;
    const value = unquoteYamlScalar(match[1] ?? '').trim();
    if (value) values.push(value);
  }
  return values;
}

function workflowRunContract(file: SourceFile): WorkflowRunTriggerContract | undefined {
  const on = workflowTopLevelBlock(file, 'on');
  if (!on) return undefined;
  const workflowRun = on.lines.find(line => /^\s*workflow_run\s*:/i.test(line.text));
  if (!workflowRun) {
    const scalar = on.value.toLowerCase();
    if (scalar === 'workflow_run' || scalar.includes('workflow_run')) {
      return { line: on.line.line, workflows: [], types: [], dynamicWorkflow: false };
    }
    return undefined;
  }
  const region = nestedRegion(on.lines, workflowRun);
  const workflows = listValues(region, 'workflows');
  const types = listValues(region, 'types').map(value => value.toLowerCase());
  return {
    line: workflowRun.line,
    workflows,
    types,
    dynamicWorkflow: workflows.some(value => EXPRESSION.test(value)),
  };
}

function eventGuards(block: WorkflowJobBlock): string[] {
  const value = firstWorkflowField(block, 'if')?.value ?? '';
  const events = new Set<string>();
  const matcher = new RegExp(EVENT_GUARD.source, EVENT_GUARD.flags);
  let match: RegExpExecArray | null;
  while ((match = matcher.exec(value)) !== null) {
    const event = (match[1] ?? match[2] ?? '').toLowerCase();
    if (event) events.add(event);
  }
  return [...events].sort((left, right) => left.localeCompare(right, 'en'));
}

function completedOnly(contract: WorkflowRunTriggerContract): boolean {
  return contract.types.length === 1 && contract.types[0] === 'completed';
}

function signalFor(
  block: WorkflowJobBlock,
  contract: WorkflowRunTriggerContract,
  producers: ReadonlyMap<string, readonly WorkflowRunProducerContract[]>,
): WorkflowRunEventChainSignal {
  const resolved: WorkflowRunProducerContract[] = [];
  const unresolved: string[] = [];
  const ambiguous: string[] = [];
  for (const name of contract.workflows) {
    const matches = producers.get(name) ?? [];
    if (matches.length === 0) unresolved.push(name);
    else if (matches.length > 1) ambiguous.push(name);
    resolved.push(...matches);
  }
  const guards = eventGuards(block);
  return {
    file: block.file.repositoryPath,
    job: block.name,
    line: firstWorkflowField(block, 'if')?.line ?? contract.line,
    privileged: privileged(block),
    producerNames: contract.workflows,
    dynamicProducerName: contract.dynamicWorkflow,
    producerCount: resolved.length,
    unresolvedProducerNames: unresolved,
    ambiguousProducerNames: ambiguous,
    producerHasExternalTrigger: resolved.some(item => item.externalContribution),
    producerHasPushTrigger: resolved.some(item => item.push),
    producerHasWorkflowRunTrigger: resolved.some(item => item.workflowRun),
    completedOnly: completedOnly(contract),
    eventGuard: guards,
    trustedEventGuard: guards.some(event => TRUSTED_EVENTS.has(event)),
  };
}

function finding(
  signal: WorkflowRunEventChainSignal,
  id: string,
  title: string,
  message: string,
  remediation: string,
  severity: Finding['severity'] = 'critical',
  blocking = true,
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
      metadata: {
        job: signal.job,
        producers: signal.producerNames.join(','),
        producerCount: signal.producerCount,
        eventGuard: signal.eventGuard.join(','),
      },
    },
    remediation,
    tags: ['ci', 'workflow-run', 'event-chain', 'provenance', 'trust-boundary'],
  };
}

function findingsFor(signal: WorkflowRunEventChainSignal): Finding[] {
  if (!signal.privileged) return [];
  const findings: Finding[] = [];

  if (!signal.completedOnly) {
    findings.push(finding(
      signal,
      'ci-workflow-run-privileged-noncompleted-trigger',
      'Privileged workflow_run consumer is not restricted to completed producer runs',
      `Job ${signal.job} can enter a privileged workflow_run context without an exact types: [completed] contract. requested/in_progress activity must never inherit release or mutation authority.`,
      'Set workflow_run.types to the single literal value completed, then separately require conclusion == success before privileged mutation.',
    ));
  }

  if (signal.producerNames.length === 0) {
    findings.push(finding(
      signal,
      'ci-workflow-run-producer-list-missing',
      'Privileged workflow_run consumer has no static producer workflow allowlist',
      `Job ${signal.job} is privileged but workflow_run.workflows does not identify the reviewed producer workflow.`,
      'Declare a non-empty literal workflow_run.workflows allowlist and keep producer names stable and reviewable.',
    ));
  }

  if (signal.dynamicProducerName) {
    findings.push(finding(
      signal,
      'ci-workflow-run-producer-name-dynamic',
      'Privileged workflow_run producer identity is dynamic',
      `Job ${signal.job} derives workflow_run.workflows identity from an expression, so code review cannot establish a closed producer set.`,
      'Use only literal producer workflow names in workflow_run.workflows.',
    ));
  }

  if (signal.unresolvedProducerNames.length > 0) {
    findings.push(finding(
      signal,
      'ci-workflow-run-producer-unresolved',
      'Privileged workflow_run producer name does not resolve to repository workflow code',
      `Producer workflow name(s) ${signal.unresolvedProducerNames.join(', ')} are not uniquely represented by a named workflow in the repository inventory. Provenance policy cannot inspect their trigger surface.`,
      'Ensure each privileged producer name resolves to exactly one repository workflow with a stable top-level name.',
      'high',
      true,
    ));
  }

  if (signal.ambiguousProducerNames.length > 0) {
    findings.push(finding(
      signal,
      'ci-workflow-run-producer-name-ambiguous',
      'Privileged workflow_run producer name is ambiguous',
      `Producer workflow name(s) ${signal.ambiguousProducerNames.join(', ')} resolve to multiple workflow files. Name-based provenance can select more than one trigger contract.`,
      'Give release-producing workflows unique top-level names and reference exactly one reviewed producer contract.',
    ));
  }

  if (signal.producerHasExternalTrigger && !signal.trustedEventGuard) {
    findings.push(finding(
      signal,
      'ci-workflow-run-external-producer-event-unbound',
      'Privileged workflow_run consumer does not constrain a mixed-trust producer event',
      `At least one resolved producer workflow can run on contribution-controlled events, but privileged job ${signal.job} does not constrain github.event.workflow_run.event to a trusted event class. A static workflow name alone does not distinguish push output from pull-request output.`,
      "Require github.event.workflow_run.event == 'push' (or another explicitly reviewed trusted producer event) before privileged consumption, in addition to repository/ref/conclusion guards.",
    ));
  }

  if (signal.producerHasExternalTrigger && signal.producerHasPushTrigger && signal.eventGuard.length > 0 && !signal.eventGuard.includes('push')) {
    findings.push(finding(
      signal,
      'ci-workflow-run-mixed-producer-event-guard-mismatch',
      'workflow_run event guard does not select the trusted push producer path',
      `Resolved producer workflows expose both trusted push and externally influenced trigger paths, but job ${signal.job} is not explicitly bound to workflow_run.event == 'push'.`,
      "Bind privileged promotion to the producer's trusted push event and keep pull-request outputs in read-only validation paths.",
    ));
  }

  if (signal.producerHasWorkflowRunTrigger) {
    findings.push(finding(
      signal,
      'ci-workflow-run-chained-privilege-review',
      'Privileged workflow_run consumer depends on another workflow_run producer',
      `Job ${signal.job} consumes a producer that is itself workflow_run-triggered. Multi-hop event chains widen provenance and artifact-substitution risk even when each individual workflow is named.`,
      'Prefer a single trusted promotion boundary. If chaining is unavoidable, bind every hop to repository, event, ref, conclusion, run identity, and artifact subject provenance.',
      'high',
      false,
    ));
  }

  return findings;
}

export function auditWorkflowRunEventChains(
  inventory: RepositoryInventory,
): AuditSection<WorkflowRunEventChainSummary> {
  const started = performance.now();
  const files = workflowFiles(inventory);
  const producers = producerContracts(files);
  const signals: WorkflowRunEventChainSignal[] = [];
  for (const file of files) {
    const contract = workflowRunContract(file);
    if (!contract) continue;
    for (const block of workflowJobBlocks(file)) {
      signals.push(signalFor(block, contract, producers));
    }
  }
  const findings = stableSortFindings(signals.flatMap(findingsFor));
  return {
    domain: 'security',
    title: 'workflow_run producer event-chain provenance audit',
    summary: {
      workflowFiles: files.length,
      namedProducerWorkflows: [...producers.values()].reduce((sum, values) => sum + values.length, 0),
      workflowRunJobs: signals.length,
      privilegedWorkflowRunJobs: signals.filter(item => item.privileged).length,
      mixedTrustProducerJobs: signals.filter(item => item.producerHasExternalTrigger && item.producerHasPushTrigger).length,
      unresolvedProducerJobs: signals.filter(item => item.unresolvedProducerNames.length > 0).length,
      signals,
      findings,
    },
    findings,
    elapsedMs: Math.max(0, performance.now() - started),
  };
}
