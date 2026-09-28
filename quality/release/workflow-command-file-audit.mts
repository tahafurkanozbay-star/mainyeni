import {
  stableSortFindings,
  type AuditSection,
  type Finding,
  type RepositoryInventory,
  type SourceFile,
} from './contracts.mts';
import { physicalLines, workflowFiles, type WorkflowLine } from './workflow-structure.mts';

export type WorkflowCommandTarget = 'env' | 'path' | 'output' | 'summary' | 'legacy';
export type WorkflowCommandTaint = 'event' | 'input' | 'none';

export interface WorkflowCommandSignal {
  readonly file: string;
  readonly line: number;
  readonly target: WorkflowCommandTarget;
  readonly taint: WorkflowCommandTaint;
  readonly taintedVariables: readonly string[];
  readonly sensitiveAssignment: string | null;
  readonly text: string;
}

export interface WorkflowCommandFileSummary {
  readonly workflowFiles: number;
  readonly commandFileWrites: number;
  readonly taintedWrites: number;
  readonly legacyCommands: number;
  readonly signals: readonly WorkflowCommandSignal[];
  readonly findings: readonly Finding[];
}

interface TaintedVariable {
  readonly name: string;
  readonly taint: Exclude<WorkflowCommandTaint, 'none'>;
}

const EVENT_EXPRESSION = /\$\{\{[\s\S]*?(?:github\.event\.|github\.head_ref\b)[\s\S]*?\}\}/i;
const INPUT_EXPRESSION = /\$\{\{[\s\S]*?inputs\.[\s\S]*?\}\}/i;
const ENV_DECLARATION = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.+)$/;
const TARGETS: ReadonlyArray<readonly [WorkflowCommandTarget, RegExp]> = [
  ['env', /(?:\$\{?GITHUB_ENV\}?|\$env:GITHUB_ENV\b)/i],
  ['path', /(?:\$\{?GITHUB_PATH\}?|\$env:GITHUB_PATH\b)/i],
  ['output', /(?:\$\{?GITHUB_OUTPUT\}?|\$env:GITHUB_OUTPUT\b)/i],
  ['summary', /(?:\$\{?GITHUB_STEP_SUMMARY\}?|\$env:GITHUB_STEP_SUMMARY\b)/i],
];
const LEGACY_COMMAND = /::(?:set-env\s+name=|add-path::|set-output\s+name=|save-state\s+name=)/i;
const LEGACY_SET_ENV = /::set-env\s+name=/i;
const LEGACY_ADD_PATH = /::add-path::/i;
const LEGACY_SET_OUTPUT = /::set-output\s+name=/i;
const SENSITIVE_ASSIGNMENT = /\b(PATH|NODE_OPTIONS|BASH_ENV|ENV|LD_PRELOAD|LD_LIBRARY_PATH|PYTHONPATH|RUBYOPT|PERL5OPT|GIT_SSH_COMMAND|GIT_CONFIG_COUNT|NPM_CONFIG_PREFIX)\s*=/i;

function taintOf(text: string): WorkflowCommandTaint {
  if (EVENT_EXPRESSION.test(text)) return 'event';
  if (INPUT_EXPRESSION.test(text)) return 'input';
  return 'none';
}

function collectTaintedVariables(file: SourceFile): TaintedVariable[] {
  const variables = new Map<string, Exclude<WorkflowCommandTaint, 'none'>>();
  for (const line of physicalLines(file.text)) {
    const match = line.text.match(ENV_DECLARATION);
    const name = match?.[1];
    const value = match?.[2] ?? '';
    if (!name) continue;
    const taint = taintOf(value);
    if (taint === 'event' || taint === 'input') variables.set(name, taint);
  }
  return [...variables.entries()].map(([name, taint]) => ({ name, taint }));
}

function variableReferenced(text: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:\\$\\{${escaped}\\}|\\$${escaped}\\b|\\$env:${escaped}\\b|%${escaped}%)`, 'i').test(text);
}

function referencedTaintedVariables(text: string, variables: readonly TaintedVariable[]): TaintedVariable[] {
  return variables.filter(variable => variableReferenced(text, variable.name));
}

function combinedTaint(text: string, variables: readonly TaintedVariable[]): WorkflowCommandTaint {
  const direct = taintOf(text);
  if (direct === 'event') return direct;
  const referenced = referencedTaintedVariables(text, variables);
  if (referenced.some(item => item.taint === 'event')) return 'event';
  if (direct === 'input' || referenced.some(item => item.taint === 'input')) return 'input';
  return 'none';
}

function targetFor(text: string): WorkflowCommandTarget | undefined {
  return TARGETS.find(([, pattern]) => pattern.test(text))?.[0];
}

function signalForLine(file: SourceFile, line: WorkflowLine, variables: readonly TaintedVariable[]): WorkflowCommandSignal | undefined {
  if (LEGACY_COMMAND.test(line.text)) {
    const referenced = referencedTaintedVariables(line.text, variables);
    return {
      file: file.repositoryPath,
      line: line.line,
      target: 'legacy',
      taint: combinedTaint(line.text, variables),
      taintedVariables: referenced.map(item => item.name).sort((left, right) => left.localeCompare(right, 'en')),
      sensitiveAssignment: line.text.match(SENSITIVE_ASSIGNMENT)?.[1]?.toUpperCase() ?? null,
      text: line.text.trim(),
    };
  }
  const target = targetFor(line.text);
  if (!target) return undefined;
  const referenced = referencedTaintedVariables(line.text, variables);
  return {
    file: file.repositoryPath,
    line: line.line,
    target,
    taint: combinedTaint(line.text, variables),
    taintedVariables: referenced.map(item => item.name).sort((left, right) => left.localeCompare(right, 'en')),
    sensitiveAssignment: line.text.match(SENSITIVE_ASSIGNMENT)?.[1]?.toUpperCase() ?? null,
    text: line.text.trim(),
  };
}

function signals(file: SourceFile): WorkflowCommandSignal[] {
  const variables = collectTaintedVariables(file);
  return physicalLines(file.text)
    .map(line => signalForLine(file, line, variables))
    .filter((item): item is WorkflowCommandSignal => item !== undefined);
}

function location(signal: WorkflowCommandSignal) {
  return { file: signal.file, line: signal.line };
}

function legacyFinding(signal: WorkflowCommandSignal): Finding {
  const critical = LEGACY_SET_ENV.test(signal.text) || LEGACY_ADD_PATH.test(signal.text);
  const high = LEGACY_SET_OUTPUT.test(signal.text);
  return {
    id: critical ? 'ci-legacy-workflow-command-dangerous' : 'ci-legacy-workflow-command-deprecated',
    domain: 'security',
    severity: critical ? 'critical' : high ? 'high' : 'medium',
    ...(critical ? { blocking: true } : {}),
    title: critical ? 'Workflow uses a dangerous legacy runner command' : 'Workflow uses a deprecated runner command',
    message: critical
      ? 'Legacy set-env/add-path workflow commands mutate runner process state through stdout command parsing and are unsafe release boundaries.'
      : 'Legacy set-output/save-state commands are deprecated and make command-channel parsing part of the release contract.',
    location: location(signal),
    evidence: { excerpt: signal.text },
    remediation: critical
      ? 'Replace legacy stdout commands with the corresponding GITHUB_ENV/GITHUB_PATH command file and validate every dynamic value before writing.'
      : 'Write outputs/state through the supported command-file mechanism and keep untrusted data out of command syntax.',
    tags: ['ci', 'workflow-command', 'runner', 'deprecation'],
  };
}

function envFinding(signal: WorkflowCommandSignal): Finding | undefined {
  if (signal.taint === 'none') return undefined;
  const sensitive = signal.sensitiveAssignment !== null;
  const critical = signal.taint === 'event' || sensitive;
  return {
    id: sensitive ? 'ci-command-env-sensitive-taint' : 'ci-command-env-untrusted-write',
    domain: 'security',
    severity: critical ? 'critical' : 'high',
    ...(critical ? { blocking: true } : {}),
    title: sensitive ? 'Untrusted data mutates a sensitive runner environment variable' : 'Untrusted data is written to GITHUB_ENV',
    message: sensitive
      ? `${signal.sensitiveAssignment ?? 'Sensitive environment state'} is written through GITHUB_ENV from ${signal.taint}-controlled data, which can redirect later executable behavior.`
      : `${signal.taint}-controlled data is written to GITHUB_ENV. Embedded newlines can create additional environment entries unless the value is constrained or encoded.`,
    location: location(signal),
    evidence: { excerpt: signal.text, metadata: { taint: signal.taint } },
    remediation: 'Validate to a narrow single-line format before command-file writes. Never allow event text to define variable names, delimiters, PATH-like state, interpreter options, or executable search locations.',
    tags: ['ci', 'github-env', 'command-file', 'injection'],
  };
}

function pathFinding(signal: WorkflowCommandSignal): Finding | undefined {
  if (signal.taint === 'none') return undefined;
  return {
    id: 'ci-command-path-untrusted-write',
    domain: 'security',
    severity: 'critical',
    blocking: true,
    title: 'Untrusted data is appended to GITHUB_PATH',
    message: `${signal.taint}-controlled data can add an executable search directory for later workflow steps.`,
    location: location(signal),
    evidence: { excerpt: signal.text, metadata: { taint: signal.taint } },
    remediation: 'Use a repository-controlled literal path. Never construct GITHUB_PATH entries from event payloads, refs, free-form inputs, downloaded artifacts, or unvalidated outputs.',
    tags: ['ci', 'github-path', 'command-file', 'code-execution'],
  };
}

function outputFinding(signal: WorkflowCommandSignal): Finding | undefined {
  if (signal.taint === 'none') return undefined;
  return {
    id: 'ci-command-output-untrusted-write',
    domain: 'security',
    severity: signal.taint === 'event' ? 'high' : 'medium',
    title: 'Untrusted data is promoted into a workflow step output',
    message: `${signal.taint}-controlled data is written to GITHUB_OUTPUT and can become trusted-looking needs/steps data in downstream jobs.`,
    location: location(signal),
    evidence: { excerpt: signal.text, metadata: { taint: signal.taint } },
    remediation: 'Validate and normalize outputs to a closed schema before publishing them. Downstream jobs must not use unvalidated outputs for shells, actions, runners, refs, paths, environments, or artifact identities.',
    tags: ['ci', 'github-output', 'command-file', 'provenance'],
  };
}

function summaryFinding(signal: WorkflowCommandSignal): Finding | undefined {
  if (signal.taint === 'none') return undefined;
  return {
    id: 'ci-command-summary-untrusted-content',
    domain: 'security',
    severity: 'low',
    title: 'Contribution-controlled data is written to the workflow summary',
    message: 'Untrusted text in GITHUB_STEP_SUMMARY can spoof human-readable release evidence even when it does not execute code.',
    location: location(signal),
    evidence: { excerpt: signal.text, metadata: { taint: signal.taint } },
    remediation: 'Escape or quote untrusted values and clearly label them as user-supplied data; never treat step-summary text as authoritative release evidence.',
    tags: ['ci', 'step-summary', 'evidence', 'spoofing'],
  };
}

function findingFor(signal: WorkflowCommandSignal): Finding | undefined {
  if (signal.target === 'legacy') return legacyFinding(signal);
  if (signal.target === 'env') return envFinding(signal);
  if (signal.target === 'path') return pathFinding(signal);
  if (signal.target === 'output') return outputFinding(signal);
  return summaryFinding(signal);
}

export function auditWorkflowCommandFiles(inventory: RepositoryInventory): AuditSection<WorkflowCommandFileSummary> {
  const started = performance.now();
  const files = workflowFiles(inventory);
  const allSignals = files.flatMap(signals);
  const findings = stableSortFindings(allSignals.map(findingFor).filter((item): item is Finding => item !== undefined));
  return {
    domain: 'security',
    title: 'GitHub Actions command-file and runner-command audit',
    summary: {
      workflowFiles: files.length,
      commandFileWrites: allSignals.filter(item => item.target !== 'legacy').length,
      taintedWrites: allSignals.filter(item => item.target !== 'legacy' && item.taint !== 'none').length,
      legacyCommands: allSignals.filter(item => item.target === 'legacy').length,
      signals: allSignals,
      findings,
    },
    findings,
    elapsedMs: Math.max(0, performance.now() - started),
  };
}
