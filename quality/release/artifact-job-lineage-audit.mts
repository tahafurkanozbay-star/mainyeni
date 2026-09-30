import {
  stableSortFindings,
  type AuditSection,
  type Finding,
  type RepositoryInventory,
  type SourceFile,
} from './contracts.mts';
import {
  blockScalarLines,
  firstWorkflowField,
  jobHasSecrets,
  jobHasWriteAuthority,
  jobUsesProtectedEnvironment,
  unquoteYamlScalar,
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

export interface ArtifactProducerSignal {
  readonly file: string;
  readonly job: string;
  readonly step: string;
  readonly line: number;
  readonly artifactName: string;
  readonly dynamicName: boolean;
  readonly externalContribution: boolean;
}

export interface ArtifactConsumerSignal {
  readonly file: string;
  readonly job: string;
  readonly step: string;
  readonly line: number;
  readonly artifactName: string;
  readonly pattern: string;
  readonly crossRun: boolean;
  readonly broadSelector: boolean;
  readonly dynamicSelector: boolean;
  readonly privileged: boolean;
  readonly externalContribution: boolean;
  readonly directNeeds: readonly string[];
  readonly transitiveNeeds: readonly string[];
  readonly producerJobs: readonly string[];
  readonly producerCount: number;
  readonly producerInNeedsAncestry: boolean;
  readonly producerExternalContribution: boolean;
}

export interface ArtifactJobLineageSummary {
  readonly workflowFiles: number;
  readonly artifactProducers: number;
  readonly artifactConsumers: number;
  readonly sameWorkflowConsumers: number;
  readonly crossRunConsumersExcluded: number;
  readonly privilegedConsumers: number;
  readonly unresolvedConsumers: number;
  readonly ambiguousConsumers: number;
  readonly lineageViolations: number;
  readonly producers: readonly ArtifactProducerSignal[];
  readonly consumers: readonly ArtifactConsumerSignal[];
  readonly findings: readonly Finding[];
}

interface WorkflowLineage {
  readonly file: SourceFile;
  readonly jobs: ReadonlyMap<string, WorkflowJobBlock>;
  readonly needs: ReadonlyMap<string, readonly string[]>;
  readonly ancestors: ReadonlyMap<string, readonly string[]>;
  readonly cyclicJobs: ReadonlySet<string>;
}

const UPLOAD_ARTIFACT = /^actions\/upload-artifact@[0-9a-f]{40}$/i;
const DOWNLOAD_ARTIFACT = /^actions\/download-artifact@[0-9a-f]{40}$/i;
const EXPRESSION = /\$\{\{[\s\S]*?\}\}/;
const GLOB = /[*?\[\]{}]/;
const DEFAULT_ARTIFACT_NAME = 'artifact';

function privileged(block: WorkflowJobBlock): boolean {
  return jobHasWriteAuthority(block) || jobHasSecrets(block) || jobUsesProtectedEnvironment(block);
}

function splitInlineList(value: string): string[] {
  const trimmed = value.trim();
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) return [];
  return trimmed.slice(1, -1)
    .split(',')
    .map(item => unquoteYamlScalar(item).trim())
    .filter(Boolean);
}

function needsFor(block: WorkflowJobBlock): string[] {
  const field = firstWorkflowField(block, 'needs');
  if (!field) return [];
  const value = unquoteYamlScalar(field.value).trim();
  if (value) {
    const inline = splitInlineList(value);
    return inline.length > 0 ? inline : [value];
  }
  const result: string[] = [];
  for (const line of blockScalarLines(block, field)) {
    const match = line.trimmed.match(/^-\s*([^#]+?)(?:\s+#.*)?$/);
    if (!match) continue;
    const dependency = unquoteYamlScalar(match[1] ?? '').trim();
    if (dependency) result.push(dependency);
  }
  return [...new Set(result)].sort((left, right) => left.localeCompare(right, 'en'));
}

function buildLineage(file: SourceFile): WorkflowLineage {
  const blocks = workflowJobBlocks(file);
  const jobs = new Map(blocks.map(block => [block.name, block]));
  const needs = new Map<string, readonly string[]>();
  for (const block of blocks) needs.set(block.name, needsFor(block));

  const cyclicJobs = new Set<string>();
  const ancestors = new Map<string, readonly string[]>();

  function visit(job: string, stack: readonly string[]): Set<string> {
    const cached = ancestors.get(job);
    if (cached) return new Set(cached);
    if (stack.includes(job)) {
      for (const item of [...stack, job]) cyclicJobs.add(item);
      return new Set<string>();
    }
    const result = new Set<string>();
    for (const dependency of needs.get(job) ?? []) {
      result.add(dependency);
      if (!jobs.has(dependency)) continue;
      for (const ancestor of visit(dependency, [...stack, job])) result.add(ancestor);
    }
    const canonical = [...result].sort((left, right) => left.localeCompare(right, 'en'));
    ancestors.set(job, canonical);
    return new Set(canonical);
  }

  for (const job of jobs.keys()) visit(job, []);
  return { file, jobs, needs, ancestors, cyclicJobs };
}

function producerSignal(block: WorkflowJobBlock, step: WorkflowStepBlock): ArtifactProducerSignal | undefined {
  const identity = stepUsesIdentity(step);
  if (!identity || !UPLOAD_ARTIFACT.test(identity.raw)) return undefined;
  const withMap = stepNestedMapping(step, 'with');
  const artifactName = (withMap.get('name') ?? DEFAULT_ARTIFACT_NAME).trim();
  return {
    file: block.file.repositoryPath,
    job: block.name,
    step: stepDisplayName(step),
    line: firstWorkflowStepField(step, 'uses')?.line ?? step.startLine,
    artifactName,
    dynamicName: EXPRESSION.test(artifactName),
    externalContribution: workflowTriggerProfile(block.file).externalContribution,
  };
}

function consumerBase(block: WorkflowJobBlock, step: WorkflowStepBlock): {
  artifactName: string;
  pattern: string;
  crossRun: boolean;
  broadSelector: boolean;
  dynamicSelector: boolean;
} | undefined {
  const identity = stepUsesIdentity(step);
  if (!identity || !DOWNLOAD_ARTIFACT.test(identity.raw)) return undefined;
  const withMap = stepNestedMapping(step, 'with');
  const artifactName = (withMap.get('name') ?? '').trim();
  const pattern = (withMap.get('pattern') ?? '').trim();
  const runId = (withMap.get('run-id') ?? '').trim();
  const repository = (withMap.get('repository') ?? '').trim();
  const githubToken = (withMap.get('github-token') ?? '').trim();
  const crossRun = Boolean(runId || repository || githubToken);
  const selector = artifactName || pattern;
  return {
    artifactName,
    pattern,
    crossRun,
    broadSelector: !selector || Boolean(pattern) || GLOB.test(selector),
    dynamicSelector: EXPRESSION.test(selector),
  };
}

function literalProducerMatches(
  producers: readonly ArtifactProducerSignal[],
  artifactName: string,
): ArtifactProducerSignal[] {
  return producers.filter(producer => !producer.dynamicName && producer.artifactName === artifactName);
}

function consumerSignal(
  lineage: WorkflowLineage,
  block: WorkflowJobBlock,
  step: WorkflowStepBlock,
  producers: readonly ArtifactProducerSignal[],
): ArtifactConsumerSignal | undefined {
  const base = consumerBase(block, step);
  if (!base) return undefined;
  const directNeeds = lineage.needs.get(block.name) ?? [];
  const transitiveNeeds = lineage.ancestors.get(block.name) ?? [];
  const matches = !base.crossRun && !base.broadSelector && !base.dynamicSelector
    ? literalProducerMatches(producers, base.artifactName)
    : [];
  const producerJobs = [...new Set(matches.map(item => item.job))]
    .sort((left, right) => left.localeCompare(right, 'en'));
  const producerInNeedsAncestry = producerJobs.length === 1
    && (producerJobs[0] === block.name || transitiveNeeds.includes(producerJobs[0]!));
  return {
    file: block.file.repositoryPath,
    job: block.name,
    step: stepDisplayName(step),
    line: firstWorkflowStepField(step, 'uses')?.line ?? step.startLine,
    artifactName: base.artifactName,
    pattern: base.pattern,
    crossRun: base.crossRun,
    broadSelector: base.broadSelector,
    dynamicSelector: base.dynamicSelector,
    privileged: privileged(block),
    externalContribution: workflowTriggerProfile(block.file).externalContribution,
    directNeeds,
    transitiveNeeds,
    producerJobs,
    producerCount: matches.length,
    producerInNeedsAncestry,
    producerExternalContribution: matches.some(item => item.externalContribution),
  };
}

function location(signal: ArtifactConsumerSignal) {
  return { file: signal.file, line: signal.line };
}

function finding(
  signal: ArtifactConsumerSignal,
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
    location: location(signal),
    evidence: {
      value: signal.artifactName || signal.pattern || '(all artifacts)',
      metadata: {
        job: signal.job,
        step: signal.step,
        producerJobs: signal.producerJobs.join(','),
        directNeeds: signal.directNeeds.join(','),
        transitiveNeeds: signal.transitiveNeeds.join(','),
      },
    },
    remediation,
    tags: ['ci', 'artifact', 'job-lineage', 'needs', 'provenance', 'supply-chain'],
  };
}

function findingsFor(signal: ArtifactConsumerSignal): Finding[] {
  if (signal.crossRun) return [];
  const findings: Finding[] = [];
  const strict = signal.privileged || signal.externalContribution;

  if (signal.dynamicSelector) {
    findings.push(finding(
      signal,
      'ci-artifact-lineage-dynamic-selector',
      'Artifact consumer selects producer output dynamically',
      `Job ${signal.job} derives its artifact selector from an expression. A privileged or executable consumer cannot establish a closed producer lineage from a mutable name.`,
      'Use a literal artifact name for security-sensitive consumers and map dynamic choices to a closed trusted allowlist before download.',
      strict ? 'critical' : 'high',
      strict,
    ));
    return findings;
  }

  if (signal.broadSelector) {
    findings.push(finding(
      signal,
      'ci-artifact-lineage-broad-selector',
      'Artifact consumer downloads multiple or pattern-selected producer outputs',
      `Job ${signal.job} uses ${signal.pattern || 'an omitted artifact name'} so content from multiple producers can enter the consumer workspace without a unique job lineage.`,
      'Use one literal artifact name per security-sensitive download. If multiple artifacts are required, download each named artifact separately and validate each producer contract.',
      strict ? 'critical' : 'medium',
      strict,
    ));
    return findings;
  }

  if (signal.producerCount === 0) {
    findings.push(finding(
      signal,
      'ci-artifact-lineage-producer-unresolved',
      'Same-workflow artifact consumer has no matching literal producer',
      `Job ${signal.job} downloads artifact ${signal.artifactName}, but no actions/upload-artifact step with that literal name exists in this workflow. The consumer may rely on an implicit, renamed, or otherwise unreviewed producer contract.`,
      'Define one literal upload-artifact producer for the consumed name, or make cross-run provenance explicit with run/repository identity and the dedicated cross-run controls.',
      strict ? 'critical' : 'high',
      strict,
    ));
    return findings;
  }

  if (signal.producerCount > 1 || signal.producerJobs.length > 1) {
    findings.push(finding(
      signal,
      'ci-artifact-lineage-producer-ambiguous',
      'Artifact name resolves to multiple producer steps or jobs',
      `Artifact ${signal.artifactName} can be uploaded by ${signal.producerCount} producer steps across ${signal.producerJobs.length} jobs. Download by name cannot prove which job supplied the bytes.`,
      'Give producer artifacts unique literal names per job and consume exactly one named artifact through an explicit needs dependency.',
      strict ? 'critical' : 'high',
      strict,
    ));
    return findings;
  }

  if (!signal.producerInNeedsAncestry) {
    findings.push(finding(
      signal,
      'ci-artifact-lineage-needs-missing',
      'Artifact producer is outside the consumer needs ancestry',
      `Job ${signal.job} downloads artifact ${signal.artifactName} from producer ${signal.producerJobs[0] ?? 'unknown'}, but that producer is not in the direct or transitive needs graph. Scheduling and success dependency are therefore not coupled to the artifact lineage.`,
      'Add the producer job to direct/transitive needs and require successful completion before artifact consumption. Keep release consumers dependent on every producer whose bytes they publish or execute.',
      strict ? 'critical' : 'high',
      strict,
    ));
  }

  if (signal.producerExternalContribution && signal.privileged) {
    findings.push(finding(
      signal,
      'ci-artifact-lineage-external-to-privileged',
      'Contribution-influenced artifact crosses into a privileged consumer',
      `Privileged job ${signal.job} consumes artifact ${signal.artifactName} from a workflow that accepts contribution-controlled events. Explicit needs ordering does not make producer bytes trusted.`,
      'Keep contribution-produced artifacts in read-only validation. For privileged promotion, require independently trusted provenance/digest and isolate producer authorization from pull-request-controlled code.',
      'critical',
      true,
    ));
  }

  return findings;
}

function cycleFindings(lineage: WorkflowLineage): Finding[] {
  const findings: Finding[] = [];
  for (const job of [...lineage.cyclicJobs].sort((left, right) => left.localeCompare(right, 'en'))) {
    const block = lineage.jobs.get(job);
    if (!block) continue;
    findings.push({
      id: 'ci-artifact-lineage-needs-cycle',
      domain: 'release',
      severity: 'high',
      blocking: true,
      title: 'Workflow job dependency graph contains a cycle',
      message: `Job ${job} participates in a cyclic needs graph. Artifact producer ancestry cannot be established deterministically and the workflow is structurally invalid for release gating.`,
      location: { file: lineage.file.repositoryPath, line: block.startLine },
      remediation: 'Break the needs cycle and keep artifact flow as a directed acyclic producer-to-consumer graph.',
      tags: ['ci', 'artifact', 'needs', 'dag', 'reliability'],
    });
  }
  return findings;
}

export function auditArtifactJobLineage(
  inventory: RepositoryInventory,
): AuditSection<ArtifactJobLineageSummary> {
  const started = performance.now();
  const producers: ArtifactProducerSignal[] = [];
  const consumers: ArtifactConsumerSignal[] = [];
  const findings: Finding[] = [];
  const files = workflowFiles(inventory);

  for (const file of files) {
    const lineage = buildLineage(file);
    const fileProducers: ArtifactProducerSignal[] = [];
    for (const block of lineage.jobs.values()) {
      for (const step of workflowStepBlocks(block)) {
        const producer = producerSignal(block, step);
        if (producer) fileProducers.push(producer);
      }
    }
    producers.push(...fileProducers);

    for (const block of lineage.jobs.values()) {
      for (const step of workflowStepBlocks(block)) {
        const consumer = consumerSignal(lineage, block, step, fileProducers);
        if (!consumer) continue;
        consumers.push(consumer);
        findings.push(...findingsFor(consumer));
      }
    }
    findings.push(...cycleFindings(lineage));
  }

  const canonical = stableSortFindings(findings);
  return {
    domain: 'security',
    title: 'Same-workflow artifact producer job-lineage audit',
    summary: {
      workflowFiles: files.length,
      artifactProducers: producers.length,
      artifactConsumers: consumers.length,
      sameWorkflowConsumers: consumers.filter(item => !item.crossRun).length,
      crossRunConsumersExcluded: consumers.filter(item => item.crossRun).length,
      privilegedConsumers: consumers.filter(item => item.privileged).length,
      unresolvedConsumers: consumers.filter(item => !item.crossRun && !item.broadSelector && !item.dynamicSelector && item.producerCount === 0).length,
      ambiguousConsumers: consumers.filter(item => !item.crossRun && item.producerCount > 1).length,
      lineageViolations: canonical.filter(item => item.id.startsWith('ci-artifact-lineage-')).length,
      producers,
      consumers,
      findings: canonical,
    },
    findings: canonical,
    elapsedMs: Math.max(0, performance.now() - started),
  };
}
