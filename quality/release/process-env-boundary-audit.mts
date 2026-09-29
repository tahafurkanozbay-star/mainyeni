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
  stepNestedMapping,
  workflowStepBlocks,
  type WorkflowStepBlock,
} from './workflow-step-structure.mts';

export type ProcessEnvScope = 'workflow' | 'job' | 'step';

export interface ProcessEnvSignal {
  readonly file: string;
  readonly job: string | null;
  readonly step: number | null;
  readonly scope: ProcessEnvScope;
  readonly name: string;
  readonly value: string;
  readonly line: number;
  readonly externalContribution: boolean;
  readonly writeAuthority: boolean;
  readonly secrets: boolean;
  readonly untrusted: boolean;
  readonly dynamic: boolean;
}

export interface ProcessEnvBoundarySummary {
  readonly workflowFiles: number;
  readonly dangerousAssignments: number;
  readonly untrustedAssignments: number;
  readonly privilegedAssignments: number;
  readonly signals: readonly ProcessEnvSignal[];
  readonly findings: readonly Finding[];
}

const ENV_ENTRY = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/;
const DANGEROUS_ENV = /^(?:NODE_OPTIONS|BASH_ENV|ENV|LD_PRELOAD|LD_LIBRARY_PATH|PYTHONPATH|RUBYOPT|PERL5OPT|GIT_SSH_COMMAND|GIT_CONFIG_COUNT|GIT_CONFIG_KEY_\d+|GIT_CONFIG_VALUE_\d+|NPM_CONFIG_PREFIX|NODE_PATH)$/i;
const INTERPRETER_BOOTSTRAP = /^(?:NODE_OPTIONS|BASH_ENV|ENV|LD_PRELOAD|RUBYOPT|PERL5OPT|GIT_SSH_COMMAND)$/i;
const EXECUTION_FLAG = /(?:--require\b|--import\b|--loader\b|-r\s|--eval\b|-e\s|--inspect\b|\.so\b|\.dylib\b|\.dll\b|\.js\b|\.mjs\b|\.cjs\b|\.py\b|\.rb\b|\.pl\b|\bssh\b|\bProxyCommand\b)/i;
const WORKSPACE_OR_RELATIVE = /(?:^|[\s"'])(?:\.|\.\.|\$\{\{\s*github\.workspace\s*\}\}|\$GITHUB_WORKSPACE|%GITHUB_WORKSPACE%)(?:[\/\\]|$)/i;
const INDIRECT = /\$\{\{[\s\S]*?(?:needs\.|matrix\.|vars\.)/i;

interface EnvEntry {
  readonly name: string;
  readonly value: string;
  readonly line: number;
}

function entries(lines: readonly WorkflowLine[], directIndent?: number): EnvEntry[] {
  const candidates = directIndent === undefined
    ? lines.filter(line => line.trimmed && !line.trimmed.startsWith('#'))
    : lines.filter(line => line.indent === directIndent && line.trimmed && !line.trimmed.startsWith('#'));
  const result: EnvEntry[] = [];
  for (const line of candidates) {
    const match = line.text.match(ENV_ENTRY);
    const name = match?.[1];
    if (!name || !DANGEROUS_ENV.test(name)) continue;
    result.push({ name: name.toUpperCase(), value: unquoteYamlScalar(match?.[2] ?? ''), line: line.line });
  }
  return result;
}

function workflowEntries(block: WorkflowJobBlock): EnvEntry[] {
  const env = workflowTopLevelBlock(block.file, 'env');
  if (!env) return [];
  const indent = env.lines.find(line => line.trimmed && !line.trimmed.startsWith('#'))?.indent;
  return entries(env.lines, indent);
}

function jobEntries(block: WorkflowJobBlock): EnvEntry[] {
  const env = firstWorkflowField(block, 'env');
  if (!env) return [];
  const lines = blockScalarLines(block, env);
  const indent = lines.find(line => line.trimmed && !line.trimmed.startsWith('#'))?.indent;
  return entries(lines, indent);
}

function stepEntries(step: WorkflowStepBlock): EnvEntry[] {
  const mapping = stepNestedMapping(step, 'env');
  if (mapping.size === 0) return [];
  const envField = step.lines.find(line => /^\s*env\s*:/.test(line.text) && line.indent === step.indent + 2);
  const envLine = envField?.line ?? step.startLine;
  return [...mapping.entries()]
    .filter(([name]) => DANGEROUS_ENV.test(name))
    .map(([name, value], index) => ({ name: name.toUpperCase(), value, line: envLine + index + 1 }));
}

function context(block: WorkflowJobBlock) {
  const trigger = workflowTriggerProfile(block.file);
  return {
    externalContribution: trigger.externalContribution,
    writeAuthority: jobHasWriteAuthority(block),
    secrets: jobHasSecrets(block),
  };
}

function signal(
  block: WorkflowJobBlock,
  entry: EnvEntry,
  scope: ProcessEnvScope,
  step: number | null,
): ProcessEnvSignal {
  const authority = context(block);
  return {
    file: block.file.repositoryPath,
    job: block.name,
    step,
    scope,
    name: entry.name,
    value: entry.value,
    line: entry.line,
    ...authority,
    untrusted: hasUntrustedExpression(entry.value),
    dynamic: hasExpression(entry.value),
  };
}

function signalsFor(block: WorkflowJobBlock): ProcessEnvSignal[] {
  const result: ProcessEnvSignal[] = [];
  for (const entry of workflowEntries(block)) result.push(signal(block, entry, 'workflow', null));
  for (const entry of jobEntries(block)) result.push(signal(block, entry, 'job', null));
  for (const step of workflowStepBlocks(block)) {
    for (const entry of stepEntries(step)) result.push(signal(block, entry, 'step', step.index));
  }
  const seen = new Set<string>();
  return result.filter(item => {
    const key = `${item.scope}:${item.step ?? '-'}:${item.name}:${item.line}:${item.value}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function location(item: ProcessEnvSignal) {
  return { file: item.file, line: item.line };
}

function finding(
  item: ProcessEnvSignal,
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
    evidence: { value: `${item.name}=${item.value}`, metadata: { scope: item.scope, job: item.job ?? 'workflow' } },
    remediation,
    ...(blocking ? { blocking: true } : {}),
    tags: ['ci', 'environment', 'process', 'code-execution', 'trust-boundary'],
  };
}

function findingsFor(item: ProcessEnvSignal): Finding[] {
  const privileged = item.writeAuthority || item.secrets;
  const findings: Finding[] = [];

  if (item.untrusted) {
    const critical = item.externalContribution || privileged || INTERPRETER_BOOTSTRAP.test(item.name);
    findings.push(finding(
      item,
      'ci-process-env-untrusted-control',
      critical ? 'critical' : 'high',
      'Untrusted workflow data controls process execution environment',
      `${item.name} is assigned from event or caller-controlled data in ${item.scope} env scope. The variable can alter interpreter startup, module loading, library resolution, package behavior, or Git transport before a later command executes.`,
      'Remove event/input expressions from process-control environment variables. Map validated identifiers to reviewed literal values inside trusted workflow code.',
      critical,
    ));
  } else if (item.dynamic && INDIRECT.test(item.value)) {
    findings.push(finding(
      item,
      'ci-process-env-indirect-control',
      privileged ? 'high' : 'medium',
      'Process execution environment depends on indirect workflow provenance',
      `${item.name} is derived from matrix, vars, or upstream output. A producer change can silently alter interpreter or process behavior.`,
      'Prefer literal reviewed process settings. If indirection is necessary, validate upstream output against a closed allowlist before assigning it to execution-sensitive environment state.',
    ));
  }

  const bootstrap = INTERPRETER_BOOTSTRAP.test(item.name);
  const executableLiteral = EXECUTION_FLAG.test(item.value) || WORKSPACE_OR_RELATIVE.test(item.value);
  if (!item.dynamic && bootstrap && item.value.trim() && executableLiteral) {
    const critical = privileged || item.externalContribution;
    findings.push(finding(
      item,
      'ci-process-env-bootstrap-hook',
      critical ? 'critical' : 'high',
      'Workflow configures an interpreter or process bootstrap hook',
      `${item.name}=${item.value} can cause code or transport configuration to load implicitly before an explicit validation command.`,
      'Avoid interpreter preload/bootstrap hooks in authoritative CI. Invoke reviewed tools explicitly and keep privileged jobs free of implicit code-loading environment variables.',
      critical,
    ));
  }

  if (item.name === 'GIT_CONFIG_COUNT' && item.value.trim() && item.value.trim() !== '0') {
    findings.push(finding(
      item,
      'ci-process-env-git-config-injection',
      privileged ? 'critical' : 'high',
      'Workflow injects Git configuration through process environment',
      'GIT_CONFIG_COUNT enables paired GIT_CONFIG_KEY_n/GIT_CONFIG_VALUE_n environment entries that can rewrite Git protocol, credential, URL, hook, and transport behavior.',
      'Configure narrowly reviewed Git options with explicit git config commands in a trusted step, and never let contribution-controlled data select Git configuration keys or values.',
      privileged,
    ));
  }

  if (item.name === 'NPM_CONFIG_PREFIX' || item.name === 'NODE_PATH' || item.name === 'PYTHONPATH' || item.name === 'LD_LIBRARY_PATH') {
    if (item.value.trim() && (item.externalContribution || privileged || WORKSPACE_OR_RELATIVE.test(item.value))) {
      findings.push(finding(
        item,
        'ci-process-env-search-path-override',
        privileged ? 'high' : 'medium',
        'Workflow overrides an executable or module search path',
        `${item.name}=${item.value} changes how later tools resolve packages, modules, or libraries and can make repository-controlled paths authoritative.`,
        'Use tool-specific immutable installation paths and explicit command locations. Do not let contribution-controlled workspaces become implicit module/library search roots for privileged jobs.',
      ));
    }
  }

  return findings;
}

export function auditProcessEnvironmentBoundaries(
  inventory: RepositoryInventory,
): AuditSection<ProcessEnvBoundarySummary> {
  const started = performance.now();
  const files = workflowFiles(inventory);
  const allSignals = files.flatMap(file => workflowJobBlocks(file).flatMap(signalsFor));
  const findings = stableSortFindings(allSignals.flatMap(findingsFor));
  return {
    domain: 'security',
    title: 'Workflow process-environment execution-boundary audit',
    summary: {
      workflowFiles: files.length,
      dangerousAssignments: allSignals.length,
      untrustedAssignments: allSignals.filter(item => item.untrusted).length,
      privilegedAssignments: allSignals.filter(item => item.writeAuthority || item.secrets).length,
      signals: allSignals,
      findings,
    },
    findings,
    elapsedMs: Math.max(0, performance.now() - started),
  };
}
