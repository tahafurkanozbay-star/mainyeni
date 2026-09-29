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
  physicalLines,
  workflowFieldBlockText,
  workflowFiles,
  workflowJobBlocks,
  type WorkflowJobBlock,
} from './workflow-structure.mts';
import {
  firstWorkflowStepField,
  stepNestedMapping,
  stepRunText,
  workflowStepBlocks,
  type WorkflowStepBlock,
} from './workflow-step-structure.mts';

export interface WorkflowOutputReferenceSignal {
  readonly file: string;
  readonly consumerJob: string;
  readonly producerJob: string;
  readonly output: string;
  readonly context: OutputExecutionContext;
  readonly producerTainted: boolean;
  readonly consumerPrivileged: boolean;
  readonly line: number;
}

export interface WorkflowOutputProvenanceSummary {
  readonly workflowFiles: number;
  readonly jobs: number;
  readonly outputProducerJobs: number;
  readonly taintedProducerJobs: number;
  readonly outputReferences: number;
  readonly privilegedOutputReferences: number;
  readonly signals: readonly WorkflowOutputReferenceSignal[];
  readonly findings: readonly Finding[];
}

type OutputExecutionContext =
  | 'run'
  | 'uses'
  | 'shell'
  | 'working-directory'
  | 'runs-on'
  | 'environment'
  | 'checkout-ref'
  | 'checkout-repository'
  | 'script'
  | 'path'
  | 'generic-with';

interface ProducerProfile {
  readonly job: WorkflowJobBlock;
  readonly outputNames: ReadonlySet<string>;
  readonly tainted: boolean;
  readonly taintSources: readonly string[];
}

interface OutputReference {
  readonly producer: string;
  readonly output: string;
  readonly expression: string;
}

const NEEDS_OUTPUT = /\$\{\{\s*needs\.([A-Za-z0-9_-]+)\.outputs\.([A-Za-z0-9_-]+)(?:[^}]*)\}\}/gi;
const UNTRUSTED_SOURCE = /\$\{\{[\s\S]*?(?:github\.event\.|github\.head_ref\b|inputs\.|github\.event\.inputs\.)[\s\S]*?\}\}/i;
const GITHUB_OUTPUT = /(?:\$\{?GITHUB_OUTPUT\}?|\$env:GITHUB_OUTPUT\b)/i;
const SENSITIVE_WITH_KEYS = new Set(['ref', 'repository', 'path', 'script', 'command', 'args', 'image', 'working-directory', 'entrypoint']);

function outputReferences(text: string): OutputReference[] {
  const matcher = new RegExp(NEEDS_OUTPUT.source, NEEDS_OUTPUT.flags);
  const refs: OutputReference[] = [];
  let match: RegExpExecArray | null;
  while ((match = matcher.exec(text)) !== null) {
    refs.push({
      producer: match[1] ?? '',
      output: match[2] ?? '',
      expression: match[0],
    });
  }
  return refs.filter(ref => ref.producer.length > 0 && ref.output.length > 0);
}

function producerOutputNames(block: WorkflowJobBlock): Set<string> {
  const names = new Set<string>();
  const field = firstWorkflowField(block, 'outputs');
  if (!field) return names;
  for (const line of physicalLines(workflowFieldBlockText(block, 'outputs'))) {
    const match = line.text.match(/^\s*([A-Za-z0-9_-]+)\s*:\s*(.+)$/);
    const name = match?.[1];
    if (name && name.toLowerCase() !== 'outputs') names.add(name);
  }
  return names;
}

function taintedStepOutput(step: WorkflowStepBlock): string[] {
  const run = stepRunText(step);
  if (!GITHUB_OUTPUT.test(run)) return [];
  const sources = new Set<string>();
  if (UNTRUSTED_SOURCE.test(run)) sources.add('direct-expression');
  const env = stepNestedMapping(step, 'env');
  for (const [name, value] of env.entries()) {
    if (!UNTRUSTED_SOURCE.test(value)) continue;
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`(?:\\$\\{${escaped}\\}|\\$${escaped}\\b|\\$env:${escaped}\\b|%${escaped}%)`, 'i').test(run)) {
      sources.add(`env:${name}`);
    }
  }
  return [...sources].sort((a, b) => a.localeCompare(b, 'en'));
}

function producerProfile(block: WorkflowJobBlock): ProducerProfile | undefined {
  const outputNames = producerOutputNames(block);
  if (outputNames.size === 0) return undefined;
  const sources = new Set<string>();
  for (const step of workflowStepBlocks(block)) {
    for (const source of taintedStepOutput(step)) sources.add(source);
  }
  const outputBlock = workflowFieldBlockText(block, 'outputs');
  if (UNTRUSTED_SOURCE.test(outputBlock)) sources.add('job-output-expression');
  return {
    job: block,
    outputNames,
    tainted: sources.size > 0,
    taintSources: [...sources].sort((a, b) => a.localeCompare(b, 'en')),
  };
}

function privileged(block: WorkflowJobBlock): boolean {
  return jobHasWriteAuthority(block) || jobHasSecrets(block) || jobUsesProtectedEnvironment(block);
}

function signalFor(
  block: WorkflowJobBlock,
  ref: OutputReference,
  context: OutputExecutionContext,
  line: number,
  producer: ProducerProfile | undefined,
): WorkflowOutputReferenceSignal {
  return {
    file: block.file.repositoryPath,
    consumerJob: block.name,
    producerJob: ref.producer,
    output: ref.output,
    context,
    producerTainted: producer?.tainted ?? false,
    consumerPrivileged: privileged(block),
    line,
  };
}

function refsInText(
  block: WorkflowJobBlock,
  text: string,
  context: OutputExecutionContext,
  line: number,
  producers: ReadonlyMap<string, ProducerProfile>,
): WorkflowOutputReferenceSignal[] {
  return outputReferences(text).map(ref => signalFor(block, ref, context, line, producers.get(ref.producer)));
}

function stepSignals(
  block: WorkflowJobBlock,
  step: WorkflowStepBlock,
  producers: ReadonlyMap<string, ProducerProfile>,
): WorkflowOutputReferenceSignal[] {
  const signals: WorkflowOutputReferenceSignal[] = [];
  const run = stepRunText(step);
  if (run) signals.push(...refsInText(block, run, 'run', step.startLine, producers));
  for (const key of ['uses', 'shell', 'working-directory'] as const) {
    const field = firstWorkflowStepField(step, key);
    if (!field) continue;
    signals.push(...refsInText(block, field.value, key, field.line, producers));
  }
  for (const [key, value] of stepNestedMapping(step, 'with').entries()) {
    const normalized = key.toLowerCase();
    const context: OutputExecutionContext = normalized === 'ref'
      ? 'checkout-ref'
      : normalized === 'repository'
        ? 'checkout-repository'
        : normalized === 'script'
          ? 'script'
          : normalized === 'path'
            ? 'path'
            : SENSITIVE_WITH_KEYS.has(normalized)
              ? 'generic-with'
              : 'generic-with';
    if (!SENSITIVE_WITH_KEYS.has(normalized)) continue;
    signals.push(...refsInText(block, value, context, step.startLine, producers));
  }
  return signals;
}

function jobFieldSignals(
  block: WorkflowJobBlock,
  producers: ReadonlyMap<string, ProducerProfile>,
): WorkflowOutputReferenceSignal[] {
  const signals: WorkflowOutputReferenceSignal[] = [];
  for (const key of ['runs-on', 'environment'] as const) {
    const field = firstWorkflowField(block, key);
    if (!field) continue;
    signals.push(...refsInText(block, workflowFieldBlockText(block, key), key, field.line, producers));
  }
  return signals;
}

function findingFor(signal: WorkflowOutputReferenceSignal, producer: ProducerProfile | undefined): Finding {
  const directExecutable = new Set<OutputExecutionContext>(['run', 'uses', 'shell', 'working-directory', 'runs-on', 'environment', 'checkout-ref', 'checkout-repository', 'script']);
  const critical = signal.consumerPrivileged && (signal.producerTainted || directExecutable.has(signal.context));
  const severity: Finding['severity'] = critical ? 'critical' : signal.producerTainted ? 'high' : 'medium';
  const producerEvidence = producer?.taintSources.join(', ') || 'producer output provenance not statically proven';
  return {
    id: critical ? 'ci-output-privileged-execution-provenance' : signal.producerTainted ? 'ci-output-tainted-execution' : 'ci-output-executable-provenance-review',
    domain: 'security',
    severity,
    ...(critical ? { blocking: true } : {}),
    title: critical ? 'Job output crosses into privileged executable context' : signal.producerTainted ? 'Untrusted-derived job output reaches executable context' : 'Job output influences executable or trust-selecting context',
    message: `Consumer job ${signal.consumerJob} uses needs.${signal.producerJob}.outputs.${signal.output} in ${signal.context}. Producer provenance: ${producerEvidence}. needs.* outputs are data channels and must not silently become executable source, runner/ref/environment selectors, or privileged mutation inputs.`,
    location: { file: signal.file, line: signal.line },
    evidence: { excerpt: `needs.${signal.producerJob}.outputs.${signal.output}`, metadata: { producerJob: signal.producerJob, consumerJob: signal.consumerJob, context: signal.context } },
    remediation: 'Validate producer output against a closed schema/allowlist before publication. In the consumer, map validated identifiers to reviewed literals; do not interpolate opaque job outputs directly into run/uses/shell/runner/ref/environment/path/script fields.',
    tags: ['ci', 'workflow-output', 'provenance', 'dataflow', 'privilege'],
  };
}

export function auditWorkflowOutputProvenance(inventory: RepositoryInventory): AuditSection<WorkflowOutputProvenanceSummary> {
  const started = performance.now();
  const files = workflowFiles(inventory);
  const allSignals: WorkflowOutputReferenceSignal[] = [];
  let jobsCount = 0;
  let producerCount = 0;
  let taintedProducerCount = 0;

  for (const file of files) {
    const jobs = workflowJobBlocks(file);
    jobsCount += jobs.length;
    const profiles = jobs.map(producerProfile).filter((item): item is ProducerProfile => item !== undefined);
    producerCount += profiles.length;
    taintedProducerCount += profiles.filter(item => item.tainted).length;
    const producers = new Map(profiles.map(profile => [profile.job.name, profile] as const));
    for (const job of jobs) {
      allSignals.push(...jobFieldSignals(job, producers));
      for (const step of workflowStepBlocks(job)) allSignals.push(...stepSignals(job, step, producers));
    }
  }

  const profileByFileJob = new Map<string, ProducerProfile>();
  for (const file of files) {
    for (const block of workflowJobBlocks(file)) {
      const profile = producerProfile(block);
      if (profile) profileByFileJob.set(`${file.repositoryPath}\u0000${block.name}`, profile);
    }
  }
  const findings = stableSortFindings(allSignals.map(signal => findingFor(signal, profileByFileJob.get(`${signal.file}\u0000${signal.producerJob}`))));
  return {
    domain: 'security',
    title: 'Workflow job-output provenance audit',
    summary: {
      workflowFiles: files.length,
      jobs: jobsCount,
      outputProducerJobs: producerCount,
      taintedProducerJobs: taintedProducerCount,
      outputReferences: allSignals.length,
      privilegedOutputReferences: allSignals.filter(item => item.consumerPrivileged).length,
      signals: allSignals,
      findings,
    },
    findings,
    elapsedMs: Math.max(0, performance.now() - started),
  };
}
