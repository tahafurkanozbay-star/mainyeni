import {
  stableSortFindings,
  type AuditSection,
  type Finding,
  type RepositoryInventory,
  type SourceFile,
} from './contracts.mts';
import {
  firstWorkflowField,
  jobHasSecrets,
  jobHasWriteAuthority,
  jobUsesProtectedEnvironment,
  physicalLines,
  workflowFiles,
  workflowJobBlocks,
  workflowTopLevelBlock,
  type WorkflowJobBlock,
  type WorkflowLine,
} from './workflow-structure.mts';
import {
  firstWorkflowStepField,
  stepNestedMapping,
  stepRunText,
  workflowStepBlocks,
  type WorkflowStepBlock,
} from './workflow-step-structure.mts';

export type ManualInputKind = 'string' | 'choice' | 'boolean' | 'environment' | 'number' | 'unknown';

export interface ManualInputDefinition {
  readonly name: string;
  readonly trigger: 'workflow_dispatch' | 'workflow_call';
  readonly kind: ManualInputKind;
  readonly required: boolean;
  readonly optionCount: number;
  readonly hasDefault: boolean;
  readonly line: number;
}

export interface ManualInputUseSignal {
  readonly file: string;
  readonly job: string;
  readonly input: string;
  readonly context: ManualInputUseContext;
  readonly line: number;
  readonly privileged: boolean;
  readonly kind: ManualInputKind;
  readonly declared: boolean;
}

export interface WorkflowManualInputBoundarySummary {
  readonly workflowFiles: number;
  readonly declaredInputs: number;
  readonly stringInputs: number;
  readonly choiceInputs: number;
  readonly privilegedInputUses: number;
  readonly signals: readonly ManualInputUseSignal[];
  readonly findings: readonly Finding[];
}

type ManualInputUseContext = 'run' | 'uses' | 'shell' | 'working-directory' | 'runs-on' | 'environment' | 'ref' | 'repository' | 'path' | 'script' | 'generic-with';

const INPUT_EXPR = /\$\{\{\s*(?:inputs\.([A-Za-z0-9_-]+)|github\.event\.inputs\.([A-Za-z0-9_-]+))(?:[^}]*)\}\}/gi;
const TRIGGER = /^\s*(workflow_dispatch|workflow_call)\s*:\s*(?:#.*)?$/;
const INPUTS = /^\s*inputs\s*:\s*(?:#.*)?$/;
const MAPPING = /^\s*([A-Za-z0-9_-]+)\s*:\s*(.*)$/;
const SENSITIVE_WITH_KEYS = new Set(['ref', 'repository', 'path', 'script', 'command', 'args', 'entrypoint', 'image', 'working-directory']);

function directChildren(lines: readonly WorkflowLine[], parentLine: number, parentIndent: number): WorkflowLine[] {
  const after = lines.filter(line => line.line > parentLine);
  let childIndent: number | undefined;
  const children: WorkflowLine[] = [];
  for (const line of after) {
    if (!line.trimmed || line.trimmed.startsWith('#')) continue;
    if (line.indent <= parentIndent) break;
    if (childIndent === undefined) childIndent = line.indent;
    if (line.indent === childIndent) children.push(line);
  }
  return children;
}

function nestedBlock(lines: readonly WorkflowLine[], start: WorkflowLine): WorkflowLine[] {
  const result: WorkflowLine[] = [];
  for (const line of lines) {
    if (line.line <= start.line) continue;
    if (line.trimmed && line.indent <= start.indent) break;
    result.push(line);
  }
  return result;
}

function scalarValue(lines: readonly WorkflowLine[], key: string): string | undefined {
  for (const line of lines) {
    const match = line.text.match(MAPPING);
    if ((match?.[1] ?? '').toLowerCase() !== key.toLowerCase()) continue;
    return (match?.[2] ?? '').trim().replace(/^['"]|['"]$/g, '');
  }
  return undefined;
}

function definitions(file: SourceFile): ManualInputDefinition[] {
  const on = workflowTopLevelBlock(file, 'on');
  if (!on) return [];
  const lines = physicalLines(file.text);
  const result: ManualInputDefinition[] = [];
  const onLines = lines.filter(line => line.line >= on.line.line && line.line <= (on.lines.at(-1)?.line ?? on.line.line));
  for (const triggerLine of onLines) {
    const triggerMatch = triggerLine.text.match(TRIGGER);
    const trigger = triggerMatch?.[1] as ManualInputDefinition['trigger'] | undefined;
    if (!trigger) continue;
    const triggerBlock = nestedBlock(onLines, triggerLine);
    const inputsLine = triggerBlock.find(line => INPUTS.test(line.text));
    if (!inputsLine) continue;
    const inputBlock = nestedBlock(triggerBlock, inputsLine);
    const inputLines = directChildren(inputBlock, inputsLine.line, inputsLine.indent);
    for (const inputLine of inputLines) {
      const name = inputLine.text.match(MAPPING)?.[1];
      if (!name) continue;
      const block = nestedBlock(inputBlock, inputLine);
      const rawType = (scalarValue(block, 'type') ?? 'string').toLowerCase();
      const kind: ManualInputKind = rawType === 'choice' || rawType === 'boolean' || rawType === 'environment' || rawType === 'number' || rawType === 'string' ? rawType : 'unknown';
      const required = /^true$/i.test(scalarValue(block, 'required') ?? '');
      const hasDefault = scalarValue(block, 'default') !== undefined;
      const optionsLine = block.find(line => /^\s*options\s*:\s*(?:#.*)?$/.test(line.text));
      const optionCount = optionsLine ? nestedBlock(block, optionsLine).filter(line => /^\s*-\s+/.test(line.text)).length : 0;
      result.push({ name, trigger, kind, required, optionCount, hasDefault, line: inputLine.line });
    }
  }
  return result;
}

function refs(text: string): string[] {
  const matcher = new RegExp(INPUT_EXPR.source, INPUT_EXPR.flags);
  const names = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = matcher.exec(text)) !== null) {
    const name = match[1] ?? match[2];
    if (name) names.add(name);
  }
  return [...names];
}

function privileged(block: WorkflowJobBlock): boolean {
  return jobHasWriteAuthority(block) || jobHasSecrets(block) || jobUsesProtectedEnvironment(block);
}

function makeSignals(
  block: WorkflowJobBlock,
  text: string,
  context: ManualInputUseContext,
  line: number,
  defs: ReadonlyMap<string, ManualInputDefinition>,
): ManualInputUseSignal[] {
  return refs(text).map(name => {
    const definition = defs.get(name);
    return {
      file: block.file.repositoryPath,
      job: block.name,
      input: name,
      context,
      line,
      privileged: privileged(block),
      kind: definition?.kind ?? 'unknown',
      declared: definition !== undefined,
    };
  });
}

function stepSignals(block: WorkflowJobBlock, step: WorkflowStepBlock, defs: ReadonlyMap<string, ManualInputDefinition>): ManualInputUseSignal[] {
  const signals: ManualInputUseSignal[] = [];
  const run = stepRunText(step);
  if (run) signals.push(...makeSignals(block, run, 'run', step.startLine, defs));
  for (const key of ['uses', 'shell', 'working-directory'] as const) {
    const field = firstWorkflowStepField(step, key);
    if (field) signals.push(...makeSignals(block, field.value, key, field.line, defs));
  }
  for (const [key, value] of stepNestedMapping(step, 'with').entries()) {
    const normalized = key.toLowerCase();
    if (!SENSITIVE_WITH_KEYS.has(normalized)) continue;
    const context: ManualInputUseContext = normalized === 'ref' || normalized === 'repository' || normalized === 'path' || normalized === 'script'
      ? normalized
      : 'generic-with';
    signals.push(...makeSignals(block, value, context, step.startLine, defs));
  }
  return signals;
}

function jobSignals(block: WorkflowJobBlock, defs: ReadonlyMap<string, ManualInputDefinition>): ManualInputUseSignal[] {
  const signals: ManualInputUseSignal[] = [];
  for (const key of ['runs-on', 'environment'] as const) {
    const field = firstWorkflowField(block, key);
    if (field) signals.push(...makeSignals(block, field.value, key, field.line, defs));
  }
  for (const step of workflowStepBlocks(block)) signals.push(...stepSignals(block, step, defs));
  return signals;
}

function findingFor(signal: ManualInputUseSignal, definition: ManualInputDefinition | undefined): Finding | undefined {
  const shellSource = signal.context === 'run' || signal.context === 'script';
  const identitySelector = ['uses', 'shell', 'working-directory', 'runs-on', 'ref', 'repository', 'path', 'generic-with'].includes(signal.context);
  const safeTypedEnvironment = signal.context === 'environment' && signal.kind === 'environment';
  if (safeTypedEnvironment) return undefined;
  const unbounded = !signal.declared || signal.kind === 'string' || signal.kind === 'unknown' || (signal.kind === 'choice' && (definition?.optionCount ?? 0) === 0);
  if (!shellSource && !identitySelector && !signal.privileged) return undefined;
  if (!unbounded && !signal.privileged && !shellSource) return undefined;
  const critical = signal.privileged && (shellSource || identitySelector) && unbounded;
  const severity: Finding['severity'] = critical ? 'critical' : shellSource || identitySelector ? 'high' : 'medium';
  return {
    id: critical ? 'ci-manual-input-privileged-execution' : shellSource ? 'ci-manual-input-shell-source' : 'ci-manual-input-identity-selector',
    domain: 'security',
    severity,
    ...(critical ? { blocking: true } : {}),
    title: critical ? 'Unbounded manual input controls privileged executable context' : shellSource ? 'Manual workflow input is interpolated into executable source' : 'Manual workflow input controls an execution identity or path',
    message: `Input ${signal.input} (${signal.kind}${signal.declared ? '' : ', undeclared'}) is used in ${signal.context} by job ${signal.job}. Manual/API invocation authorization does not make free-form input safe shell source or a safe runner/action/ref/path selector.`,
    location: { file: signal.file, line: signal.line },
    evidence: { excerpt: `inputs.${signal.input}`, metadata: { input: signal.input, kind: signal.kind, context: signal.context, privileged: signal.privileged } },
    remediation: signal.kind === 'choice'
      ? 'Keep a small reviewed choice list and map the selected identifier to a literal command/ref/path in code; pass it as data rather than executable source.'
      : 'Declare a typed/choice input with a closed allowlist when possible. Validate free-form values and map them to reviewed literals before shell, action, runner, ref, path, or privileged use.',
    tags: ['ci', 'workflow-input', 'workflow-dispatch', 'workflow-call', 'injection', 'trust-boundary'],
  };
}

export function auditWorkflowManualInputBoundaries(inventory: RepositoryInventory): AuditSection<WorkflowManualInputBoundarySummary> {
  const started = performance.now();
  const files = workflowFiles(inventory);
  const signals: ManualInputUseSignal[] = [];
  const allDefinitions: Array<{ file: string; definition: ManualInputDefinition }> = [];
  const definitionLookup = new Map<string, ManualInputDefinition>();

  for (const file of files) {
    const defs = definitions(file);
    const map = new Map(defs.map(definition => [definition.name, definition] as const));
    for (const definition of defs) {
      allDefinitions.push({ file: file.repositoryPath, definition });
      definitionLookup.set(`${file.repositoryPath}\u0000${definition.name}`, definition);
    }
    for (const block of workflowJobBlocks(file)) signals.push(...jobSignals(block, map));
  }

  const findings = stableSortFindings(signals.map(signal => findingFor(signal, definitionLookup.get(`${signal.file}\u0000${signal.input}`))).filter((item): item is Finding => item !== undefined));
  return {
    domain: 'security',
    title: 'Manual and reusable workflow input boundary audit',
    summary: {
      workflowFiles: files.length,
      declaredInputs: allDefinitions.length,
      stringInputs: allDefinitions.filter(item => item.definition.kind === 'string' || item.definition.kind === 'unknown').length,
      choiceInputs: allDefinitions.filter(item => item.definition.kind === 'choice').length,
      privilegedInputUses: signals.filter(item => item.privileged).length,
      signals,
      findings,
    },
    findings,
    elapsedMs: Math.max(0, performance.now() - started),
  };
}
