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
  workflowFiles,
  workflowJobBlocks,
  workflowTriggerProfile,
  type WorkflowJobBlock,
  type WorkflowLine,
} from './workflow-structure.mts';

export interface MatrixTrustSignal {
  readonly file: string;
  readonly job: string;
  readonly hasMatrix: boolean;
  readonly matrixExpression: boolean;
  readonly untrustedMatrix: boolean;
  readonly fromJsonMatrix: boolean;
  readonly dimensions: number;
  readonly staticValues: number;
  readonly selfHostedValue: boolean;
  readonly maxParallel: number | null;
  readonly dynamicMaxParallel: boolean;
  readonly failFastFalse: boolean;
  readonly externalTrigger: boolean;
  readonly privileged: boolean;
}

export interface MatrixTrustSummary {
  readonly workflowFiles: number;
  readonly matrixJobs: number;
  readonly dynamicMatrixJobs: number;
  readonly untrustedMatrixJobs: number;
  readonly unboundedMatrixJobs: number;
  readonly signals: readonly MatrixTrustSignal[];
  readonly findings: readonly Finding[];
}

interface MatrixBlock {
  readonly line: WorkflowLine;
  readonly lines: readonly WorkflowLine[];
  readonly text: string;
  readonly scalar: string;
}

const FROM_JSON = /\bfromJSON\s*\(/i;
const SELF_HOSTED = /(?:^|[\s,\[])self-hosted(?:$|[\s,\]])/i;
const FAIL_FAST_FALSE = /^\s*fail-fast\s*:\s*false\s*(?:#.*)?$/im;
const DIMENSION = /^\s*([A-Za-z0-9_.-]+)\s*:\s*(.*)$/;
const RESERVED_MATRIX_KEYS = new Set(['include', 'exclude']);

function nestedBlock(lines: readonly WorkflowLine[], key: string, minimumIndent: number): MatrixBlock | undefined {
  const matcher = new RegExp(`^\\s*${key}\\s*:\\s*(.*)$`, 'i');
  const start = lines.find(line => line.indent > minimumIndent && matcher.test(line.text));
  if (!start) return undefined;
  const scalar = start.text.match(matcher)?.[1]?.trim() ?? '';
  const nested: WorkflowLine[] = [];
  for (const line of lines) {
    if (line.line <= start.line) continue;
    if (line.trimmed && line.indent <= start.indent) break;
    if (line.trimmed) nested.push(line);
  }
  return { line: start, lines: nested, text: [scalar, ...nested.map(line => line.text)].join('\n'), scalar };
}

function matrixBlock(job: WorkflowJobBlock): MatrixBlock | undefined {
  const strategy = nestedBlock(job.lines, 'strategy', job.indent);
  if (!strategy) return undefined;
  return nestedBlock([strategy.line, ...strategy.lines], 'matrix', strategy.line.indent);
}

function staticMatrixStats(matrix: MatrixBlock): { dimensions: number; staticValues: number } {
  const directIndent = matrix.lines
    .filter(line => DIMENSION.test(line.text))
    .reduce<number | undefined>((minimum, line) => minimum === undefined ? line.indent : Math.min(minimum, line.indent), undefined);
  if (directIndent === undefined) return { dimensions: 0, staticValues: 0 };

  let dimensions = 0;
  let staticValues = 0;
  for (const line of matrix.lines) {
    if (line.indent !== directIndent) continue;
    const match = line.text.match(DIMENSION);
    if (!match) continue;
    const key = (match[1] ?? '').toLowerCase();
    if (RESERVED_MATRIX_KEYS.has(key)) continue;
    dimensions += 1;
    const value = match[2] ?? '';
    const inline = value.match(/^\s*\[([^\]]*)\]/);
    if (inline) {
      staticValues += (inline[1] ?? '').split(',').map(item => item.trim()).filter(Boolean).length;
      continue;
    }
    if (value.trim() && !hasExpression(value)) staticValues += 1;
  }
  return { dimensions, staticValues };
}

function numericMaxParallel(job: WorkflowJobBlock): { value: number | null; dynamic: boolean } {
  const field = firstWorkflowField(job, 'max-parallel');
  if (!field) return { value: null, dynamic: false };
  if (hasExpression(field.value)) return { value: null, dynamic: true };
  const parsed = Number(field.value);
  return Number.isInteger(parsed) && parsed > 0 ? { value: parsed, dynamic: false } : { value: null, dynamic: false };
}

function signal(job: WorkflowJobBlock): MatrixTrustSignal | undefined {
  const matrix = matrixBlock(job);
  if (!matrix) return undefined;
  const text = matrix.text;
  const stats = staticMatrixStats(matrix);
  const maxParallel = numericMaxParallel(job);
  const trigger = workflowTriggerProfile(job.file);
  return {
    file: job.file.repositoryPath,
    job: job.name,
    hasMatrix: true,
    matrixExpression: hasExpression(text),
    untrustedMatrix: hasUntrustedExpression(text),
    fromJsonMatrix: FROM_JSON.test(text),
    dimensions: stats.dimensions,
    staticValues: stats.staticValues,
    selfHostedValue: SELF_HOSTED.test(text),
    maxParallel: maxParallel.value,
    dynamicMaxParallel: maxParallel.dynamic,
    failFastFalse: FAIL_FAST_FALSE.test(job.text),
    externalTrigger: trigger.externalContribution,
    privileged: jobHasWriteAuthority(job) || jobHasSecrets(job) || jobUsesProtectedEnvironment(job),
  };
}

function location(job: WorkflowJobBlock) {
  const matrix = matrixBlock(job);
  return { file: job.file.repositoryPath, line: matrix?.line.line ?? job.startLine };
}

function findings(job: WorkflowJobBlock): Finding[] {
  const current = signal(job);
  if (!current) return [];
  const result: Finding[] = [];
  const where = location(job);
  const matrix = matrixBlock(job)!;
  const sources = expressionSources(matrix.text);

  if (current.untrustedMatrix) {
    result.push({
      id: 'ci-matrix-untrusted-definition',
      domain: 'security',
      severity: 'critical',
      blocking: true,
      title: 'Matrix topology is constructed from untrusted workflow data',
      message: `Job ${job.name} derives matrix fan-out from ${sources.join(', ') || 'attacker-controlled expression'}; contributors can alter the number or identity of executable jobs.`,
      location: where,
      evidence: { value: matrix.text.slice(0, 500) },
      remediation: 'Define matrix dimensions in reviewed workflow source. If caller input is unavoidable, validate it against a small allowlist before converting it into matrix JSON.',
      tags: ['ci', 'matrix', 'fanout', 'expression-injection'],
    });
  } else if (current.fromJsonMatrix || current.matrixExpression) {
    result.push({
      id: 'ci-matrix-dynamic-definition-review',
      domain: 'security',
      severity: 'high',
      title: 'Matrix topology is generated dynamically',
      message: `Job ${job.name} uses expression-derived matrix structure; upstream outputs can silently widen executable fan-out.`,
      location: where,
      evidence: { value: matrix.text.slice(0, 500) },
      remediation: 'Keep release-critical matrix dimensions literal where possible. Validate upstream JSON and constrain allowed dimensions and values before fan-out.',
      tags: ['ci', 'matrix', 'fanout', 'provenance'],
    });
  }

  if (current.untrustedMatrix && current.privileged) {
    result.push({
      id: 'ci-matrix-untrusted-privilege-fanout',
      domain: 'security',
      severity: 'critical',
      blocking: true,
      title: 'Untrusted matrix controls privileged job fan-out',
      message: `Job ${job.name} combines attacker-controlled matrix topology with write authority, secrets, or an environment boundary. Every generated job inherits privileged execution context.`,
      location: where,
      remediation: 'Separate untrusted discovery from privileged execution. Pass only validated, signed, or explicitly approved outputs into a fixed trusted deployment matrix.',
      tags: ['ci', 'matrix', 'secrets', 'token', 'deployment'],
    });
  }

  if (current.externalTrigger && current.selfHostedValue) {
    result.push({
      id: 'ci-matrix-external-self-hosted-fanout',
      domain: 'security',
      severity: 'critical',
      blocking: true,
      title: 'External trigger can fan out across self-hosted runners',
      message: `Job ${job.name} exposes self-hosted runner labels through a matrix reachable from contribution-controlled events.`,
      location: where,
      remediation: 'Keep external validation on ephemeral hosted runners. Move self-hosted matrix execution behind trusted refs or protected environments.',
      tags: ['ci', 'matrix', 'runner', 'self-hosted'],
    });
  }

  if (current.dynamicMaxParallel) {
    result.push({
      id: 'ci-matrix-dynamic-max-parallel',
      domain: 'performance',
      severity: hasUntrustedExpression(firstWorkflowField(job, 'max-parallel')?.value ?? '') ? 'high' : 'medium',
      title: 'Matrix concurrency limit is selected dynamically',
      message: `Job ${job.name} does not use a literal max-parallel ceiling, so fan-out pressure can change outside reviewed source.`,
      location: { file: job.file.repositoryPath, line: firstWorkflowField(job, 'max-parallel')?.line ?? where.line },
      remediation: 'Use a small literal max-parallel value appropriate to runner and API capacity.',
      tags: ['ci', 'matrix', 'concurrency', 'availability'],
    });
  }

  if ((current.externalTrigger || current.untrustedMatrix) && current.maxParallel === null) {
    result.push({
      id: 'ci-matrix-unbounded-external-fanout',
      domain: 'performance',
      severity: current.untrustedMatrix ? 'critical' : 'high',
      ...(current.untrustedMatrix ? { blocking: true } : {}),
      title: 'Externally influenced matrix has no literal max-parallel ceiling',
      message: `Job ${job.name} can create concurrent work without an explicit repository-controlled fan-out bound.`,
      location: where,
      remediation: 'Set a literal max-parallel ceiling and keep externally influenced matrices small and validated.',
      tags: ['ci', 'matrix', 'concurrency', 'resource-exhaustion'],
    });
  }

  if (current.failFastFalse && current.maxParallel === null) {
    result.push({
      id: 'ci-matrix-fail-fast-disabled-unbounded',
      domain: 'performance',
      severity: current.externalTrigger ? 'high' : 'medium',
      title: 'Matrix disables fail-fast without a concurrency ceiling',
      message: `Job ${job.name} keeps all matrix branches running after failures while no literal max-parallel bound is configured.`,
      location: where,
      remediation: 'Set max-parallel and keep fail-fast enabled unless exhaustive execution is a deliberate bounded requirement.',
      tags: ['ci', 'matrix', 'concurrency', 'cost'],
    });
  }

  if (current.dimensions >= 3 && current.maxParallel === null) {
    result.push({
      id: 'ci-matrix-multidimensional-unbounded',
      domain: 'performance',
      severity: 'medium',
      title: 'Multi-dimensional matrix has no concurrency bound',
      message: `Job ${job.name} defines ${current.dimensions} matrix dimensions without max-parallel; Cartesian expansion can grow quickly as values are added.`,
      location: where,
      evidence: { value: current.dimensions },
      remediation: 'Set max-parallel and review the Cartesian product when adding matrix values.',
      tags: ['ci', 'matrix', 'concurrency', 'cost'],
    });
  }

  return result;
}

export function auditMatrixTrust(inventory: RepositoryInventory): AuditSection<MatrixTrustSummary> {
  const started = performance.now();
  const files = workflowFiles(inventory);
  const jobs = files.flatMap(file => workflowJobBlocks(file));
  const signals = jobs.map(signal).filter((item): item is MatrixTrustSignal => item !== undefined);
  const allFindings = stableSortFindings(jobs.flatMap(findings));
  return {
    domain: 'security',
    title: 'CI matrix provenance and bounded fan-out audit',
    summary: {
      workflowFiles: files.length,
      matrixJobs: signals.length,
      dynamicMatrixJobs: signals.filter(item => item.matrixExpression).length,
      untrustedMatrixJobs: signals.filter(item => item.untrustedMatrix).length,
      unboundedMatrixJobs: signals.filter(item => item.maxParallel === null).length,
      signals,
      findings: allFindings,
    },
    findings: allFindings,
    elapsedMs: Math.max(0, performance.now() - started),
  };
}
