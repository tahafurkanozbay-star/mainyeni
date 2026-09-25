import {
  stableSortFindings,
  type AuditSection,
  type Finding,
  type RepositoryInventory,
  type SourceFile,
} from './contracts.mts';
import { createLineIndex, snippetAround } from './inventory.mts';

/**
 * Audits GitHub Actions workflows for expression-injection and shell-boundary
 * hazards that are easy to miss when a workflow otherwise uses pinned actions
 * and least-privilege permissions.
 *
 * GitHub evaluates `${{ ... }}` before handing a `run:` script to the shell.
 * Untrusted event data interpolated directly into a shell program can therefore
 * become executable syntax. The safe pattern is to bind event data through an
 * `env:` value and consume the resulting environment variable as data.
 */

export interface WorkflowExpressionSignal {
  readonly file: string;
  readonly runBlocks: number;
  readonly directExpressionsInRun: number;
  readonly untrustedExpressionsInRun: number;
  readonly dynamicShells: number;
  readonly dynamicWorkingDirectories: number;
  readonly dynamicActionReferences: number;
  readonly dynamicContainerImages: number;
  readonly githubScriptBlocks: number;
  readonly githubScriptUntrustedExpressions: number;
}

export interface WorkflowExpressionSummary {
  readonly workflows: readonly WorkflowExpressionSignal[];
  readonly workflowFiles: number;
  readonly runBlocks: number;
  readonly untrustedExpressionsInRun: number;
  readonly dynamicExecutionBoundaries: number;
  readonly findings: readonly Finding[];
}

interface LineRecord {
  readonly line: number;
  readonly indent: number;
  readonly text: string;
  readonly trimmed: string;
}

interface RunBlock {
  readonly startLine: number;
  readonly endLine: number;
  readonly indent: number;
  readonly text: string;
}

interface ExpressionUse {
  readonly expression: string;
  readonly index: number;
}

const WORKFLOW_PATH = /^\.github\/workflows\/[^/]+\.ya?ml$/i;
const EXPRESSION = /\$\{\{([\s\S]*?)\}\}/g;
const RUN_KEY = /^\s*-?\s*run\s*:\s*(.*)$/i;
const SHELL_KEY = /^\s*shell\s*:\s*(.+)$/i;
const WORKING_DIRECTORY_KEY = /^\s*working-directory\s*:\s*(.+)$/i;
const USES_KEY = /^\s*-?\s*uses\s*:\s*(.+)$/i;
const CONTAINER_IMAGE_KEY = /^\s*image\s*:\s*(.+)$/i;
const GITHUB_SCRIPT = /actions\/github-script@/i;

const UNTRUSTED_EVENT_PATTERNS: readonly RegExp[] = [
  /\bgithub\.event\.pull_request\.title\b/i,
  /\bgithub\.event\.pull_request\.body\b/i,
  /\bgithub\.event\.pull_request\.head\.ref\b/i,
  /\bgithub\.event\.pull_request\.head\.label\b/i,
  /\bgithub\.event\.issue\.title\b/i,
  /\bgithub\.event\.issue\.body\b/i,
  /\bgithub\.event\.comment\.body\b/i,
  /\bgithub\.event\.review\.body\b/i,
  /\bgithub\.event\.review_comment\.body\b/i,
  /\bgithub\.event\.discussion\.title\b/i,
  /\bgithub\.event\.discussion\.body\b/i,
  /\bgithub\.event\.head_commit\.message\b/i,
  /\bgithub\.event\.commits\b/i,
  /\bgithub\.head_ref\b/i,
  /\bgithub\.event\.workflow_run\.head_branch\b/i,
  /\binputs\.[A-Za-z0-9_-]+\b/i,
  /\bgithub\.event\.inputs\.[A-Za-z0-9_-]+\b/i,
];

const PRIVILEGED_CONTEXT_PATTERNS: readonly RegExp[] = [
  /\bsecrets\.[A-Za-z0-9_-]+\b/i,
  /\bgithub\.token\b/i,
];

function workflowFiles(inventory: RepositoryInventory): SourceFile[] {
  return inventory.files.filter(file => WORKFLOW_PATH.test(file.repositoryPath));
}

function indentation(text: string): number {
  let count = 0;
  for (const character of text) {
    if (character === ' ') count += 1;
    else if (character === '\t') count += 2;
    else break;
  }
  return count;
}

function lines(text: string): LineRecord[] {
  return text.split(/\r?\n/).map((value, index) => ({
    line: index + 1,
    indent: indentation(value),
    text: value,
    trimmed: value.trim(),
  }));
}

function expressions(text: string): ExpressionUse[] {
  const result: ExpressionUse[] = [];
  const matcher = new RegExp(EXPRESSION.source, EXPRESSION.flags);
  let match: RegExpExecArray | null;
  while ((match = matcher.exec(text)) !== null) {
    result.push({ expression: (match[1] ?? '').trim(), index: match.index });
  }
  return result;
}

function isUntrustedExpression(expression: string): boolean {
  return UNTRUSTED_EVENT_PATTERNS.some(pattern => pattern.test(expression));
}

function isPrivilegedExpression(expression: string): boolean {
  return PRIVILEGED_CONTEXT_PATTERNS.some(pattern => pattern.test(expression));
}

function runBlocks(file: SourceFile): RunBlock[] {
  const records = lines(file.text);
  const result: RunBlock[] = [];

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record) continue;
    const match = RUN_KEY.exec(record.text);
    RUN_KEY.lastIndex = 0;
    if (!match) continue;

    const value = (match[1] ?? '').trim();
    if (value !== '|' && value !== '>' && value !== '|-' && value !== '>-') {
      result.push({
        startLine: record.line,
        endLine: record.line,
        indent: record.indent,
        text: value,
      });
      continue;
    }

    const body: string[] = [];
    let endLine = record.line;
    for (let cursor = index + 1; cursor < records.length; cursor += 1) {
      const next = records[cursor];
      if (!next) continue;
      if (next.trimmed.length > 0 && next.indent <= record.indent) break;
      body.push(next.text);
      endLine = next.line;
      index = cursor;
    }
    result.push({
      startLine: record.line,
      endLine,
      indent: record.indent,
      text: body.join('\n'),
    });
  }
  return result;
}

function finding(
  id: string,
  severity: Finding['severity'],
  title: string,
  message: string,
  file: SourceFile,
  line: number,
  excerpt: string,
  remediation: string,
  tags: readonly string[],
  blocking = false,
): Finding {
  return {
    id,
    domain: 'security',
    severity,
    ...(blocking ? { blocking: true } : {}),
    title,
    message,
    location: { file: file.repositoryPath, line },
    evidence: { excerpt },
    remediation,
    tags,
  };
}

function directRunExpressionFindings(file: SourceFile): Finding[] {
  const findings: Finding[] = [];
  for (const block of runBlocks(file)) {
    for (const use of expressions(block.text)) {
      if (!isUntrustedExpression(use.expression)) continue;
      findings.push(finding(
        'ci-run-untrusted-expression',
        'high',
        'Untrusted GitHub expression is interpolated directly into a shell script',
        `The run block directly interpolates ${{ '${{ ' }}${use.expression}${{ ' }}' }}. GitHub expression substitution occurs before shell parsing, so attacker-controlled event text can become shell syntax.`,
        file,
        block.startLine,
        block.text.slice(Math.max(0, use.index - 100), use.index + 220).trim(),
        'Bind untrusted event data to a step-level env variable, then reference the quoted environment variable from the script. Keep executable shell text static.',
        ['ci', 'expression-injection', 'shell', 'github-actions'],
        true,
      ));
    }
  }
  return findings;
}

function dynamicScalarFindings(file: SourceFile): Finding[] {
  const findings: Finding[] = [];
  const records = lines(file.text);
  for (const record of records) {
    const candidates: readonly [RegExp, string, string, Finding['severity'], boolean][] = [
      [SHELL_KEY, 'ci-dynamic-shell', 'Workflow shell is selected dynamically', 'high', true],
      [WORKING_DIRECTORY_KEY, 'ci-dynamic-working-directory', 'Workflow working directory is selected dynamically', 'medium', false],
      [USES_KEY, 'ci-dynamic-action-reference', 'Action reference is selected dynamically', 'critical', true],
      [CONTAINER_IMAGE_KEY, 'ci-dynamic-container-image', 'Container image is selected dynamically', 'high', true],
    ];
    for (const [pattern, id, title, severity, blocking] of candidates) {
      const match = pattern.exec(record.text);
      pattern.lastIndex = 0;
      if (!match) continue;
      const value = match[1] ?? '';
      const uses = expressions(value);
      if (uses.length === 0) continue;
      const untrusted = uses.some(use => isUntrustedExpression(use.expression));
      if (!untrusted) continue;
      findings.push(finding(
        id,
        severity,
        title,
        `Execution-boundary value contains attacker-influenced expression data: ${uses.map(use => use.expression).join(', ')}.`,
        file,
        record.line,
        record.trimmed,
        id === 'ci-dynamic-working-directory'
          ? 'Map allowed input values to fixed repository directories in trusted script logic; reject traversal and absolute paths.'
          : 'Keep execution targets static and repository-reviewed. Map user intent to a fixed allowlist rather than interpolating event data into executable metadata.',
        ['ci', 'expression-injection', 'execution-boundary', 'github-actions'],
        blocking,
      ));
    }
  }
  return findings;
}

function privilegedRunFindings(file: SourceFile): Finding[] {
  const findings: Finding[] = [];
  for (const block of runBlocks(file)) {
    const uses = expressions(block.text);
    const hasSecret = uses.some(use => isPrivilegedExpression(use.expression));
    const hasUntrusted = uses.some(use => isUntrustedExpression(use.expression));
    if (!hasSecret || !hasUntrusted) continue;
    findings.push(finding(
      'ci-run-mixes-secret-and-untrusted-expression',
      'critical',
      'Shell block mixes privileged and attacker-controlled expression contexts',
      'A single run block contains both secret/token material and attacker-influenced event expressions. Expression injection in this boundary can expose privileged values.',
      file,
      block.startLine,
      block.text.slice(0, 320).trim(),
      'Separate privileged operations from untrusted input processing. Do not expose secrets to a step whose executable shell text depends on pull-request, issue, comment, review, discussion or workflow input data.',
      ['ci', 'secrets', 'expression-injection', 'shell'],
      true,
    ));
  }
  return findings;
}

function githubScriptFindings(file: SourceFile): Finding[] {
  const findings: Finding[] = [];
  const records = lines(file.text);
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record || !GITHUB_SCRIPT.test(record.text)) continue;
    const stepIndent = record.indent;
    const body: string[] = [];
    let startLine = record.line;
    for (let cursor = index + 1; cursor < records.length; cursor += 1) {
      const next = records[cursor];
      if (!next) continue;
      if (next.trimmed.length > 0 && next.indent < stepIndent) break;
      body.push(next.text);
      if (/^\s*script\s*:/.test(next.text)) startLine = next.line;
    }
    const script = body.join('\n');
    for (const use of expressions(script)) {
      if (!isUntrustedExpression(use.expression)) continue;
      findings.push(finding(
        'ci-github-script-untrusted-expression',
        'high',
        'github-script source contains direct untrusted expression interpolation',
        `actions/github-script source directly embeds ${use.expression}. Expression substitution can alter JavaScript source before execution.`,
        file,
        startLine,
        script.slice(Math.max(0, use.index - 100), use.index + 220).trim(),
        'Pass untrusted values through env and read process.env from the static github-script program. Validate type, length and expected format before use.',
        ['ci', 'github-script', 'expression-injection', 'javascript'],
        true,
      ));
    }
  }
  return findings;
}

function signal(file: SourceFile): WorkflowExpressionSignal {
  const blocks = runBlocks(file);
  const direct = blocks.flatMap(block => expressions(block.text));
  const records = lines(file.text);
  const scalarCount = (pattern: RegExp): number => records.filter(record => {
    const match = pattern.exec(record.text);
    pattern.lastIndex = 0;
    return Boolean(match && expressions(match[1] ?? '').some(use => isUntrustedExpression(use.expression)));
  }).length;

  let githubScriptBlocks = 0;
  let githubScriptUntrustedExpressions = 0;
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record || !GITHUB_SCRIPT.test(record.text)) continue;
    githubScriptBlocks += 1;
    const body = records.slice(index + 1).find(next => next.trimmed.length > 0 && next.indent < record.indent)
      ? records.slice(index + 1).filter(next => next.indent >= record.indent).map(next => next.text).join('\n')
      : records.slice(index + 1).map(next => next.text).join('\n');
    githubScriptUntrustedExpressions += expressions(body).filter(use => isUntrustedExpression(use.expression)).length;
  }

  return {
    file: file.repositoryPath,
    runBlocks: blocks.length,
    directExpressionsInRun: direct.length,
    untrustedExpressionsInRun: direct.filter(use => isUntrustedExpression(use.expression)).length,
    dynamicShells: scalarCount(SHELL_KEY),
    dynamicWorkingDirectories: scalarCount(WORKING_DIRECTORY_KEY),
    dynamicActionReferences: scalarCount(USES_KEY),
    dynamicContainerImages: scalarCount(CONTAINER_IMAGE_KEY),
    githubScriptBlocks,
    githubScriptUntrustedExpressions,
  };
}

export function auditWorkflowExpressions(inventory: RepositoryInventory): AuditSection<WorkflowExpressionSummary> {
  const start = performance.now();
  const files = workflowFiles(inventory);
  const workflows = files.map(signal);
  const findings = stableSortFindings(files.flatMap(file => [
    ...directRunExpressionFindings(file),
    ...dynamicScalarFindings(file),
    ...privilegedRunFindings(file),
    ...githubScriptFindings(file),
  ]));

  return {
    domain: 'security',
    title: 'GitHub Actions expression and execution-boundary audit',
    summary: {
      workflows,
      workflowFiles: workflows.length,
      runBlocks: workflows.reduce((sum, item) => sum + item.runBlocks, 0),
      untrustedExpressionsInRun: workflows.reduce((sum, item) => sum + item.untrustedExpressionsInRun, 0),
      dynamicExecutionBoundaries: workflows.reduce((sum, item) => sum
        + item.dynamicShells
        + item.dynamicWorkingDirectories
        + item.dynamicActionReferences
        + item.dynamicContainerImages, 0),
      findings,
    },
    findings,
    elapsedMs: Math.max(0, performance.now() - start),
  };
}
