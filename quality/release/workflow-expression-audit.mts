import { stableSortFindings, type AuditSection, type Finding, type RepositoryInventory, type SourceFile } from './contracts.mts';
import { createLineIndex, snippetAround } from './inventory.mts';

export interface WorkflowExpressionSignal {
  readonly file: string;
  readonly executableExpressions: number;
  readonly attackerControlledExpressions: number;
  readonly dynamicUses: number;
  readonly dynamicShells: number;
  readonly dynamicContainers: number;
  readonly githubScriptExpressions: number;
}
export interface WorkflowExpressionSummary {
  readonly workflows: readonly WorkflowExpressionSignal[];
  readonly workflowFiles: number;
  readonly executableExpressions: number;
  readonly attackerControlledExpressions: number;
  readonly findings: readonly Finding[];
}

const WORKFLOW_PATH = /^\.github\/workflows\/[^/]+\.ya?ml$/i;
const EXPRESSION = /\$\{\{([\s\S]*?)\}\}/g;
const ATTACKER_SOURCE = /\b(?:github\.event\.(?:pull_request\.(?:title|body|head\.ref)|issue\.(?:title|body)|comment\.body|review\.body|review_comment\.body|discussion\.(?:title|body)|head_commit\.message|commits)|github\.head_ref)\b/i;
const EXECUTABLE_KEY = /^\s*(?:-\s+)?(run|shell|uses|image)\s*:\s*(.*)$/i;
const GITHUB_SCRIPT_STEP = /^\s*-\s+uses\s*:\s*actions\/github-script@[0-9a-f]{40}(?:\s*(?:#.*)?)$/i;
const SCRIPT_KEY = /^\s*script\s*:\s*(.*)$/i;
const BLOCK_SCALAR = /^[>|][+-]?\s*(?:#.*)?$/;

type ExecutableKey = 'run' | 'shell' | 'uses' | 'image' | 'script';
interface ExecutableExpression { readonly key: ExecutableKey; readonly expression: string; readonly index: number; readonly attackerControlled: boolean; }

function workflowFiles(inventory: RepositoryInventory): SourceFile[] { return inventory.files.filter(file => WORKFLOW_PATH.test(file.repositoryPath)); }
function indentation(line: string): number { return line.match(/^\s*/)?.[0].length ?? 0; }
function physicalLines(text: string): Array<{ text: string; offset: number }> {
  const lines: Array<{ text: string; offset: number }> = [];
  let offset = 0;
  for (const raw of text.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    lines.push({ text: line, offset });
    offset += raw.length + 1;
  }
  return lines;
}
function expressionsIn(text: string, offset: number, key: ExecutableKey): ExecutableExpression[] {
  const results: ExecutableExpression[] = [];
  const matcher = new RegExp(EXPRESSION.source, EXPRESSION.flags);
  let match: RegExpExecArray | null;
  while ((match = matcher.exec(text)) !== null) {
    const expression = (match[1] ?? '').trim();
    results.push({ key, expression, index: offset + match.index, attackerControlled: ATTACKER_SOURCE.test(expression) });
  }
  return results;
}
function executableExpressions(file: SourceFile): ExecutableExpression[] {
  const lines = physicalLines(file.text);
  const results: ExecutableExpression[] = [];
  let githubScriptStepIndent: number | undefined;
  for (let lineNumber = 0; lineNumber < lines.length; lineNumber += 1) {
    const current = lines[lineNumber]!;
    const line = current.text;
    const trimmed = line.trim();
    const indent = indentation(line);
    if (GITHUB_SCRIPT_STEP.test(line)) githubScriptStepIndent = indent;
    else if (githubScriptStepIndent !== undefined && trimmed && indent <= githubScriptStepIndent && /^\s*-\s+/.test(line)) githubScriptStepIndent = undefined;
    const executable = line.match(EXECUTABLE_KEY);
    if (executable) {
      const key = (executable[1] ?? '').toLowerCase() as Exclude<ExecutableKey, 'script'>;
      const value = executable[2] ?? '';
      results.push(...expressionsIn(value, current.offset + line.indexOf(value), key));
      if (BLOCK_SCALAR.test(value.trim())) {
        let block = '';
        let blockOffset: number | undefined;
        for (let next = lineNumber + 1; next < lines.length; next += 1) {
          const candidate = lines[next]!;
          if (candidate.text.trim() && indentation(candidate.text) <= indent) break;
          if (blockOffset === undefined) blockOffset = candidate.offset;
          block += `${candidate.text}\n`;
        }
        if (blockOffset !== undefined) results.push(...expressionsIn(block, blockOffset, key));
      }
    }
    if (githubScriptStepIndent !== undefined) {
      const script = line.match(SCRIPT_KEY);
      if (script && indent > githubScriptStepIndent) {
        const value = script[1] ?? '';
        results.push(...expressionsIn(value, current.offset + line.indexOf(value), 'script'));
        if (BLOCK_SCALAR.test(value.trim())) {
          let block = '';
          let blockOffset: number | undefined;
          for (let next = lineNumber + 1; next < lines.length; next += 1) {
            const candidate = lines[next]!;
            if (candidate.text.trim() && indentation(candidate.text) <= indent) break;
            if (blockOffset === undefined) blockOffset = candidate.offset;
            block += `${candidate.text}\n`;
          }
          if (blockOffset !== undefined) results.push(...expressionsIn(block, blockOffset, 'script'));
        }
      }
    }
  }
  return results;
}
function findingFor(file: SourceFile, expression: ExecutableExpression): Finding | undefined {
  const lineIndex = createLineIndex(file.text);
  const location = { file: file.repositoryPath, line: lineIndex.lineAt(expression.index) };
  const evidence = { excerpt: snippetAround(file.text, expression.index, 140) };
  if (expression.key === 'uses') return { id: 'ci-workflow-dynamic-action', domain: 'security', severity: 'critical', blocking: true, title: 'Workflow dynamically constructs an action identity', message: 'Expression-derived uses values can redirect execution outside the reviewed immutable action identity.', location, evidence, remediation: 'Use a literal owner/repository@40-character-commit-SHA reference and pass variability only through validated data.', tags: ['ci', 'workflow', 'expression-injection', 'supply-chain'] };
  if (expression.key === 'shell') return { id: 'ci-workflow-dynamic-shell', domain: 'security', severity: 'critical', blocking: true, title: 'Workflow dynamically selects its shell', message: 'Expression-derived shell selection changes the interpreter used for executable content.', location, evidence, remediation: 'Use a literal reviewed shell and consume variable values as quoted environment data.', tags: ['ci', 'workflow', 'expression-injection', 'shell'] };
  if (expression.key === 'image') return { id: 'ci-workflow-dynamic-container', domain: 'security', severity: 'critical', blocking: true, title: 'Workflow dynamically selects a container image', message: 'Expression-derived image identity can replace the executable environment outside source review.', location, evidence, remediation: 'Use a literal immutable container digest.', tags: ['ci', 'workflow', 'container', 'supply-chain'] };
  if (!expression.attackerControlled) return undefined;
  if (expression.key === 'script') return { id: 'ci-workflow-github-script-injection', domain: 'security', severity: 'critical', blocking: true, title: 'Workflow interpolates attacker-controlled data into github-script source', message: 'Attacker-controlled event text is expanded before JavaScript parsing and can become executable source.', location, evidence, remediation: 'Pass untrusted values through env and read them as data from process.env inside pinned github-script source.', tags: ['ci', 'workflow', 'expression-injection', 'github-script'] };
  return { id: 'ci-workflow-shell-injection', domain: 'security', severity: 'critical', blocking: true, title: 'Workflow interpolates attacker-controlled data into a run command', message: 'Attacker-controlled GitHub event text is expanded before shell parsing and can inject shell syntax.', location, evidence, remediation: 'Assign the expression to env and consume the environment variable as quoted data inside a literal run script.', tags: ['ci', 'workflow', 'expression-injection', 'shell'] };
}
function signal(file: SourceFile): WorkflowExpressionSignal {
  const expressions = executableExpressions(file);
  return { file: file.repositoryPath, executableExpressions: expressions.length, attackerControlledExpressions: expressions.filter(item => item.attackerControlled).length, dynamicUses: expressions.filter(item => item.key === 'uses').length, dynamicShells: expressions.filter(item => item.key === 'shell').length, dynamicContainers: expressions.filter(item => item.key === 'image').length, githubScriptExpressions: expressions.filter(item => item.key === 'script').length };
}
export function auditWorkflowExpressions(inventory: RepositoryInventory): AuditSection<WorkflowExpressionSummary> {
  const start = performance.now();
  const files = workflowFiles(inventory);
  const workflows = files.map(signal);
  const findings = stableSortFindings(files.flatMap(file => executableExpressions(file).map(expression => findingFor(file, expression)).filter((finding): finding is Finding => finding !== undefined)));
  return { domain: 'security', title: 'Workflow executable expression boundary audit', summary: { workflows, workflowFiles: workflows.length, executableExpressions: workflows.reduce((sum, item) => sum + item.executableExpressions, 0), attackerControlledExpressions: workflows.reduce((sum, item) => sum + item.attackerControlledExpressions, 0), findings }, findings, elapsedMs: Math.max(0, performance.now() - start) };
}
