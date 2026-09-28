import {
  stableSortFindings,
  type AuditSection,
  type Finding,
  type RepositoryInventory,
} from './contracts.mts';
import {
  blockScalarLines,
  expressionSources,
  firstWorkflowField,
  hasExpression,
  hasUntrustedExpression,
  jobHasSecrets,
  jobHasWriteAuthority,
  unquoteYamlScalar,
  workflowFiles,
  workflowJobBlocks,
  workflowTopLevelBlock,
  workflowTriggerProfile,
  type WorkflowJobBlock,
  type WorkflowLine,
} from './workflow-structure.mts';
import {
  firstWorkflowStepField,
  stepDisplayName,
  workflowStepBlocks,
  type WorkflowStepBlock,
} from './workflow-step-structure.mts';

export type WorkingDirectorySource = 'workflow-default' | 'job-default' | 'step';

export interface WorkingDirectorySignal {
  readonly file: string;
  readonly job: string;
  readonly step: string;
  readonly line: number;
  readonly source: WorkingDirectorySource;
  readonly value: string;
  readonly externalContribution: boolean;
  readonly writeAuthority: boolean;
  readonly secrets: boolean;
  readonly untrusted: boolean;
  readonly dynamic: boolean;
  readonly parentTraversal: boolean;
  readonly absoluteOrExternal: boolean;
}

export interface WorkingDirectoryBoundarySummary {
  readonly workflowFiles: number;
  readonly runSteps: number;
  readonly configuredRunSteps: number;
  readonly dynamicDirectories: number;
  readonly escapingDirectories: number;
  readonly signals: readonly WorkingDirectorySignal[];
  readonly findings: readonly Finding[];
}

const FIELD = /^\s*([A-Za-z0-9_.-]+)\s*:\s*(.*)$/;
const INDIRECT = /\$\{\{[\s\S]*?(?:needs\.|matrix\.|vars\.)/i;
const PARENT_SEGMENT = /(?:^|[\/\\])\.\.(?:[\/\\]|$)/;
const WINDOWS_ABSOLUTE = /^[A-Za-z]:[\/\\]/;
const UNIX_ABSOLUTE = /^\//;
const HOME_OR_TEMP = /^(?:~(?:[\/\\]|$)|\$HOME(?:[\/\\]|$)|\$\{HOME\}(?:[\/\\]|$)|%USERPROFILE%(?:[\/\\]|$)|\$\{\{\s*runner\.temp\s*\}\}(?:[\/\\]|$)|\$RUNNER_TEMP(?:[\/\\]|$))/i;
const WORKSPACE = /^\$\{\{\s*github\.workspace\s*\}\}(?:[\/\\].*)?$/i;

interface DirectoryDefault {
  readonly value: string;
  readonly line: number;
  readonly source: Exclude<WorkingDirectorySource, 'step'>;
}

function directChildIndent(lines: readonly WorkflowLine[], parentIndent: number): number | undefined {
  let result: number | undefined;
  for (const line of lines) {
    if (!line.trimmed || line.trimmed.startsWith('#') || line.indent <= parentIndent) continue;
    if (!FIELD.test(line.text)) continue;
    if (result === undefined || line.indent < result) result = line.indent;
  }
  return result;
}

function nestedWorkingDirectory(
  lines: readonly WorkflowLine[],
  parentIndent: number,
  source: Exclude<WorkingDirectorySource, 'step'>,
): DirectoryDefault | undefined {
  const childIndent = directChildIndent(lines, parentIndent);
  if (childIndent === undefined) return undefined;
  const run = lines.find(line => line.indent === childIndent && /^\s*run\s*:\s*(?:#.*)?$/i.test(line.text));
  if (!run) return undefined;
  const runLines: WorkflowLine[] = [];
  for (const line of lines) {
    if (line.line <= run.line) continue;
    if (line.trimmed && line.indent <= run.indent) break;
    runLines.push(line);
  }
  const runChildIndent = directChildIndent(runLines, run.indent);
  if (runChildIndent === undefined) return undefined;
  const working = runLines.find(line => line.indent === runChildIndent && /^\s*working-directory\s*:/i.test(line.text));
  if (!working) return undefined;
  const match = working.text.match(FIELD);
  return {
    value: unquoteYamlScalar(match?.[2] ?? ''),
    line: working.line,
    source,
  };
}

function workflowDefault(block: WorkflowJobBlock): DirectoryDefault | undefined {
  const defaults = workflowTopLevelBlock(block.file, 'defaults');
  if (!defaults) return undefined;
  return nestedWorkingDirectory(defaults.lines, defaults.line.indent, 'workflow-default');
}

function jobDefault(block: WorkflowJobBlock): DirectoryDefault | undefined {
  const defaults = firstWorkflowField(block, 'defaults');
  if (!defaults) return undefined;
  return nestedWorkingDirectory(blockScalarLines(block, defaults), defaults.indent, 'job-default');
}

function effectiveDirectory(block: WorkflowJobBlock, step: WorkflowStepBlock): DirectoryDefault | undefined {
  const direct = firstWorkflowStepField(step, 'working-directory');
  if (direct) return { value: direct.value, line: direct.line, source: 'step' };
  return jobDefault(block) ?? workflowDefault(block);
}

function externalPath(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || WORKSPACE.test(trimmed)) return false;
  return UNIX_ABSOLUTE.test(trimmed) || WINDOWS_ABSOLUTE.test(trimmed) || HOME_OR_TEMP.test(trimmed);
}

function signalFor(block: WorkflowJobBlock, step: WorkflowStepBlock): WorkingDirectorySignal | undefined {
  if (!firstWorkflowStepField(step, 'run')) return undefined;
  const directory = effectiveDirectory(block, step);
  if (!directory) return undefined;
  const profile = workflowTriggerProfile(block.file);
  const value = directory.value.trim();
  return {
    file: block.file.repositoryPath,
    job: block.name,
    step: stepDisplayName(step),
    line: directory.line,
    source: directory.source,
    value,
    externalContribution: profile.externalContribution,
    writeAuthority: jobHasWriteAuthority(block),
    secrets: jobHasSecrets(block),
    untrusted: hasUntrustedExpression(value),
    dynamic: hasExpression(value),
    parentTraversal: PARENT_SEGMENT.test(value),
    absoluteOrExternal: externalPath(value),
  };
}

function location(item: WorkingDirectorySignal) {
  return { file: item.file, line: item.line };
}

function finding(
  item: WorkingDirectorySignal,
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
    evidence: { value: item.value, metadata: { job: item.job, step: item.step, source: item.source } },
    remediation,
    ...(blocking ? { blocking: true } : {}),
    tags: ['ci', 'working-directory', 'filesystem', 'execution-boundary'],
  };
}

function findingsFor(item: WorkingDirectorySignal): Finding[] {
  const findings: Finding[] = [];
  const privileged = item.writeAuthority || item.secrets;

  if (!item.value) {
    findings.push(finding(
      item,
      'ci-working-directory-empty',
      'medium',
      'Run step has an empty working-directory override',
      'An empty working-directory value makes the execution root ambiguous and can behave differently across parser/runtime changes.',
      'Remove the empty override or use an explicit repository-relative directory.',
    ));
    return findings;
  }

  if (item.untrusted) {
    const critical = item.externalContribution || privileged;
    findings.push(finding(
      item,
      'ci-working-directory-untrusted',
      critical ? 'critical' : 'high',
      'Untrusted workflow data selects command working directory',
      `Job ${item.job} derives working-directory from ${expressionSources(item.value).join(', ') || 'event/input data'}. Directory selection happens before shell execution and can redirect commands into attacker-controlled content.`,
      'Map validated identifiers to a closed set of repository-relative directories. Never pass event text, head refs, or free-form inputs directly to working-directory.',
      critical,
    ));
  } else if (item.dynamic && INDIRECT.test(item.value)) {
    findings.push(finding(
      item,
      'ci-working-directory-indirect',
      privileged ? 'high' : 'medium',
      'Working directory depends on indirect workflow provenance',
      `Job ${item.job} selects its execution directory from matrix, vars, or upstream output. A producer change can redirect later commands without changing the run step itself.`,
      'Constrain dynamic directories to a reviewed allowlist of repository-relative paths and validate upstream outputs before use.',
    ));
  }

  if (item.parentTraversal) {
    const critical = privileged || item.externalContribution;
    findings.push(finding(
      item,
      'ci-working-directory-parent-traversal',
      critical ? 'critical' : 'high',
      'Working directory escapes through parent traversal',
      `working-directory ${item.value} contains a parent path segment and may execute outside the reviewed repository subtree.`,
      'Use a normalized repository-relative child directory. Do not traverse above the checkout root for authoritative build, test, signing, or deployment commands.',
      critical,
    ));
  }

  if (item.absoluteOrExternal) {
    const critical = privileged && item.externalContribution;
    findings.push(finding(
      item,
      'ci-working-directory-external-root',
      critical ? 'critical' : privileged || item.externalContribution ? 'high' : 'medium',
      'Workflow executes commands from an external or machine-global directory',
      `working-directory ${item.value} resolves outside the normal repository-relative execution boundary. Host/home/temp content can outlive or bypass source review.`,
      'Run authoritative commands from the checked-out repository or an isolated verified workspace. Avoid home, temp, root, drive-absolute, and other machine-global execution roots.',
      critical,
    ));
  }

  return findings;
}

export function auditWorkingDirectoryBoundaries(
  inventory: RepositoryInventory,
): AuditSection<WorkingDirectoryBoundarySummary> {
  const started = performance.now();
  const files = workflowFiles(inventory);
  const jobs = files.flatMap(file => workflowJobBlocks(file));
  const allRunSteps = jobs.flatMap(block => workflowStepBlocks(block).filter(step => firstWorkflowStepField(step, 'run')));
  const signals = jobs.flatMap(block => workflowStepBlocks(block)
    .map(step => signalFor(block, step))
    .filter((item): item is WorkingDirectorySignal => item !== undefined));
  const findings = stableSortFindings(signals.flatMap(findingsFor));
  return {
    domain: 'security',
    title: 'Workflow working-directory execution-boundary audit',
    summary: {
      workflowFiles: files.length,
      runSteps: allRunSteps.length,
      configuredRunSteps: signals.length,
      dynamicDirectories: signals.filter(item => item.dynamic).length,
      escapingDirectories: signals.filter(item => item.parentTraversal || item.absoluteOrExternal).length,
      signals,
      findings,
    },
    findings,
    elapsedMs: Math.max(0, performance.now() - started),
  };
}
