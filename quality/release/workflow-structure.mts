import type { RepositoryInventory, SourceFile } from './contracts.mts';

export interface WorkflowLine {
  readonly text: string;
  readonly offset: number;
  readonly line: number;
  readonly indent: number;
  readonly trimmed: string;
}

export interface WorkflowJobBlock {
  readonly file: SourceFile;
  readonly name: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly startOffset: number;
  readonly indent: number;
  readonly lines: readonly WorkflowLine[];
  readonly text: string;
}

export interface WorkflowField {
  readonly key: string;
  readonly value: string;
  readonly line: number;
  readonly offset: number;
  readonly indent: number;
  readonly raw: string;
}

export interface WorkflowTopLevelBlock {
  readonly key: string;
  readonly value: string;
  readonly line: WorkflowLine;
  readonly lines: readonly WorkflowLine[];
  readonly text: string;
}

export interface WorkflowTriggerProfile {
  readonly push: boolean;
  readonly pullRequest: boolean;
  readonly pullRequestTarget: boolean;
  readonly workflowDispatch: boolean;
  readonly workflowCall: boolean;
  readonly workflowRun: boolean;
  readonly repositoryDispatch: boolean;
  readonly mergeGroup: boolean;
  readonly issueComment: boolean;
  readonly issues: boolean;
  readonly pullRequestReview: boolean;
  readonly discussion: boolean;
  readonly schedule: boolean;
  readonly externalContribution: boolean;
}

const WORKFLOW_PATH = /^\.github\/workflows\/[^/]+\.ya?ml$/i;
const JOBS_KEY = /^\s*jobs\s*:\s*(?:#.*)?$/i;
const MAPPING_KEY = /^\s*([A-Za-z0-9_.-]+)\s*:\s*(?:#.*)?$/;
const MAPPING_FIELD = /^\s*([A-Za-z0-9_.-]+)\s*:\s*(.*)$/;
const WRITE_PERMISSION = /^\s*(?:contents|actions|checks|deployments|issues|packages|pages|pull-requests|security-events|statuses|id-token)\s*:\s*write\s*(?:#.*)?$/im;
const WRITE_ALL = /^\s*permissions\s*:\s*write-all\s*(?:#.*)?$/im;
const SECRET_REFERENCE = /\$\{\{\s*secrets\./i;
const SECRETS_INHERIT = /^\s*secrets\s*:\s*inherit\s*(?:#.*)?$/im;
const EXPRESSION = /\$\{\{[\s\S]*?\}\}/;
const UNTRUSTED_EXPRESSION = /\$\{\{[\s\S]*?(?:github\.event\.|github\.head_ref\b|github\.event_name\b|inputs\.|fromJSON\s*\(\s*(?:github\.event\.|inputs\.))/i;

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function workflowFiles(inventory: RepositoryInventory): SourceFile[] {
  return inventory.files.filter(file => WORKFLOW_PATH.test(file.repositoryPath));
}

export function indentation(text: string): number {
  return text.match(/^\s*/)?.[0]?.length ?? 0;
}

export function physicalLines(text: string): WorkflowLine[] {
  if (text.length === 0) return [{ text: '', offset: 0, line: 1, indent: 0, trimmed: '' }];
  const result: WorkflowLine[] = [];
  let offset = 0;
  let line = 1;
  while (offset <= text.length) {
    const newline = text.indexOf('\n', offset);
    const end = newline === -1 ? text.length : newline;
    const raw = text.slice(offset, end);
    const value = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    result.push({
      text: value,
      offset,
      line,
      indent: indentation(value),
      trimmed: value.trim(),
    });
    if (newline === -1) break;
    offset = newline + 1;
    line += 1;
    if (offset === text.length) {
      result.push({ text: '', offset, line, indent: 0, trimmed: '' });
      break;
    }
  }
  return result;
}

export function stripYamlComment(value: string): string {
  let single = false;
  let double = false;
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index] ?? '';
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\' && double) {
      escaped = true;
      continue;
    }
    if (char === "'" && !double) {
      single = !single;
      continue;
    }
    if (char === '"' && !single) {
      double = !double;
      continue;
    }
    if (char === '#' && !single && !double && (index === 0 || /\s/.test(value[index - 1] ?? ''))) {
      return value.slice(0, index).trimEnd();
    }
  }
  return value.trimEnd();
}

export function unquoteYamlScalar(value: string): string {
  const clean = stripYamlComment(value).trim();
  if (clean.length >= 2) {
    const first = clean[0];
    const last = clean.at(-1);
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) return clean.slice(1, -1);
  }
  return clean;
}

function directMappingIndent(lines: readonly WorkflowLine[], parentIndent: number): number | undefined {
  let minimum: number | undefined;
  for (const line of lines) {
    if (!line.trimmed || line.trimmed.startsWith('#') || line.indent <= parentIndent) continue;
    if (!MAPPING_FIELD.test(line.text)) continue;
    if (minimum === undefined || line.indent < minimum) minimum = line.indent;
  }
  return minimum;
}

export function workflowTopLevelBlock(file: SourceFile, key: string): WorkflowTopLevelBlock | undefined {
  const lines = physicalLines(file.text);
  const matcher = new RegExp(`^${escapeRegex(key)}\\s*:\\s*(.*)$`, 'i');
  const start = lines.find(line => line.indent === 0 && matcher.test(line.text));
  if (!start) return undefined;
  const value = unquoteYamlScalar(start.text.match(matcher)?.[1] ?? '');
  const nested: WorkflowLine[] = [];
  for (const line of lines) {
    if (line.line <= start.line) continue;
    if (line.trimmed && line.indent <= start.indent) break;
    if (line.trimmed) nested.push(line);
  }
  return {
    key,
    value,
    line: start,
    lines: nested,
    text: [start.text, ...nested.map(line => line.text)].join('\n'),
  };
}

function jobsLine(lines: readonly WorkflowLine[]): WorkflowLine | undefined {
  return lines.find(line => JOBS_KEY.test(line.text));
}

function candidateJobLines(lines: readonly WorkflowLine[], jobs: WorkflowLine): WorkflowLine[] {
  const afterJobs = lines.filter(line => line.line > jobs.line);
  let jobIndent: number | undefined;
  const candidates: WorkflowLine[] = [];
  for (const line of afterJobs) {
    if (!line.trimmed || line.trimmed.startsWith('#')) continue;
    if (line.indent <= jobs.indent) break;
    const match = line.text.match(MAPPING_KEY);
    if (!match) continue;
    if (jobIndent === undefined) jobIndent = line.indent;
    if (line.indent === jobIndent) candidates.push(line);
  }
  return candidates;
}

export function workflowJobBlocks(file: SourceFile): WorkflowJobBlock[] {
  const lines = physicalLines(file.text);
  const jobs = jobsLine(lines);
  if (!jobs) return [];
  const starts = candidateJobLines(lines, jobs);
  const blocks: WorkflowJobBlock[] = [];
  for (let index = 0; index < starts.length; index += 1) {
    const start = starts[index]!;
    const next = starts[index + 1];
    const endLine = next ? next.line - 1 : lines.at(-1)?.line ?? start.line;
    const blockLines = lines.filter(line => line.line >= start.line && line.line <= endLine);
    const name = start.text.match(MAPPING_KEY)?.[1] ?? 'unknown';
    const text = blockLines.map(line => line.text).join('\n');
    blocks.push({
      file,
      name,
      startLine: start.line,
      endLine,
      startOffset: start.offset,
      indent: start.indent,
      lines: blockLines,
      text,
    });
  }
  return blocks;
}

export function workflowFields(block: WorkflowJobBlock, key: string): WorkflowField[] {
  const matcher = new RegExp(`^\\s*${escapeRegex(key)}\\s*:\\s*(.*)$`, 'i');
  const fieldIndent = directMappingIndent(block.lines.filter(line => line.line > block.startLine), block.indent);
  if (fieldIndent === undefined) return [];
  const fields: WorkflowField[] = [];
  for (const line of block.lines) {
    if (line.indent !== fieldIndent) continue;
    const match = line.text.match(matcher);
    if (!match) continue;
    const rawValue = match[1] ?? '';
    const value = unquoteYamlScalar(rawValue);
    const valueIndex = line.text.indexOf(rawValue);
    fields.push({
      key,
      value,
      line: line.line,
      offset: line.offset + Math.max(0, valueIndex),
      indent: line.indent,
      raw: line.text,
    });
  }
  return fields;
}

export function firstWorkflowField(block: WorkflowJobBlock, key: string): WorkflowField | undefined {
  return workflowFields(block, key)[0];
}

export function blockScalarLines(block: WorkflowJobBlock, field: WorkflowField): WorkflowLine[] {
  const nested: WorkflowLine[] = [];
  for (const line of block.lines) {
    if (line.line <= field.line) continue;
    if (line.trimmed && line.indent <= field.indent) break;
    if (line.trimmed) nested.push(line);
  }
  return nested;
}

export function fieldWithContinuation(block: WorkflowJobBlock, key: string): string {
  const field = firstWorkflowField(block, key);
  if (!field) return '';
  const continuation = blockScalarLines(block, field)
    .filter(line => !/^\s*[A-Za-z0-9_.-]+\s*:/.test(line.text) || /^\s*-\s+/.test(line.text))
    .map(line => line.trimmed);
  return [field.value, ...continuation].filter(Boolean).join(' ');
}

export function workflowFieldBlockText(block: WorkflowJobBlock, key: string): string {
  const field = firstWorkflowField(block, key);
  if (!field) return '';
  return [field.raw, ...blockScalarLines(block, field).map(line => line.text)].join('\n');
}

function triggerNames(file: SourceFile): Set<string> {
  const on = workflowTopLevelBlock(file, 'on');
  if (!on) return new Set<string>();
  const names = new Set<string>();
  const scalar = on.value.trim();
  if (scalar) {
    if (scalar.startsWith('[') && scalar.endsWith(']')) {
      for (const item of scalar.slice(1, -1).split(',')) {
        const value = unquoteYamlScalar(item).trim().toLowerCase();
        if (value) names.add(value);
      }
      return names;
    }
    if (scalar.startsWith('{') && scalar.endsWith('}')) {
      for (const item of scalar.slice(1, -1).split(',')) {
        const key = unquoteYamlScalar(item.split(':', 1)[0] ?? '').trim().toLowerCase();
        if (key) names.add(key);
      }
      return names;
    }
    names.add(unquoteYamlScalar(scalar).toLowerCase());
    return names;
  }
  const childIndent = directMappingIndent(on.lines, on.line.indent);
  if (childIndent === undefined) return names;
  for (const line of on.lines) {
    if (line.indent !== childIndent) continue;
    const match = line.text.match(MAPPING_FIELD);
    const key = match?.[1]?.toLowerCase();
    if (key) names.add(key);
  }
  return names;
}

export function workflowTriggerProfile(file: SourceFile): WorkflowTriggerProfile {
  const triggers = triggerNames(file);
  const pullRequest = triggers.has('pull_request');
  const pullRequestTarget = triggers.has('pull_request_target');
  const issueComment = triggers.has('issue_comment');
  const issues = triggers.has('issues');
  const pullRequestReview = triggers.has('pull_request_review');
  const discussion = triggers.has('discussion') || triggers.has('discussion_comment');
  return {
    push: triggers.has('push'),
    pullRequest,
    pullRequestTarget,
    workflowDispatch: triggers.has('workflow_dispatch'),
    workflowCall: triggers.has('workflow_call'),
    workflowRun: triggers.has('workflow_run'),
    repositoryDispatch: triggers.has('repository_dispatch'),
    mergeGroup: triggers.has('merge_group'),
    issueComment,
    issues,
    pullRequestReview,
    discussion,
    schedule: triggers.has('schedule'),
    externalContribution: pullRequest || pullRequestTarget || issueComment || issues || pullRequestReview || discussion,
  };
}

export function hasWritePermission(text: string): boolean {
  return WRITE_ALL.test(text) || WRITE_PERMISSION.test(text);
}

export function hasSecretReference(text: string): boolean {
  return SECRET_REFERENCE.test(text);
}

export function hasExpression(value: string): boolean {
  return EXPRESSION.test(value);
}

export function hasUntrustedExpression(value: string): boolean {
  return UNTRUSTED_EXPRESSION.test(value);
}

export function expressionSources(value: string): string[] {
  const sources = new Set<string>();
  const matcher = /\$\{\{([\s\S]*?)\}\}/g;
  let match: RegExpExecArray | null;
  while ((match = matcher.exec(value)) !== null) {
    const body = match[1] ?? '';
    if (/github\.event\./i.test(body)) sources.add('github.event');
    if (/github\.head_ref\b/i.test(body)) sources.add('github.head_ref');
    if (/inputs\./i.test(body)) sources.add('inputs');
    if (/matrix\./i.test(body)) sources.add('matrix');
    if (/needs\./i.test(body)) sources.add('needs');
    if (/vars\./i.test(body)) sources.add('vars');
    if (/secrets\./i.test(body)) sources.add('secrets');
  }
  return [...sources].sort((left, right) => left.localeCompare(right, 'en'));
}

export function jobUsesProtectedEnvironment(block: WorkflowJobBlock): boolean {
  const environment = firstWorkflowField(block, 'environment');
  if (!environment) return false;
  if (!environment.value) return true;
  return !hasExpression(environment.value);
}

export function jobHasWriteAuthority(block: WorkflowJobBlock): boolean {
  const ownPermissions = firstWorkflowField(block, 'permissions');
  if (ownPermissions) return hasWritePermission(workflowFieldBlockText(block, 'permissions'));
  return hasWritePermission(workflowTopLevelBlock(block.file, 'permissions')?.text ?? '');
}

export function jobHasSecrets(block: WorkflowJobBlock): boolean {
  if (hasSecretReference(block.text) || SECRETS_INHERIT.test(block.text)) return true;
  const workflowEnv = workflowTopLevelBlock(block.file, 'env')?.text ?? '';
  return hasSecretReference(workflowEnv);
}
