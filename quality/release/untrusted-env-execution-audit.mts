import {
  stableSortFindings,
  type AuditSection,
  type Finding,
  type RepositoryInventory,
} from './contracts.mts';
import { workflowFiles, workflowJobBlocks, type WorkflowJobBlock } from './workflow-structure.mts';
import {
  stepDisplayName,
  stepNestedMapping,
  stepRunText,
  workflowStepBlocks,
  type WorkflowStepBlock,
} from './workflow-step-structure.mts';

export type UntrustedEnvSource = 'event' | 'input' | 'output' | 'matrix';

export interface UntrustedEnvSignal {
  readonly file: string;
  readonly job: string;
  readonly step: string;
  readonly variable: string;
  readonly sources: readonly UntrustedEnvSource[];
  readonly commandExecution: boolean;
  readonly evaluatorUse: boolean;
  readonly interpreterCommandUse: boolean;
  readonly dangerousSelectorUse: boolean;
  readonly line: number;
}

export interface UntrustedEnvExecutionSummary {
  readonly workflowFiles: number;
  readonly taintedVariables: number;
  readonly reexecutedVariables: number;
  readonly evaluatorUses: number;
  readonly commandPositionUses: number;
  readonly dangerousSelectorUses: number;
  readonly signals: readonly UntrustedEnvSignal[];
  readonly findings: readonly Finding[];
}

const SOURCE_PATTERNS: ReadonlyArray<readonly [UntrustedEnvSource, RegExp]> = [
  ['event', /\$\{\{[\s\S]*?(?:github\.event\.|github\.head_ref\b)[\s\S]*?\}\}/i],
  ['input', /\$\{\{[\s\S]*?(?:inputs\.|github\.event\.inputs\.)[\s\S]*?\}\}/i],
  ['output', /\$\{\{[\s\S]*?(?:needs\.[A-Za-z0-9_-]+\.outputs\.|steps\.[A-Za-z0-9_-]+\.outputs\.)[\s\S]*?\}\}/i],
  ['matrix', /\$\{\{[\s\S]*?matrix\.[\s\S]*?\}\}/i],
];

function variableForms(name: string): { readonly any: RegExp; readonly quoted: RegExp; readonly commandPosition: RegExp } {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return {
    any: new RegExp(`(?:\\$\\{${escaped}\\}|\\$${escaped}\\b|\\$env:${escaped}\\b|%${escaped}%)`, 'i'),
    quoted: new RegExp(`(?:"[^"\\n]*(?:\\$\\{${escaped}\\}|\\$${escaped}\\b|\\$env:${escaped}\\b)[^"\\n]*"|'[^'\\n]*%${escaped}%[^'\\n]*')`, 'i'),
    commandPosition: new RegExp(`(?:^|[;&|]\\s*)(?:\\$\\{${escaped}\\}|\\$${escaped}\\b|&\\s*\\$env:${escaped}\\b|%${escaped}%)(?:\\s|$)`, 'im'),
  };
}

function sources(value: string): UntrustedEnvSource[] {
  return SOURCE_PATTERNS.filter(([, pattern]) => pattern.test(value)).map(([source]) => source);
}

function evaluatorPattern(name: string): RegExp {
  const forms = variableForms(name);
  return new RegExp(`\\b(?:eval|Invoke-Expression|iex)\\b[^\\n]*${forms.any.source}`, 'i');
}

function interpreterPattern(name: string): RegExp {
  const forms = variableForms(name);
  return new RegExp(`\\b(?:bash|sh|zsh|pwsh|powershell|python(?:3)?|node)\\s+(?:-c|-Command|-e)\\s+[^\\n]*${forms.any.source}`, 'i');
}

function selectorPattern(name: string): RegExp {
  const forms = variableForms(name);
  return new RegExp(`\\b(?:git\\s+(?:checkout|switch|reset|fetch|clone)|curl|wget|rm\\s+-rf|chmod|tar\\s+[^\\n]*(?:-C|--directory)|docker\\s+(?:run|pull|push)|kubectl\\s+(?:apply|delete)|gh\\s+(?:api|pr|issue|release))\\b[^\\n]*${forms.any.source}`, 'i');
}

function signalFor(block: WorkflowJobBlock, step: WorkflowStepBlock): UntrustedEnvSignal[] {
  const run = stepRunText(step);
  if (!run) return [];
  const signals: UntrustedEnvSignal[] = [];
  for (const [name, value] of stepNestedMapping(step, 'env').entries()) {
    const taint = sources(value);
    if (taint.length === 0) continue;
    const forms = variableForms(name);
    if (!forms.any.test(run)) continue;
    const commandExecution = forms.commandPosition.test(run);
    const evaluatorUse = evaluatorPattern(name).test(run);
    const interpreterCommandUse = interpreterPattern(name).test(run);
    const dangerousSelectorUse = selectorPattern(name).test(run);
    if (!commandExecution && !evaluatorUse && !interpreterCommandUse && !dangerousSelectorUse) continue;
    signals.push({
      file: block.file.repositoryPath,
      job: block.name,
      step: stepDisplayName(step),
      variable: name,
      sources: taint,
      commandExecution,
      evaluatorUse,
      interpreterCommandUse,
      dangerousSelectorUse,
      line: step.startLine,
    });
  }
  return signals;
}

function findingFor(signal: UntrustedEnvSignal): Finding {
  const critical = signal.commandExecution || signal.evaluatorUse || signal.interpreterCommandUse;
  const id = signal.evaluatorUse
    ? 'ci-untrusted-env-evaluator'
    : signal.interpreterCommandUse
      ? 'ci-untrusted-env-interpreter-command'
      : signal.commandExecution
        ? 'ci-untrusted-env-command-position'
        : 'ci-untrusted-env-dangerous-selector';
  return {
    id,
    domain: 'security',
    severity: critical ? 'critical' : 'high',
    ...(critical ? { blocking: true } : {}),
    title: critical ? 'Untrusted environment data is converted back into executable source' : 'Untrusted environment data controls a sensitive command selector',
    message: `Step ${signal.step} correctly receives external data through env variable ${signal.variable}, but later uses that variable in ${signal.evaluatorUse ? 'eval/Invoke-Expression' : signal.interpreterCommandUse ? 'interpreter command source' : signal.commandExecution ? 'command position' : 'a sensitive git/network/filesystem/deployment selector'}. Moving data to env is safe only while it remains data.`,
    location: { file: signal.file, line: signal.line },
    evidence: { excerpt: signal.variable, metadata: { variable: signal.variable, sources: signal.sources } },
    remediation: signal.dangerousSelectorUse && !critical
      ? 'Validate the variable against a closed allowlist and map it to a reviewed literal selector. Quote it as data and never allow arbitrary refs, URLs, paths, repositories, or deployment targets.'
      : 'Do not eval, source, -c/-Command/-e, or execute untrusted environment data. Keep a literal reviewed command and pass the variable only as a quoted argument/data value.',
    tags: ['ci', 'env', 'injection', 'shell', 'dataflow'],
  };
}

export function auditUntrustedEnvExecution(inventory: RepositoryInventory): AuditSection<UntrustedEnvExecutionSummary> {
  const started = performance.now();
  const files = workflowFiles(inventory);
  const jobs = files.flatMap(file => workflowJobBlocks(file));
  const steps = jobs.flatMap(job => workflowStepBlocks(job).map(step => ({ job, step })));
  let taintedVariables = 0;
  for (const { step } of steps) {
    taintedVariables += [...stepNestedMapping(step, 'env').values()].filter(value => sources(value).length > 0).length;
  }
  const signals = steps.flatMap(({ job, step }) => signalFor(job, step));
  const findings = stableSortFindings(signals.map(findingFor));
  return {
    domain: 'security',
    title: 'Untrusted environment re-execution boundary audit',
    summary: {
      workflowFiles: files.length,
      taintedVariables,
      reexecutedVariables: signals.length,
      evaluatorUses: signals.filter(item => item.evaluatorUse || item.interpreterCommandUse).length,
      commandPositionUses: signals.filter(item => item.commandExecution).length,
      dangerousSelectorUses: signals.filter(item => item.dangerousSelectorUse).length,
      signals,
      findings,
    },
    findings,
    elapsedMs: Math.max(0, performance.now() - started),
  };
}
