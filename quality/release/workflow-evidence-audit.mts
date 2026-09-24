import {
  stableSortFindings,
  type AuditSection,
  type Finding,
  type RepositoryInventory,
  type SourceFile,
} from './contracts.mts';
import { createLineIndex, snippetAround } from './inventory.mts';

export type WorkflowEvidenceKind =
  | 'action'
  | 'command'
  | 'dependency-install'
  | 'dependency-audit'
  | 'lint'
  | 'typecheck'
  | 'test'
  | 'build'
  | 'artifact'
  | 'publish'
  | 'regression-baseline'
  | 'security-policy';

export interface WorkflowActionReference {
  readonly value: string;
  readonly action: string;
  readonly ref: string;
  readonly comment: string;
  readonly line: number;
  readonly immutable: boolean;
  readonly local: boolean;
  readonly docker: boolean;
}

export interface WorkflowRunCommand {
  readonly line: number;
  readonly command: string;
  readonly multiline: boolean;
}

export interface WorkflowStepEvidence {
  readonly name: string;
  readonly line: number;
  readonly action?: WorkflowActionReference;
  readonly run?: WorkflowRunCommand;
  readonly condition?: string;
  readonly workingDirectory?: string;
  readonly persistCredentials?: boolean;
  readonly nodeVersion?: string;
  readonly dotnetGlobalJson?: string;
  readonly kinds: readonly WorkflowEvidenceKind[];
}

export interface WorkflowJobEvidence {
  readonly name: string;
  readonly line: number;
  readonly runner: string | null;
  readonly timeoutMinutes: number | null;
  readonly permissions: Readonly<Record<string, string>>;
  readonly steps: readonly WorkflowStepEvidence[];
  readonly defaultsWorkingDirectory: string | null;
}

export interface WorkflowDocumentEvidence {
  readonly file: string;
  readonly name: string;
  readonly triggers: readonly string[];
  readonly permissions: Readonly<Record<string, string>>;
  readonly concurrencyGroup: string | null;
  readonly cancelInProgress: boolean;
  readonly jobs: readonly WorkflowJobEvidence[];
  readonly actions: readonly WorkflowActionReference[];
  readonly commands: readonly WorkflowRunCommand[];
}

export interface WorkflowEvidenceSummary {
  readonly workflows: readonly WorkflowDocumentEvidence[];
  readonly workflowCount: number;
  readonly jobCount: number;
  readonly stepCount: number;
  readonly actionCount: number;
  readonly immutableActionCount: number;
  readonly exactBaseEvidenceCount: number;
  readonly findings: readonly Finding[];
}

const WORKFLOW_PATH = /^\.github\/workflows\/[^/]+\.ya?ml$/iu;
const SHA40 = /^[0-9a-f]{40}$/iu;
const RELEASE_CRITICAL = new Set([
  '.github/workflows/webclient-quality.yml',
  '.github/workflows/release-qa.yml',
  '.github/workflows/platform-architecture-audit.yml',
  '.github/workflows/platform-typed-test-validation.yml',
  '.github/workflows/release-evidence-contract.yml',
]);
const WRITE_PERMISSIONS = new Set(['write', 'write-all']);
const DANGEROUS_TRIGGERS = new Set(['pull_request_target', 'workflow_run']);
const FORBIDDEN_SHELL = Object.freeze([
  Object.freeze({ id: 'workflow-shell-remote-download', pattern: /(?:^|[;&|()\s])(?:curl|wget)(?=$|[;&|()\s])/iu }),
  Object.freeze({ id: 'workflow-shell-privilege-escalation', pattern: /(?:^|[;&|()\s])sudo(?=$|[;&|()\s])/iu }),
  Object.freeze({ id: 'workflow-shell-dynamic-eval', pattern: /(?:^|[;&|()\s])eval(?=$|[;&|()\s])/iu }),
  Object.freeze({ id: 'workflow-shell-dynamic-source', pattern: /(?:^|[;&|()\s])source(?=$|[;&|()\s])/iu }),
  Object.freeze({ id: 'workflow-shell-unlocked-install', pattern: /(?:^|[;&|()\s])npm\s+(?:i|install)(?=$|[;&|()\s])/iu }),
]);
const UNTRUSTED_EXPRESSION = /\$\{\{[^}\n]*(?:github\.event\.|github\.head_ref|inputs\.|vars\.|secrets\.)[^}\n]*\}\}/iu;
const EXACT_BASE_SOURCE = /github\.event\.pull_request\.base\.sha/u;
const DETACHED_WORKTREE = /worktree\s+add\s+--detach/u;
const WORKTREE_CLEANUP = /worktree\s+remove\s+--force/u;

function workflowFiles(inventory: RepositoryInventory): SourceFile[] {
  return inventory.files
    .filter(file => WORKFLOW_PATH.test(file.repositoryPath))
    .sort((left, right) => left.repositoryPath.localeCompare(right.repositoryPath, 'en'));
}

function sourceLines(text: string): string[] {
  return text.split(/\r?\n/u);
}

function indentation(line: string): number {
  return line.length - line.trimStart().length;
}

function stripComment(line: string): string {
  let quote: '"' | "'" | null = null;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if ((char === '"' || char === "'") && (quote === null || quote === char)) {
      quote = quote === null ? char : null;
      continue;
    }
    if (char === '#' && quote === null) return line.slice(0, index);
  }
  return line;
}

function scalar(value: string): string {
  const clean = stripComment(value).trim();
  if (clean.length >= 2) {
    const first = clean[0];
    const last = clean.at(-1);
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return clean.slice(1, -1);
    }
  }
  return clean;
}

function topLevelBlock(lines: readonly string[], key: string): readonly string[] {
  const start = lines.findIndex(line => new RegExp(`^${key}:\\s*(?:#.*)?$`, 'u').test(line));
  if (start < 0) return Object.freeze([]);
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (!line.trim() || /^\s*#/u.test(line)) continue;
    if (indentation(line) === 0) {
      end = index;
      break;
    }
  }
  return Object.freeze(lines.slice(start, end));
}

function topLevelPermissions(lines: readonly string[]): Readonly<Record<string, string>> {
  const block = topLevelBlock(lines, 'permissions');
  if (block.length === 0) return Object.freeze({});
  const declaration = scalar((block[0] ?? '').replace(/^permissions:\s*/u, ''));
  if (declaration) return Object.freeze({ '*': declaration.toLowerCase() });
  const output: Record<string, string> = {};
  for (const line of block.slice(1)) {
    const match = stripComment(line).match(/^\s+([a-z-]+):\s*([^\s]+)\s*$/iu);
    if (!match) continue;
    output[match[1] ?? ''] = scalar(match[2] ?? '').toLowerCase();
  }
  return Object.freeze(output);
}

function triggerNames(lines: readonly string[]): readonly string[] {
  const declarationIndex = lines.findIndex(line => /^on:\s*/u.test(stripComment(line)));
  if (declarationIndex < 0) return Object.freeze([]);
  const declaration = stripComment(lines[declarationIndex] ?? '').replace(/^on:\s*/u, '').trim();
  if (declaration) {
    if (declaration.startsWith('[') && declaration.endsWith(']')) {
      return Object.freeze(
        declaration.slice(1, -1).split(',').map(item => scalar(item).toLowerCase()).filter(Boolean),
      );
    }
    return Object.freeze([scalar(declaration).toLowerCase()].filter(Boolean));
  }
  const block = topLevelBlock(lines, 'on');
  const names: string[] = [];
  for (const line of block.slice(1)) {
    const match = stripComment(line).match(/^\s{2}([a-zA-Z_][\w-]*):(?:\s|$)/u);
    if (match?.[1]) names.push(match[1].toLowerCase());
  }
  return Object.freeze(names);
}

function workflowName(lines: readonly string[], fallback: string): string {
  const line = lines.find(candidate => /^name:\s*/u.test(stripComment(candidate)));
  if (!line) return fallback;
  return scalar(stripComment(line).replace(/^name:\s*/u, '')) || fallback;
}

function concurrencyEvidence(lines: readonly string[]): { readonly group: string | null; readonly cancel: boolean } {
  const block = topLevelBlock(lines, 'concurrency');
  let group: string | null = null;
  let cancel = false;
  for (const line of block.slice(1)) {
    const clean = stripComment(line);
    const groupMatch = clean.match(/^\s+group:\s*(.*?)\s*$/u);
    if (groupMatch) group = scalar(groupMatch[1] ?? '') || null;
    if (/^\s+cancel-in-progress:\s*true\s*$/iu.test(clean)) cancel = true;
  }
  return Object.freeze({ group, cancel });
}

function blockEnd(lines: readonly string[], start: number, boundaryIndent: number): number {
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (!line.trim() || /^\s*#/u.test(line)) continue;
    if (indentation(line) <= boundaryIndent) return index;
  }
  return lines.length;
}

function parsePermissionsFromJob(lines: readonly string[]): Readonly<Record<string, string>> {
  const output: Record<string, string> = {};
  const index = lines.findIndex(line => /^\s{4}permissions:\s*/u.test(stripComment(line)));
  if (index < 0) return Object.freeze(output);
  const inline = scalar(stripComment(lines[index] ?? '').replace(/^\s{4}permissions:\s*/u, ''));
  if (inline) return Object.freeze({ '*': inline.toLowerCase() });
  for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
    const line = lines[cursor] ?? '';
    if (!line.trim() || /^\s*#/u.test(line)) continue;
    if (indentation(line) <= 4) break;
    const match = stripComment(line).match(/^\s{6}([a-z-]+):\s*([^\s]+)\s*$/iu);
    if (match?.[1] && match[2]) output[match[1]] = scalar(match[2]).toLowerCase();
  }
  return Object.freeze(output);
}

function parseAction(value: string, comment: string, line: number): WorkflowActionReference {
  const normalized = scalar(value);
  const local = normalized.startsWith('./') || normalized.startsWith('../');
  const docker = normalized.startsWith('docker://');
  const at = normalized.lastIndexOf('@');
  const action = at > 0 ? normalized.slice(0, at) : normalized;
  const ref = at > 0 ? normalized.slice(at + 1) : '';
  return Object.freeze({
    value: normalized,
    action,
    ref,
    comment: comment.trim(),
    line,
    immutable: local || docker || SHA40.test(ref),
    local,
    docker,
  });
}

function multilineRunBody(lines: readonly string[], start: number, runIndent: number): string {
  const body: string[] = [];
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (line.trim() && indentation(line) <= runIndent) break;
    body.push(line);
  }
  const nonBlank = body.filter(line => line.trim());
  if (nonBlank.length === 0) return '';
  const contentIndent = Math.min(...nonBlank.map(indentation));
  return body
    .map(line => (line.trim() ? line.slice(Math.min(contentIndent, line.length)) : ''))
    .join('\n')
    .replace(/\n+$/u, '');
}

function classifyCommand(command: string): readonly WorkflowEvidenceKind[] {
  const kinds = new Set<WorkflowEvidenceKind>(['command']);
  if (/\bnpm\s+ci\b/u.test(command)) kinds.add('dependency-install');
  if (/\b(?:npm\s+audit|dotnet\s+list\b[^\n]*package\b[^\n]*--vulnerable)\b/u.test(command)) kinds.add('dependency-audit');
  if (/\b(?:oxlint|npm\s+run\s+lint(?::strict)?)\b/u.test(command)) kinds.add('lint');
  if (/\b(?:tsc\b|typecheck)/u.test(command)) kinds.add('typecheck');
  if (/\b(?:vitest|node\s+--test|dotnet\s+run\b[^\n]*Tests|npm\s+(?:test|run\s+test))\b/iu.test(command)) kinds.add('test');
  if (/\b(?:vite\s+build|npm\s+run\s+build|dotnet\s+build)\b/u.test(command)) kinds.add('build');
  if (/\bdotnet\s+publish\b/u.test(command)) kinds.add('publish');
  if (EXACT_BASE_SOURCE.test(command) || DETACHED_WORKTREE.test(command)) kinds.add('regression-baseline');
  if (/\b(?:audit|security|integrity|policy|contract)\b/iu.test(command)) kinds.add('security-policy');
  return Object.freeze([...kinds]);
}

function parseSteps(jobLines: readonly string[], jobStartLine: number): readonly WorkflowStepEvidence[] {
  const steps: WorkflowStepEvidence[] = [];
  let currentName = '';
  let currentCondition: string | undefined;
  let currentWorkingDirectory: string | undefined;
  for (let index = 0; index < jobLines.length; index += 1) {
    const line = jobLines[index] ?? '';
    const absoluteLine = jobStartLine + index;
    const clean = stripComment(line);
    const nameMatch = clean.match(/^\s{6}-\s+name:\s*(.*?)\s*$/u);
    if (nameMatch) {
      currentName = scalar(nameMatch[1] ?? '');
      currentCondition = undefined;
      currentWorkingDirectory = undefined;
      continue;
    }
    const conditionMatch = clean.match(/^\s{8}if:\s*(.*?)\s*$/u);
    if (conditionMatch) {
      currentCondition = scalar(conditionMatch[1] ?? '');
      continue;
    }
    const workdirMatch = clean.match(/^\s{8}working-directory:\s*(.*?)\s*$/u);
    if (workdirMatch) {
      currentWorkingDirectory = scalar(workdirMatch[1] ?? '');
      continue;
    }
    const usesMatch = line.match(/^\s{8}uses:\s*([^\s#]+)(?:\s+#\s*(.*))?\s*$/u)
      ?? line.match(/^\s{6}-\s+uses:\s*([^\s#]+)(?:\s+#\s*(.*))?\s*$/u);
    if (usesMatch) {
      const action = parseAction(usesMatch[1] ?? '', usesMatch[2] ?? '', absoluteLine);
      const actionIndex = index;
      let persistCredentials: boolean | undefined;
      let nodeVersion: string | undefined;
      let dotnetGlobalJson: string | undefined;
      for (let cursor = actionIndex + 1; cursor < jobLines.length; cursor += 1) {
        const candidate = jobLines[cursor] ?? '';
        if (candidate.trim() && indentation(candidate) <= 6) break;
        const candidateClean = stripComment(candidate);
        const persist = candidateClean.match(/^\s+persist-credentials:\s*(true|false)\s*$/iu);
        if (persist) persistCredentials = persist[1]?.toLowerCase() === 'true';
        const node = candidateClean.match(/^\s+node-version:\s*(.*?)\s*$/u);
        if (node) nodeVersion = scalar(node[1] ?? '');
        const globalJson = candidateClean.match(/^\s+global-json-file:\s*(.*?)\s*$/u);
        if (globalJson) dotnetGlobalJson = scalar(globalJson[1] ?? '');
      }
      steps.push(Object.freeze({
        name: currentName || action.action,
        line: absoluteLine,
        action,
        ...(currentCondition ? { condition: currentCondition } : {}),
        ...(currentWorkingDirectory ? { workingDirectory: currentWorkingDirectory } : {}),
        ...(persistCredentials === undefined ? {} : { persistCredentials }),
        ...(nodeVersion ? { nodeVersion } : {}),
        ...(dotnetGlobalJson ? { dotnetGlobalJson } : {}),
        kinds: Object.freeze(['action'] as WorkflowEvidenceKind[]),
      }));
      continue;
    }
    const runMatch = line.match(/^\s{8}run:\s*(.*?)\s*$/u)
      ?? line.match(/^\s{6}-\s+run:\s*(.*?)\s*$/u);
    if (!runMatch) continue;
    const raw = (runMatch[1] ?? '').trim();
    const multiline = ['|', '>', '|-', '>-'].includes(raw);
    const command = multiline
      ? multilineRunBody(jobLines, index + 1, indentation(line))
      : scalar(raw);
    const run = Object.freeze({ line: absoluteLine, command, multiline });
    steps.push(Object.freeze({
      name: currentName || `run-${absoluteLine}`,
      line: absoluteLine,
      run,
      ...(currentCondition ? { condition: currentCondition } : {}),
      ...(currentWorkingDirectory ? { workingDirectory: currentWorkingDirectory } : {}),
      kinds: classifyCommand(command),
    }));
  }
  return Object.freeze(steps);
}

function parseJobs(lines: readonly string[]): readonly WorkflowJobEvidence[] {
  const jobsStart = lines.findIndex(line => /^jobs:\s*(?:#.*)?$/u.test(line));
  if (jobsStart < 0) return Object.freeze([]);
  const jobs: WorkflowJobEvidence[] = [];
  for (let index = jobsStart + 1; index < lines.length; index += 1) {
    const clean = stripComment(lines[index] ?? '');
    if (!clean.trim() || /^\s*#/u.test(clean)) continue;
    if (indentation(clean) === 0) break;
    const match = clean.match(/^\s{2}([A-Za-z_][\w-]*):\s*$/u);
    if (!match?.[1]) continue;
    const end = blockEnd(lines, index, 2);
    const block = lines.slice(index, end);
    const runnerLine = block.find(line => /^\s{4}runs-on:\s*/u.test(stripComment(line)));
    const timeoutLine = block.find(line => /^\s{4}timeout-minutes:\s*/u.test(stripComment(line)));
    const defaultsIndex = block.findIndex(line => /^\s{4}defaults:\s*$/u.test(stripComment(line)));
    let defaultsWorkingDirectory: string | null = null;
    if (defaultsIndex >= 0) {
      for (let cursor = defaultsIndex + 1; cursor < block.length; cursor += 1) {
        const line = block[cursor] ?? '';
        if (line.trim() && indentation(line) <= 4) break;
        const workdir = stripComment(line).match(/^\s+working-directory:\s*(.*?)\s*$/u);
        if (workdir) defaultsWorkingDirectory = scalar(workdir[1] ?? '') || null;
      }
    }
    const timeoutRaw = timeoutLine
      ? scalar(stripComment(timeoutLine).replace(/^\s{4}timeout-minutes:\s*/u, ''))
      : '';
    const timeoutNumber = /^\d+$/u.test(timeoutRaw) ? Number(timeoutRaw) : null;
    jobs.push(Object.freeze({
      name: match[1],
      line: index + 1,
      runner: runnerLine
        ? scalar(stripComment(runnerLine).replace(/^\s{4}runs-on:\s*/u, '')) || null
        : null,
      timeoutMinutes: timeoutNumber,
      permissions: parsePermissionsFromJob(block),
      steps: parseSteps(block, index + 1),
      defaultsWorkingDirectory,
    }));
    index = end - 1;
  }
  return Object.freeze(jobs);
}

export function parseWorkflowEvidence(file: SourceFile): WorkflowDocumentEvidence {
  const lines = sourceLines(file.text);
  const jobs = parseJobs(lines);
  const actions = jobs.flatMap(job => job.steps.flatMap(step => step.action ? [step.action] : []));
  const commands = jobs.flatMap(job => job.steps.flatMap(step => step.run ? [step.run] : []));
  const concurrency = concurrencyEvidence(lines);
  return Object.freeze({
    file: file.repositoryPath,
    name: workflowName(lines, file.repositoryPath),
    triggers: triggerNames(lines),
    permissions: topLevelPermissions(lines),
    concurrencyGroup: concurrency.group,
    cancelInProgress: concurrency.cancel,
    jobs,
    actions: Object.freeze(actions),
    commands: Object.freeze(commands),
  });
}

function location(file: string, line: number): { readonly file: string; readonly line: number } {
  return Object.freeze({ file, line: Math.max(1, line) });
}

function releaseFinding(
  id: string,
  severity: Finding['severity'],
  file: string,
  line: number,
  title: string,
  message: string,
  remediation: string,
  blocking = false,
  excerpt?: string,
): Finding {
  return Object.freeze({
    id,
    domain: 'release',
    severity,
    title,
    message,
    location: location(file, line),
    ...(excerpt ? { evidence: { excerpt } } : {}),
    remediation,
    ...(blocking ? { blocking: true } : {}),
    tags: Object.freeze(['ci', 'release-evidence']),
  });
}

function securityFinding(
  id: string,
  severity: Finding['severity'],
  file: string,
  line: number,
  title: string,
  message: string,
  remediation: string,
  blocking = false,
  excerpt?: string,
): Finding {
  return Object.freeze({
    id,
    domain: 'security',
    severity,
    title,
    message,
    location: location(file, line),
    ...(excerpt ? { evidence: { excerpt } } : {}),
    remediation,
    ...(blocking ? { blocking: true } : {}),
    tags: Object.freeze(['ci', 'supply-chain', 'release-evidence']),
  });
}

function workflowPermissionFindings(workflow: WorkflowDocumentEvidence): Finding[] {
  const findings: Finding[] = [];
  const contents = workflow.permissions.contents;
  const aggregate = workflow.permissions['*'];
  if (contents !== 'read' || aggregate) {
    findings.push(securityFinding(
      'release-workflow-permission-boundary',
      'high',
      workflow.file,
      1,
      'Release workflow token boundary is not explicit read-only',
      `${workflow.name} must explicitly grant contents: read at workflow scope.`,
      'Declare top-level permissions with contents: read and no aggregate permission scalar.',
    ));
  }
  for (const [scope, level] of Object.entries(workflow.permissions)) {
    if (!WRITE_PERMISSIONS.has(level)) continue;
    findings.push(securityFinding(
      'release-workflow-write-permission',
      'high',
      workflow.file,
      1,
      'Release workflow grants write-capable token authority',
      `${workflow.name} grants ${scope}: ${level}; read-only release validation must not gain repository mutation authority.`,
      'Remove workflow-level write permission and isolate any required publisher in a separately reviewed trusted workflow.',
    ));
  }
  for (const job of workflow.jobs) {
    for (const [scope, level] of Object.entries(job.permissions)) {
      if (!WRITE_PERMISSIONS.has(level) && level !== 'read-all') continue;
      findings.push(securityFinding(
        'release-job-permission-escalation',
        'high',
        workflow.file,
        job.line,
        'Release job widens token authority',
        `${job.name} overrides token permissions with ${scope}: ${level}.`,
        'Keep validation jobs read-only and do not widen job-level token permissions.',
      ));
    }
  }
  return findings;
}

function workflowReliabilityFindings(workflow: WorkflowDocumentEvidence): Finding[] {
  const findings: Finding[] = [];
  if (!workflow.concurrencyGroup || !workflow.cancelInProgress) {
    findings.push(releaseFinding(
      'release-workflow-concurrency-gap',
      'medium',
      workflow.file,
      1,
      'Release workflow lacks superseded-run cancellation',
      `${workflow.name} must group runs by pull request/ref and cancel obsolete candidates.`,
      'Add a ref/PR-scoped concurrency group with cancel-in-progress: true.',
    ));
  }
  for (const trigger of workflow.triggers) {
    if (!DANGEROUS_TRIGGERS.has(trigger)) continue;
    findings.push(securityFinding(
      'release-workflow-privileged-trigger',
      'critical',
      workflow.file,
      1,
      'Release workflow uses a privileged untrusted-code trigger',
      `${workflow.name} uses ${trigger}, which can create a privileged execution boundary for untrusted contribution metadata or code.`,
      'Use pull_request for validation and reserve privileged triggers for metadata-only workflows that never execute pull-request code.',
      true,
    ));
  }
  for (const job of workflow.jobs) {
    if (job.runner !== 'ubuntu-latest' && job.runner !== 'ubuntu-24.04') {
      findings.push(releaseFinding(
        'release-job-runner-drift',
        'medium',
        workflow.file,
        job.line,
        'Release job runner is outside the reviewed hosted runner set',
        `${job.name} runs on ${job.runner ?? '(missing)'}.`,
        'Use the reviewed GitHub-hosted ubuntu-latest or ubuntu-24.04 runner.',
      ));
    }
    if (job.timeoutMinutes === null || job.timeoutMinutes < 1 || job.timeoutMinutes > 120) {
      findings.push(releaseFinding(
        'release-job-timeout-gap',
        'medium',
        workflow.file,
        job.line,
        'Release job has no bounded static timeout',
        `${job.name} must have a static timeout between 1 and 120 minutes.`,
        'Set timeout-minutes explicitly so hung release validation cannot consume unbounded runner time.',
      ));
    }
  }
  return findings;
}

function workflowActionFindings(workflow: WorkflowDocumentEvidence): Finding[] {
  const findings: Finding[] = [];
  for (const action of workflow.actions) {
    if (action.local || action.docker) continue;
    if (!action.immutable) {
      findings.push(securityFinding(
        'release-action-mutable-provenance',
        'high',
        workflow.file,
        action.line,
        'Release action is referenced by mutable provenance',
        `${action.action}@${action.ref || '(missing)'} can change executable CI code without a repository diff.`,
        'Pin the reviewed action release to a full 40-character commit SHA and retain the release tag as a comment.',
        false,
        action.value,
      ));
    }
    if (action.action === 'actions/checkout') {
      const step = workflow.jobs.flatMap(job => job.steps).find(candidate => candidate.action?.line === action.line);
      if (step?.persistCredentials !== false) {
        findings.push(securityFinding(
          'release-checkout-credential-persistence',
          'medium',
          workflow.file,
          action.line,
          'Release checkout leaves repository credentials available to validation code',
          'Repository-controlled tests and build scripts execute after checkout while the token remains configured.',
          'Set persist-credentials: false on every read-only validation checkout.',
        ));
      }
    }
    if (action.action === 'actions/setup-node') {
      const step = workflow.jobs.flatMap(job => job.steps).find(candidate => candidate.action?.line === action.line);
      if (step?.nodeVersion !== '24') {
        findings.push(releaseFinding(
          'release-node-runtime-drift',
          'high',
          workflow.file,
          action.line,
          'Release workflow does not explicitly use Node 24',
          `${workflow.name} setup-node step selected ${step?.nodeVersion ?? '(missing)'}.`,
          'Keep release validation on the repository Node 24 runtime contract.',
        ));
      }
    }
  }
  return findings;
}

function commandSegments(command: string): readonly string[] {
  return Object.freeze(
    command
      .split(/\r?\n/u)
      .flatMap(line => line.split(/(?:&&|\|\||;|\|)/u))
      .map(segment => segment.trim())
      .filter(Boolean),
  );
}

function workflowCommandFindings(workflow: WorkflowDocumentEvidence): Finding[] {
  const findings: Finding[] = [];
  const file = workflow.file;
  for (const command of workflow.commands) {
    if (UNTRUSTED_EXPRESSION.test(command.command)) {
      findings.push(securityFinding(
        'release-shell-untrusted-expression',
        'high',
        file,
        command.line,
        'Release shell directly interpolates untrusted workflow data',
        'Event/input/variable/secret expressions must not be interpolated into repository-controlled shell commands.',
        'Pass immutable metadata through constrained environment variables or avoid shell interpolation entirely.',
        false,
        command.command.slice(0, 240),
      ));
    }
    for (const rule of FORBIDDEN_SHELL) {
      if (!rule.pattern.test(command.command)) continue;
      findings.push(securityFinding(
        rule.id,
        'high',
        file,
        command.line,
        'Release shell crosses the reviewed execution boundary',
        `Command matches forbidden release-shell policy ${rule.id}.`,
        'Use lockfile-backed local tooling and reviewed immutable actions; do not dynamically download or elevate executable validation code.',
        false,
        command.command.slice(0, 240),
      ));
    }
    for (const segment of commandSegments(command.command)) {
      const match = /^(?:command\s+)?npx\b([\s\S]*)$/u.exec(segment);
      if (!match) continue;
      const argumentsText = match[1] ?? '';
      if (/(?:^|\s)(?:--yes|-y)(?:\s|$)/u.test(argumentsText)) {
        findings.push(securityFinding(
          'release-npx-auto-install',
          'high',
          file,
          command.line,
          'Release npx invocation explicitly permits automatic package installation',
          segment,
          'Use a lockfile-installed tool and npx --no-install, or an npm script backed by the repository lockfile.',
        ));
      }
      if (!/(?:^|\s)--no-install(?:\s|$)/u.test(argumentsText)) {
        findings.push(securityFinding(
          'release-npx-local-only-missing',
          'medium',
          file,
          command.line,
          'Release npx invocation may resolve a package outside the lockfile',
          segment,
          'Add --no-install or invoke the lockfile-backed package script.',
        ));
      }
    }
  }
  return findings;
}

function requiredStepFindings(
  workflow: WorkflowDocumentEvidence,
  requiredNames: readonly string[],
): Finding[] {
  const present = new Set(workflow.jobs.flatMap(job => job.steps.map(step => step.name)));
  return requiredNames
    .filter(name => !present.has(name))
    .map(name => releaseFinding(
      'release-required-step-missing',
      'high',
      workflow.file,
      1,
      'Release workflow is missing required evidence',
      `${workflow.name} is missing the required step “${name}”.`,
      'Restore the release evidence step without weakening its failure behavior.',
    ));
}

function exactBaseFindings(workflow: WorkflowDocumentEvidence): Finding[] {
  if (workflow.file !== '.github/workflows/webclient-quality.yml'
    && workflow.file !== '.github/workflows/release-qa.yml') return [];
  const joined = workflow.commands.map(command => command.command).join('\n');
  const findings: Finding[] = [];
  if (!EXACT_BASE_SOURCE.test(joined)) {
    findings.push(releaseFinding(
      'release-exact-base-source-missing',
      'high',
      workflow.file,
      1,
      'Release regression gate is not anchored to the exact PR base SHA',
      `${workflow.name} does not derive regression evidence from github.event.pull_request.base.sha.`,
      'Use the exact pull-request base SHA rather than a moving branch ref.',
    ));
  }
  if (!DETACHED_WORKTREE.test(joined)) {
    findings.push(releaseFinding(
      'release-exact-base-worktree-missing',
      'high',
      workflow.file,
      1,
      'Release regression gate does not isolate the exact base tree',
      `${workflow.name} lacks a detached worktree for baseline execution.`,
      'Materialize the exact base SHA in a detached worktree before comparing diagnostics.',
    ));
  }
  if (!WORKTREE_CLEANUP.test(joined)) {
    findings.push(releaseFinding(
      'release-baseline-cleanup-missing',
      'medium',
      workflow.file,
      1,
      'Release baseline worktree cleanup is not explicit',
      `${workflow.name} should remove detached baseline worktrees on success and failure.`,
      'Install a trap/final cleanup path that force-removes the temporary worktree.',
    ));
  }
  return findings;
}

function workflowSpecificFindings(workflow: WorkflowDocumentEvidence): Finding[] {
  if (workflow.file === '.github/workflows/webclient-quality.yml') {
    return [
      ...requiredStepFindings(workflow, [
        'Install from lockfile',
        'Dependency and lockfile contract',
        'Production dependency audit',
        'Full lint visibility',
        'Strict lint on changed Webclient sources',
        'Full TypeScript diagnostic visibility',
        'Exact-base TypeScript regression gate',
        'Full Vitest diagnostic visibility',
        'Exact-base Vitest regression gate',
        'Native tooling regression suite',
        'Production Vite build and integrity manifest',
        'Verify production bundle integrity',
        'Enforce production build budgets',
      ]),
      ...exactBaseFindings(workflow),
    ];
  }
  if (workflow.file === '.github/workflows/release-qa.yml') {
    const jobNames = new Set(workflow.jobs.map(job => job.name));
    const findings: Finding[] = [];
    for (const name of ['typed-release-audit', 'webclient-release-validation', 'backend-release-validation']) {
      if (jobNames.has(name)) continue;
      findings.push(releaseFinding(
        'release-lane-missing',
        'high',
        workflow.file,
        1,
        'Release QA is missing a required validation lane',
        `Release QA must contain the ${name} job.`,
        'Restore independent typed, webclient and backend release validation lanes.',
      ));
    }
    findings.push(...requiredStepFindings(workflow, [
      'TypeScript 7.0.2 strict typecheck',
      'Typed QA unit and regression tests',
      'Generate whole-repository release scorecard',
      'Enforce exact-base PR regression gate',
      'Dependency and lockfile contract',
      'Production dependency audit',
      'Release build',
      'Run xUnit v3 tests through Microsoft.Testing.Platform',
      'Publish User API',
      'Publish Admin API',
    ]));
    findings.push(...exactBaseFindings(workflow));
    return findings;
  }
  if (workflow.file === '.github/workflows/platform-architecture-audit.yml') {
    return requiredStepFindings(workflow, [
      'Enforce modernization contracts',
      'Enforce typed module graph',
      'Enforce language modernization ratchet',
      'Enforce Platform responsibility boundaries',
      'Enforce browser runtime boundary',
      'Audit package lock integrity',
    ]);
  }
  if (workflow.file === '.github/workflows/platform-typed-test-validation.yml') {
    return requiredStepFindings(workflow, [
      'Install from lockfile',
      'Production dependency audit',
      'Enforce Platform language ratchet',
      'Strict Platform test TypeScript',
      'Focused migrated Platform tests',
    ]);
  }
  if (workflow.file === '.github/workflows/release-evidence-contract.yml') {
    return requiredStepFindings(workflow, [
      'Audit adversarial fixture suite',
      'Verify-chain bypass security contract',
      'Workflow supply-chain security contract',
      'Workflow action allowlist contract',
      'Workflow shell security contract',
      'Workflow npx local-only security contract',
      'Workflow permission and trigger contract',
      'Workflow bounded-execution reliability contract',
      'Audit embedded smoke fixtures',
      'Enforce candidate release evidence',
    ]);
  }
  return [];
}

function orderingFindings(workflow: WorkflowDocumentEvidence): Finding[] {
  const names = workflow.jobs.flatMap(job => job.steps.map(step => step.name));
  const index = (name: string): number => names.indexOf(name);
  const findings: Finding[] = [];
  if (workflow.file === '.github/workflows/webclient-quality.yml') {
    const type = index('Exact-base TypeScript regression gate');
    const test = index('Exact-base Vitest regression gate');
    const build = index('Production Vite build and integrity manifest');
    if (type < 0 || test < 0 || build < 0 || !(type < test && test < build)) {
      findings.push(releaseFinding(
        'release-webclient-gate-order',
        'high',
        workflow.file,
        1,
        'Webclient release evidence executes in unsafe order',
        'Exact-base TypeScript and Vitest gates must both succeed before the production build is considered release evidence.',
        'Keep exact-base typecheck before exact-base Vitest and both before production build/integrity/budget enforcement.',
      ));
    }
  }
  return findings;
}

function workflowFindings(workflow: WorkflowDocumentEvidence): Finding[] {
  return [
    ...workflowPermissionFindings(workflow),
    ...workflowReliabilityFindings(workflow),
    ...workflowActionFindings(workflow),
    ...workflowCommandFindings(workflow),
    ...workflowSpecificFindings(workflow),
    ...orderingFindings(workflow),
  ];
}

function missingCriticalWorkflowFindings(workflows: readonly WorkflowDocumentEvidence[]): Finding[] {
  const present = new Set(workflows.map(workflow => workflow.file));
  const findings: Finding[] = [];
  for (const file of RELEASE_CRITICAL) {
    if (present.has(file)) continue;
    findings.push(releaseFinding(
      'release-critical-workflow-missing',
      'high',
      file,
      1,
      'Release-critical workflow is missing',
      `${file} is required to provide independent release evidence.`,
      'Restore the release-critical workflow and its fail-closed evidence contract.',
    ));
  }
  return findings;
}

export function auditWorkflowEvidence(
  inventory: RepositoryInventory,
): AuditSection<WorkflowEvidenceSummary> {
  const startedAt = performance.now();
  const parsed = workflowFiles(inventory).map(parseWorkflowEvidence);
  const critical = parsed.filter(workflow => RELEASE_CRITICAL.has(workflow.file));
  const findings = stableSortFindings([
    ...missingCriticalWorkflowFindings(parsed),
    ...critical.flatMap(workflowFindings),
  ]);
  const actions = critical.flatMap(workflow => workflow.actions);
  const commands = critical.flatMap(workflow => workflow.commands);
  const exactBaseEvidenceCount = commands.filter(command =>
    EXACT_BASE_SOURCE.test(command.command) || DETACHED_WORKTREE.test(command.command)).length;
  return {
    domain: 'release',
    title: 'Release workflow semantic evidence audit',
    summary: {
      workflows: critical,
      workflowCount: critical.length,
      jobCount: critical.reduce((sum, workflow) => sum + workflow.jobs.length, 0),
      stepCount: critical.reduce(
        (sum, workflow) => sum + workflow.jobs.reduce((jobSum, job) => jobSum + job.steps.length, 0),
        0,
      ),
      actionCount: actions.length,
      immutableActionCount: actions.filter(action => action.immutable).length,
      exactBaseEvidenceCount,
      findings,
    },
    findings,
    elapsedMs: Math.max(0, performance.now() - startedAt),
  };
}

export function workflowEvidenceMarkdown(section: AuditSection<WorkflowEvidenceSummary>): string {
  const { summary } = section;
  const lines: string[] = [
    '# Release Workflow Evidence',
    '',
    `- Workflows: ${summary.workflowCount}`,
    `- Jobs: ${summary.jobCount}`,
    `- Steps: ${summary.stepCount}`,
    `- Actions: ${summary.actionCount}`,
    `- Immutable actions: ${summary.immutableActionCount}`,
    `- Exact-base evidence commands: ${summary.exactBaseEvidenceCount}`,
    `- Findings: ${summary.findings.length}`,
    '',
  ];
  for (const workflow of summary.workflows) {
    lines.push(`## ${workflow.name}`, '');
    lines.push(`- File: \`${workflow.file}\``);
    lines.push(`- Triggers: ${workflow.triggers.join(', ') || 'none'}`);
    lines.push(`- Jobs: ${workflow.jobs.length}`);
    lines.push(`- Actions: ${workflow.actions.length}`);
    lines.push(`- Concurrency cancellation: ${workflow.cancelInProgress ? 'yes' : 'no'}`);
    lines.push('');
    for (const job of workflow.jobs) {
      lines.push(`### ${job.name}`, '');
      lines.push(`- Runner: ${job.runner ?? 'missing'}`);
      lines.push(`- Timeout: ${job.timeoutMinutes ?? 'missing'} minute(s)`);
      lines.push(`- Steps: ${job.steps.length}`);
      lines.push('');
    }
  }
  if (section.findings.length > 0) {
    lines.push('## Findings', '');
    for (const finding of section.findings) {
      lines.push(`- **${finding.severity.toUpperCase()}** \`${finding.id}\` — ${finding.title}`);
    }
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

export function workflowEvidenceAtLine(
  file: SourceFile,
  line: number,
): string {
  const lineIndex = createLineIndex(file.text);
  const offset = Math.max(0, lineIndex.offsetAt(Math.max(1, line)));
  return snippetAround(file.text, offset, 160);
}
