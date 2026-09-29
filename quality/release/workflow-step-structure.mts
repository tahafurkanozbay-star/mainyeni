import type { WorkflowJobBlock, WorkflowLine } from './workflow-structure.mts';
import { indentation, stripYamlComment, unquoteYamlScalar } from './workflow-structure.mts';

export interface WorkflowStepBlock {
  readonly job: WorkflowJobBlock;
  readonly index: number;
  readonly startLine: number;
  readonly endLine: number;
  readonly indent: number;
  readonly lines: readonly WorkflowLine[];
  readonly text: string;
}

export interface WorkflowStepField {
  readonly key: string;
  readonly value: string;
  readonly line: number;
  readonly indent: number;
  readonly raw: string;
}

export interface WorkflowUsesIdentity {
  readonly raw: string;
  readonly owner?: string;
  readonly repository?: string;
  readonly ref?: string;
  readonly local: boolean;
  readonly docker: boolean;
  readonly remote: boolean;
  readonly immutable: boolean;
}

const STEPS_KEY = /^\s*steps\s*:\s*(?:#.*)?$/i;
const STEP_START = /^\s*-\s+(?:name\s*:|id\s*:|uses\s*:|run\s*:|shell\s*:|working-directory\s*:|if\s*:|env\s*:|with\s*:|continue-on-error\s*:|timeout-minutes\s*:)/i;
const FIELD = /^\s*([A-Za-z0-9_.-]+)\s*:\s*(.*)$/;
const SHA40 = /^[0-9a-f]{40}$/i;

function stepsLine(job: WorkflowJobBlock): WorkflowLine | undefined {
  return job.lines.find(line => {
    if (!STEPS_KEY.test(line.text)) return false;
    return line.indent > job.indent;
  });
}

function candidateStepLines(job: WorkflowJobBlock, steps: WorkflowLine): WorkflowLine[] {
  const candidates: WorkflowLine[] = [];
  let stepIndent: number | undefined;
  for (const line of job.lines) {
    if (line.line <= steps.line) continue;
    if (!line.trimmed || line.trimmed.startsWith('#')) continue;
    if (line.indent <= steps.indent) break;
    if (!STEP_START.test(line.text)) continue;
    if (stepIndent === undefined) stepIndent = line.indent;
    if (line.indent === stepIndent) candidates.push(line);
  }
  return candidates;
}

export function workflowStepBlocks(job: WorkflowJobBlock): WorkflowStepBlock[] {
  const steps = stepsLine(job);
  if (!steps) return [];
  const starts = candidateStepLines(job, steps);
  return starts.map((start, index) => {
    const next = starts[index + 1];
    const endLine = next ? next.line - 1 : job.endLine;
    const lines = job.lines.filter(line => line.line >= start.line && line.line <= endLine);
    return {
      job,
      index,
      startLine: start.line,
      endLine,
      indent: start.indent,
      lines,
      text: lines.map(line => line.text).join('\n'),
    };
  });
}

function normalizeStepStart(line: WorkflowLine): string {
  const prefix = line.text.slice(0, line.indent);
  const rest = line.text.slice(line.indent);
  if (!rest.startsWith('-')) return line.text;
  return `${prefix}  ${rest.slice(1).trimStart()}`;
}

export function workflowStepFields(step: WorkflowStepBlock, key?: string): WorkflowStepField[] {
  const fields: WorkflowStepField[] = [];
  for (const line of step.lines) {
    const candidate = line.line === step.startLine
      ? { ...line, text: normalizeStepStart(line), indent: line.indent + 2 }
      : line;
    const match = candidate.text.match(FIELD);
    if (!match) continue;
    const fieldKey = match[1] ?? '';
    if (key && fieldKey.toLowerCase() !== key.toLowerCase()) continue;
    const directIndent = step.indent + 2;
    if (candidate.indent !== directIndent) continue;
    fields.push({
      key: fieldKey,
      value: unquoteYamlScalar(match[2] ?? ''),
      line: line.line,
      indent: candidate.indent,
      raw: line.text,
    });
  }
  return fields;
}

export function firstWorkflowStepField(step: WorkflowStepBlock, key: string): WorkflowStepField | undefined {
  return workflowStepFields(step, key)[0];
}

export function stepNestedBlockLines(step: WorkflowStepBlock, key: string): WorkflowLine[] {
  const field = firstWorkflowStepField(step, key);
  if (!field) return [];
  const result: WorkflowLine[] = [];
  for (const line of step.lines) {
    if (line.line <= field.line) continue;
    if (line.trimmed && line.indent <= field.indent) break;
    result.push(line);
  }
  return result;
}

export function stepNestedMapping(step: WorkflowStepBlock, key: string): ReadonlyMap<string, string> {
  const result = new Map<string, string>();
  for (const line of stepNestedBlockLines(step, key)) {
    if (!line.trimmed || line.trimmed.startsWith('#')) continue;
    const match = line.text.match(FIELD);
    if (!match) continue;
    result.set(match[1] ?? '', unquoteYamlScalar(match[2] ?? ''));
  }
  return result;
}

export function stepRunText(step: WorkflowStepBlock): string {
  const run = firstWorkflowStepField(step, 'run');
  if (!run) return '';
  if (!/^[>|][+-]?$/.test(stripYamlComment(run.value).trim())) return run.value;
  return stepNestedBlockLines(step, 'run').map(line => line.text.trimStart()).join('\n');
}

export function stepDisplayName(step: WorkflowStepBlock): string {
  return firstWorkflowStepField(step, 'name')?.value
    || firstWorkflowStepField(step, 'id')?.value
    || firstWorkflowStepField(step, 'uses')?.value
    || `step-${step.index + 1}`;
}

export function parseUsesIdentity(value: string): WorkflowUsesIdentity {
  const raw = unquoteYamlScalar(value).trim();
  if (raw.startsWith('./') || raw.startsWith('../')) {
    return { raw, local: true, docker: false, remote: false, immutable: true };
  }
  if (/^docker:\/\//i.test(raw)) {
    const digest = /@sha256:[0-9a-f]{64}$/i.test(raw);
    return { raw, local: false, docker: true, remote: false, immutable: digest };
  }
  const at = raw.lastIndexOf('@');
  const repositoryPart = at > 0 ? raw.slice(0, at) : raw;
  const ref = at > 0 ? raw.slice(at + 1) : undefined;
  const pieces = repositoryPart.split('/');
  const owner = pieces[0];
  const repository = pieces[1];
  const remote = Boolean(owner && repository && !raw.startsWith('${{'));
  return {
    raw,
    ...(owner ? { owner } : {}),
    ...(repository ? { repository } : {}),
    ...(ref ? { ref } : {}),
    local: false,
    docker: false,
    remote,
    immutable: Boolean(ref && SHA40.test(ref)),
  };
}

export function stepUsesIdentity(step: WorkflowStepBlock): WorkflowUsesIdentity | undefined {
  const uses = firstWorkflowStepField(step, 'uses');
  return uses ? parseUsesIdentity(uses.value) : undefined;
}

export function stepHasExpression(step: WorkflowStepBlock, pattern: RegExp): boolean {
  const matcher = new RegExp(pattern.source, pattern.flags.replace('g', ''));
  return matcher.test(step.text);
}

export function stepIndentation(text: string): number {
  return indentation(text);
}
