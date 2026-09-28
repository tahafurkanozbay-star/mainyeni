import {
  stableSortFindings,
  type AuditSection,
  type Finding,
  type RepositoryInventory,
} from './contracts.mts';
import {
  blockScalarLines,
  firstWorkflowField,
  hasExpression,
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

export type ShellSource = 'workflow-default' | 'job-default' | 'step';

export interface ShellBoundarySignal {
  readonly file: string;
  readonly job: string;
  readonly step: string;
  readonly line: number;
  readonly source: ShellSource;
  readonly shell: string;
  readonly standardShell: boolean;
  readonly dynamic: boolean;
  readonly repositoryControlled: boolean;
  readonly customCommand: boolean;
  readonly placeholder: boolean;
  readonly externalContribution: boolean;
  readonly writeAuthority: boolean;
  readonly secrets: boolean;
}

export interface ShellBoundarySummary {
  readonly workflowFiles: number;
  readonly runSteps: number;
  readonly configuredShellSteps: number;
  readonly customShellSteps: number;
  readonly repositoryControlledShellSteps: number;
  readonly signals: readonly ShellBoundarySignal[];
  readonly findings: readonly Finding[];
}

const FIELD = /^\s*([A-Za-z0-9_.-]+)\s*:\s*(.*)$/;
const STANDARD_SHELL = /^(?:bash|sh|pwsh|powershell|cmd|python|python3)$/i;
const STANDARD_TEMPLATE = /^(?:\/usr\/bin\/)?(?:bash|sh)\b[^\n]*\{0\}\s*$|^(?:pwsh|powershell)\b[^\n]*\{0\}\s*$|^cmd\b[^\n]*\{0\}\s*$/i;
const REPOSITORY_PATH = /(?:^|\s)(?:\.\.?[\/\\]|\$\{\{\s*github\.workspace\s*\}\}[\/\\]|\$GITHUB_WORKSPACE[\/\\]|%GITHUB_WORKSPACE%[\/\\])[^\s]*/i;
const CUSTOM_BOOTSTRAP = /(?:^|\s)(?:sudo\b|eval\b|source\b|\.\s+[^\s]+|bash\s+-c\b|sh\s+-c\b|python\s+-c\b|node\s+(?:--require|-r|--import|--loader)\b)/i;
const ABSOLUTE_EXECUTABLE = /^(?:\/[A-Za-z0-9._/-]+|[A-Za-z]:[\\/][^\s]+)(?:\s|$)/;

interface ShellDefault {
  readonly value: string;
  readonly line: number;
  readonly source: ShellSource;
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

function nestedShell(
  lines: readonly WorkflowLine[],
  parentIndent: number,
  source: Exclude<ShellSource, 'step'>,
): ShellDefault | undefined {
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
  const runIndent = directChildIndent(runLines, run.indent);
  if (runIndent === undefined) return undefined;
  const shell = runLines.find(line => line.indent === runIndent && /^\s*shell\s*:/i.test(line.text));
  if (!shell) return undefined;
  const value = unquoteYamlScalar(shell.text.match(FIELD)?.[2] ?? '');
  return { value, line: shell.line, source };
}

function workflowDefault(block: WorkflowJobBlock): ShellDefault | undefined {
  const defaults = workflowTopLevelBlock(block.file, 'defaults');
  if (!defaults) return undefined;
  return nestedShell(defaults.lines, defaults.line.indent, 'workflow-default');
}

function jobDefault(block: WorkflowJobBlock): ShellDefault | undefined {
  const defaults = firstWorkflowField(block, 'defaults');
  if (!defaults) return undefined;
  return nestedShell(blockScalarLines(block, defaults), defaults.indent, 'job-default');
}

function effectiveShell(block: WorkflowJobBlock, step: WorkflowStepBlock): ShellDefault | undefined {
  const direct = firstWorkflowStepField(step, 'shell');
  if (direct) return { value: direct.value, line: direct.line, source: 'step' };
  return jobDefault(block) ?? workflowDefault(block);
}

function standard(shell: string): boolean {
  const trimmed = shell.trim();
  return STANDARD_SHELL.test(trimmed) || STANDARD_TEMPLATE.test(trimmed);
}

function signalFor(block: WorkflowJobBlock, step: WorkflowStepBlock): ShellBoundarySignal | undefined {
  if (!firstWorkflowStepField(step, 'run')) return undefined;
  const configured = effectiveShell(block, step);
  if (!configured) return undefined;
  const shell = configured.value.trim();
  const profile = workflowTriggerProfile(block.file);
  const standardShell = standard(shell);
  return {
    file: block.file.repositoryPath,
    job: block.name,
    step: stepDisplayName(step),
    line: configured.line,
    source: configured.source,
    shell,
    standardShell,
    dynamic: hasExpression(shell),
    repositoryControlled: REPOSITORY_PATH.test(shell),
    customCommand: !standardShell && shell.length > 0,
    placeholder: shell.includes('{0}'),
    externalContribution: profile.externalContribution,
    writeAuthority: jobHasWriteAuthority(block),
    secrets: jobHasSecrets(block),
  };
}

function location(item: ShellBoundarySignal) {
  return { file: item.file, line: item.line };
}

function finding(
  item: ShellBoundarySignal,
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
    evidence: { value: item.shell, metadata: { job: item.job, step: item.step, source: item.source } },
    remediation,
    ...(blocking ? { blocking: true } : {}),
    tags: ['ci', 'shell', 'execution-boundary', 'supply-chain'],
  };
}

function findingsFor(item: ShellBoundarySignal): Finding[] {
  if (item.dynamic) return [];
  const findings: Finding[] = [];
  const privileged = item.writeAuthority || item.secrets;

  if (!item.shell) {
    findings.push(finding(
      item,
      'ci-shell-empty',
      'medium',
      'Run step has an empty shell override',
      'An empty shell override makes command interpreter selection ambiguous and can fail differently across runners.',
      'Remove the empty override or select a reviewed standard shell explicitly.',
    ));
    return findings;
  }

  if (item.repositoryControlled) {
    const critical = item.externalContribution || privileged;
    findings.push(finding(
      item,
      'ci-shell-repository-wrapper',
      critical ? 'critical' : 'high',
      'Repository-controlled file is used as the command shell',
      `Shell template ${item.shell} executes a repository/workspace-controlled wrapper before every run script. Contribution code can therefore replace the interpreter boundary itself.`,
      'Use a runner-provided standard shell for validation. Invoke repository scripts as explicit run commands after checkout and privilege separation rather than as the shell executable.',
      critical,
    ));
  }

  if (item.customCommand && CUSTOM_BOOTSTRAP.test(item.shell)) {
    const critical = item.externalContribution || privileged;
    findings.push(finding(
      item,
      'ci-shell-bootstrap-command',
      critical ? 'critical' : 'high',
      'Custom shell template performs bootstrap execution',
      `Shell template ${item.shell} contains sudo/eval/source/-c/preload behavior before the generated run script executes.`,
      'Keep shell templates minimal and use a standard runner shell. Move setup into explicit reviewed steps with normal failure and privilege boundaries.',
      critical,
    ));
  }

  if (item.customCommand && !item.placeholder) {
    findings.push(finding(
      item,
      'ci-shell-placeholder-missing',
      'high',
      'Custom shell template omits the required script placeholder',
      `Custom GitHub Actions shell ${item.shell} does not contain {0}; the generated temporary script may not be executed as intended.`,
      'Use a supported named shell or include exactly one {0} placeholder in the custom shell command template.',
    ));
  }

  if (item.customCommand && ABSOLUTE_EXECUTABLE.test(item.shell) && !item.standardShell) {
    findings.push(finding(
      item,
      'ci-shell-host-specific-executable',
      privileged ? 'high' : 'medium',
      'Workflow depends on a host-specific shell executable path',
      `Shell template ${item.shell} binds authoritative execution to a machine-specific absolute executable outside the normal runner shell contract.`,
      'Prefer a supported named shell or provision the custom interpreter immutably with explicit version/provenance checks before use.',
    ));
  }

  if (item.customCommand && !item.repositoryControlled && !CUSTOM_BOOTSTRAP.test(item.shell) && !ABSOLUTE_EXECUTABLE.test(item.shell)) {
    findings.push(finding(
      item,
      'ci-shell-custom-command-review',
      privileged ? 'high' : 'medium',
      'Workflow uses a non-standard custom shell command',
      `Shell template ${item.shell} changes interpreter identity or flags beyond the standard GitHub-hosted shell contract.`,
      'Prefer bash/sh/pwsh/cmd/python named shells. If a custom shell is required, pin/provision it immutably and document why the template is safe.',
    ));
  }

  return findings;
}

export function auditShellBoundaries(
  inventory: RepositoryInventory,
): AuditSection<ShellBoundarySummary> {
  const started = performance.now();
  const files = workflowFiles(inventory);
  const jobs = files.flatMap(file => workflowJobBlocks(file));
  const allRunSteps = jobs.flatMap(block => workflowStepBlocks(block).filter(step => firstWorkflowStepField(step, 'run')));
  const signals = jobs.flatMap(block => workflowStepBlocks(block)
    .map(step => signalFor(block, step))
    .filter((item): item is ShellBoundarySignal => item !== undefined));
  const findings = stableSortFindings(signals.flatMap(findingsFor));
  return {
    domain: 'security',
    title: 'Workflow shell execution-boundary audit',
    summary: {
      workflowFiles: files.length,
      runSteps: allRunSteps.length,
      configuredShellSteps: signals.length,
      customShellSteps: signals.filter(item => item.customCommand).length,
      repositoryControlledShellSteps: signals.filter(item => item.repositoryControlled).length,
      signals,
      findings,
    },
    findings,
    elapsedMs: Math.max(0, performance.now() - started),
  };
}
