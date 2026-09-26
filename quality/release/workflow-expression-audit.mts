import {
  stableSortFindings,
  type AuditSection,
  type Finding,
  type RepositoryInventory,
  type SourceFile,
} from './contracts.mts';
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
const ATTACKER_SOURCE = /\b(?:github\.event\.(?:pull_request\.(?:title|body|head\.ref)|issue\.(?:title|body)|comment\.body|review\.body|review_comment\.body|discussion\.(?:title|body)|head_commit\.message|commits)|github\.head_ref|inputs\.[A-Za-z0-9_-]+)\b/i;
const TRUSTED_IDENTITY = /\b(?:github\.(?:sha|ref|ref_name|base_ref|repository|repository_owner|workflow|workflow_ref|job|run_id|run_number|run_attempt|actor_id)|github\.event\.pull_request\.(?:base\.sha|head\.sha))\b/i;
const EXECUTABLE_KEY = /^\s*(?:-\s+)?(run|shell|uses|image)\s*:\s*(.*)$/i;
const GITHUB_SCRIPT_STEP = /^\s*-\s+uses\s*:\s*actions\/github-script@[0-9a-f]{40}(?:\s*(?:#.*)?)$/i;
const SCRIPT_KEY = /^\s*script\s*:\s*(.*)$/i;
const BLOCK_SCALAR = /^[>|][+-]?\s*(?:#.*)?$/;
interface ExecutableExpression { readonly key: 'run' | 'shell' | 'uses' | 'image' | 'script'; readonly expression: string; readonly index: number; readonly attackerControlled: boolean; }
function workflowFiles(inventory: RepositoryInventory): SourceFile[] { return inventory.files.filter(file => WORKFLOW_PATH.test(file.repositoryPath)); }
function indentation(line: string): number { return line.match(/^\s*/)?.[0].length ?? 0; }
function expressionsIn(text: string, offset: number, key: ExecutableExpression['key']): ExecutableExpression[] {
  const results: ExecutableExpression[] = []; const matcher = new RegExp(EXPRESSION.source, EXPRESSION.flags); let match: RegExpExecArray | null;
  while ((match = matcher.exec(text)) !== null) { const expression = (match[1] ?? '').trim(); results.push({ key, expression, index: offset + match.index, attackerControlled: ATTACKER_SOURCE.test(expression) }); }
  return results;
}
function executableExpressions(file: SourceFile): ExecutableExpression[] {
  const lines = file.text.split(/(?<=\n)/); const results: ExecutableExpression[] = []; let offset = 0; let githubScriptStepIndent: number | undefined;
  for (let lineNumber = 0; lineNumber < lines.length; lineNumber += 1) {
    const line = lines[lineNumber] ?? ''; const trimmed = line.trim(); const indent = indentation(line);
    if (GITHUB_SCRIPT_STEP.test(line)) githubScriptStepIndent = indent; else if (githubScriptStepIndent !== undefined && trimmed && indent <= githubScriptStepIndent && /^\s*-\s+/.test(line)) githubScriptStepIndent = undefined;
    const executable = line.match(EXECUTABLE_KEY);
    if (executable) { const key = (executable[1] ?? '').toLowerCase() as 'run' | 'shell' | 'uses' | 'image'; const value = executable[2] ?? ''; results.push(...expressionsIn(value, offset + line.indexOf(value), key)); if (BLOCK_SCALAR.test(value.trim())) { let block = ''; const blockOffset = offset + line.length; for (let next = lineNumber + 1; next < lines.length; next += 1) { const candidate = lines[next] ?? ''; if (candidate.trim() && indentation(candidate) <= indent) break; block += candidate; } results.push(...expressionsIn(block, blockOffset, key)); } }
    if (githubScriptStepIndent !== undefined) { const script = line.match(SCRIPT_KEY); if (script && indent > githubScriptStepIndent) { const value = script[1] ?? ''; results.push(...expressionsIn(value, offset + line.indexOf(value), 'script')); if (BLOCK_SCALAR.test(value.trim())) { let block = ''; const blockOffset = offset + line.length; for (let next = lineNumber + 1; next < lines.length; next += 1) { const candidate = lines[next] ?? ''; if (candidate.trim() && indentation(candidate) <= indent) break; block += candidate; } results.push(...expressionsIn(block, blockOffset, 'script')); } } }
    offset += line.length;
  }
  return results;
}
function findingFor(file: SourceFile, expression: ExecutableExpression): Finding | undefined {
  const index = createLineIndex(file.text); const location = { file: file.repositoryPath, line: index.lineAt(expression.index) }; const evidence = { excerpt: snippetAround(file.text, expression.index, 140) };
  if (expression.key === 'uses') return { id: 'ci-expression-dynamic-action', domain: 'security', severity: 'critical', blocking: true, title: 'Workflow action identity is dynamically constructed', message: 'Executable action identity must be reviewable and immutable; expression-derived uses values can redirect CI execution without a pinned action identity.', location, evidence, remediation: 'Use a literal owner/repository@40-character-commit-SHA action reference. Move data variability into validated with/env inputs.', tags: ['ci', 'expression-injection', 'supply-chain'] };
  if (expression.key === 'shell') return { id: 'ci-expression-dynamic-shell', domain: 'security', severity: 'critical', blocking: true, title: 'Workflow shell is dynamically selected', message: 'Expression-derived shell selection changes the command interpreter at an executable trust boundary.', location, evidence, remediation: 'Select a literal reviewed shell. Pass variable data through env and quote it inside the fixed interpreter.', tags: ['ci', 'expression-injection', 'shell'] };
  if (expression.key === 'image') return { id: 'ci-expression-dynamic-container', domain: 'security', severity: 'critical', blocking: true, title: 'Workflow container image is dynamically selected', message: 'Expression-derived container identity can change the executable environment outside normal code review.', location, evidence, remediation: 'Use a literal immutable container digest and vary only non-executable arguments through validated inputs.', tags: ['ci', 'expression-injection', 'container', 'supply-chain'] };
  if (!expression.attackerControlled) return undefined;
  const trustedOnly = TRUSTED_IDENTITY.test(expression.expression) && !ATTACKER_SOURCE.test(expression.expression); if (trustedOnly) return undefined;
  if (expression.key === 'script') return { id: 'ci-expression-github-script-injection', domain: 'security', severity: 'critical', blocking: true, title: 'Attacker-controlled expression is interpolated into github-script source', message: 'GitHub expands expressions before JavaScript parsing. Pull-request, issue, comment or workflow input text can therefore become executable JavaScript source.', location, evidence, remediation: 'Pass untrusted values through env or github-script inputs and read them as data at runtime; never splice them into JavaScript source.', tags: ['ci', 'expression-injection', 'github-script'] };
  return { id: 'ci-expression-shell-injection', domain: 'security', severity: 'critical', blocking: true, title: 'Attacker-controlled expression is interpolated into a run command', message: 'GitHub expands expressions before the shell parses the command. Event text or workflow inputs can inject shell syntax when directly embedded in run.', location, evidence, remediation: 'Assign the expression to an env value, then consume the environment variable as quoted data inside a literal run script. Validate constrained inputs before use.', tags: ['ci', 'expression-injection', 'shell'] };
}
function signal(file: SourceFile): WorkflowExpressionSignal { const expressions = executableExpressions(file); return { file: file.repositoryPath, executableExpressions: expressions.length, attackerControlledExpressions: expressions.filter(item => item.attackerControlled).length, dynamicUses: expressions.filter(item => item.key === 'uses').length, dynamicShells: expressions.filter(item => item.key === 'shell').length, dynamicContainers: expressions.filter(item => item.key === 'image').length, githubScriptExpressions: expressions.filter(item => item.key === 'script').length }; }
export function auditWorkflowExpressions(inventory: RepositoryInventory): AuditSection<WorkflowExpressionSummary> {
  const start = performance.now(); const files = workflowFiles(inventory); const workflows = files.map(signal); const findings = stableSortFindings(files.flatMap(file => executableExpressions(file).map(expression => findingFor(file, expression)).filter((finding): finding is Finding => finding !== undefined)));
  return { domain: 'security', title: 'CI executable expression boundary audit', summary: { workflows, workflowFiles: workflows.length, executableExpressions: workflows.reduce((sum, item) => sum + item.executableExpressions, 0), attackerControlledExpressions: workflows.reduce((sum, item) => sum + item.attackerControlledExpressions, 0), findings }, findings, elapsedMs: Math.max(0, performance.now() - start) };
}
