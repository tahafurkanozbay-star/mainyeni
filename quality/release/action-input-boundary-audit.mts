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
  stepUsesIdentity,
  workflowStepBlocks,
  type WorkflowStepBlock,
} from './workflow-step-structure.mts';

export type ActionInputRiskClass = 'code' | 'identity' | 'filesystem' | 'publication';

export interface ActionInputSignal {
  readonly file: string;
  readonly job: string;
  readonly step: string;
  readonly action: string;
  readonly input: string;
  readonly riskClass: ActionInputRiskClass;
  readonly sourceKinds: readonly string[];
  readonly externalContribution: boolean;
  readonly privileged: boolean;
  readonly immutableAction: boolean;
  readonly line: number;
}

export interface ActionInputBoundarySummary {
  readonly workflowFiles: number;
  readonly actionSteps: number;
  readonly sensitiveInputUses: number;
  readonly untrustedSensitiveInputs: number;
  readonly privilegedSensitiveInputs: number;
  readonly signals: readonly ActionInputSignal[];
  readonly findings: readonly Finding[];
}

const CODE_KEYS = new Set(['script', 'command', 'cmd', 'args', 'arguments', 'entrypoint', 'shell', 'run']);
const IDENTITY_KEYS = new Set(['ref', 'repository', 'image', 'tag', 'version', 'target', 'environment']);
const FILESYSTEM_KEYS = new Set(['path', 'context', 'working-directory', 'workdir', 'file', 'dockerfile']);
const PUBLICATION_KEYS = new Set(['name', 'release-name', 'release_name', 'artifact', 'artifact-name', 'package', 'registry', 'repository-url']);
const UNTRUSTED = /\$\{\{[\s\S]*?(?:github\.event\.|github\.head_ref\b|inputs\.|github\.event\.inputs\.|needs\.[A-Za-z0-9_-]+\.outputs\.|steps\.[A-Za-z0-9_-]+\.outputs\.|matrix\.)[\s\S]*?\}\}/i;
const SOURCE_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ['github.event', /github\.event\./i],
  ['github.head_ref', /github\.head_ref\b/i],
  ['inputs', /(?:^|\W)inputs\./i],
  ['event-inputs', /github\.event\.inputs\./i],
  ['needs-output', /needs\.[A-Za-z0-9_-]+\.outputs\./i],
  ['step-output', /steps\.[A-Za-z0-9_-]+\.outputs\./i],
  ['matrix', /(?:^|\W)matrix\./i],
];

function riskClass(key: string): ActionInputRiskClass | undefined {
  const normalized = key.toLowerCase();
  if (CODE_KEYS.has(normalized)) return 'code';
  if (IDENTITY_KEYS.has(normalized)) return 'identity';
  if (FILESYSTEM_KEYS.has(normalized)) return 'filesystem';
  if (PUBLICATION_KEYS.has(normalized)) return 'publication';
  return undefined;
}

function sourceKinds(value: string): string[] {
  return SOURCE_PATTERNS.filter(([, pattern]) => pattern.test(value)).map(([name]) => name);
}

function privileged(block: WorkflowJobBlock): boolean {
  return jobHasWriteAuthority(block) || jobHasSecrets(block);
}

function signalsFor(block: WorkflowJobBlock, step: WorkflowStepBlock): ActionInputSignal[] {
  const identity = stepUsesIdentity(step);
  if (!identity) return [];
  const trigger = workflowTriggerProfile(block.file);
  const signals: ActionInputSignal[] = [];
  for (const [key, value] of stepNestedMapping(step, 'with').entries()) {
    const klass = riskClass(key);
    if (!klass || !UNTRUSTED.test(value)) continue;
    signals.push({
      file: block.file.repositoryPath,
      job: block.name,
      step: stepDisplayName(step),
      action: identity.raw,
      input: key,
      riskClass: klass,
      sourceKinds: sourceKinds(value),
      externalContribution: trigger.externalContribution,
      privileged: privileged(block),
      immutableAction: identity.immutable,
      line: step.startLine,
    });
  }
  return signals;
}

function findingFor(signal: ActionInputSignal): Finding {
  const executable = signal.riskClass === 'code';
  const trustSelecting = signal.riskClass === 'identity' || signal.riskClass === 'filesystem';
  const critical = executable || (signal.privileged && (trustSelecting || signal.externalContribution));
  const severity: Finding['severity'] = critical ? 'critical' : trustSelecting || signal.externalContribution ? 'high' : 'medium';
  const sources = signal.sourceKinds.join(', ') || 'expression-derived data';
  return {
    id: executable
      ? 'ci-action-input-executable-data'
      : signal.privileged
        ? 'ci-action-input-privileged-selector'
        : signal.riskClass === 'filesystem'
          ? 'ci-action-input-filesystem-selector'
          : signal.riskClass === 'identity'
            ? 'ci-action-input-identity-selector'
            : 'ci-action-input-publication-selector',
    domain: 'security',
    severity,
    ...(critical ? { blocking: true } : {}),
    title: executable
      ? 'Untrusted expression reaches action executable input'
      : signal.privileged
        ? 'Untrusted expression controls privileged action behavior'
        : 'Untrusted expression controls action identity, filesystem, or publication input',
    message: `Step ${signal.step} passes ${sources} into ${signal.action} input ${signal.input} (${signal.riskClass}). Pinning action code does not make its behavior safe when executable/trust-selecting inputs remain runtime-controlled.`,
    location: { file: signal.file, line: signal.line },
    evidence: { excerpt: `${signal.action} with.${signal.input}`, metadata: { action: signal.action, input: signal.input, riskClass: signal.riskClass, sources } },
    remediation: executable
      ? 'Do not pass event/input/output data as script/command/args. Use a reviewed literal action program and pass validated values through dedicated data inputs or environment variables.'
      : 'Validate the value against a closed allowlist and map it to reviewed literal ref/repository/path/context/publication identifiers before invoking the action.',
    tags: ['ci', 'actions', 'input', 'expression-injection', 'trust-boundary'],
  };
}

export function auditActionInputBoundaries(inventory: RepositoryInventory): AuditSection<ActionInputBoundarySummary> {
  const started = performance.now();
  const files = workflowFiles(inventory);
  const jobs = files.flatMap(file => workflowJobBlocks(file));
  const actionSteps = jobs.flatMap(job => workflowStepBlocks(job).filter(step => stepUsesIdentity(step) !== undefined));
  const signals = jobs.flatMap(job => workflowStepBlocks(job).flatMap(step => signalsFor(job, step)));
  const findings = stableSortFindings(signals.map(findingFor));
  return {
    domain: 'security',
    title: 'Action input execution and trust-selector boundary audit',
    summary: {
      workflowFiles: files.length,
      actionSteps: actionSteps.length,
      sensitiveInputUses: signals.length,
      untrustedSensitiveInputs: signals.length,
      privilegedSensitiveInputs: signals.filter(item => item.privileged).length,
      signals,
      findings,
    },
    findings,
    elapsedMs: Math.max(0, performance.now() - started),
  };
}
