import {
  stableSortFindings,
  type AuditSection,
  type Finding,
  type RepositoryInventory,
  type SourceFile,
} from './contracts.mts';
import {
  physicalLines,
  unquoteYamlScalar,
  workflowFiles,
  workflowTopLevelBlock,
  type WorkflowLine,
  type WorkflowTopLevelBlock,
} from './workflow-structure.mts';

export interface ValidationTriggerSignal {
  readonly file: string;
  readonly workflowName: string;
  readonly authoritative: boolean;
  readonly pullRequest: boolean;
  readonly pullRequestTarget: boolean;
  readonly push: boolean;
  readonly prBranches: readonly string[];
  readonly prBranchesIgnore: readonly string[];
  readonly prPaths: readonly string[];
  readonly prPathsIgnore: readonly string[];
  readonly prTypes: readonly string[];
  readonly pushBranches: readonly string[];
  readonly pushBranchesIgnore: readonly string[];
}

export interface ValidationTriggerIntegritySummary {
  readonly workflowFiles: number;
  readonly authoritativeWorkflows: number;
  readonly pullRequestWorkflows: number;
  readonly filteredPullRequestWorkflows: number;
  readonly mainPushWorkflows: number;
  readonly signals: readonly ValidationTriggerSignal[];
  readonly findings: readonly Finding[];
}

interface EventBlock {
  readonly name: string;
  readonly header: WorkflowLine;
  readonly inlineValue: string;
  readonly lines: readonly WorkflowLine[];
}

const AUTHORITATIVE_NAME = /\b(?:release|quality|validation|audit|test|build|typecheck|typed|source[- ]?boundary|lint|security|gate|governance|architecture)\b/i;
const RELEASE_CRITICAL_NAME = /\b(?:release|quality|validation|gate)\b/i;
const VALIDATION_COMMAND = /\b(?:npm\s+(?:test|run\s+(?:test|lint|build|typecheck|check|audit))|npx\s+(?:tsc|vitest|eslint|oxlint)|node\s+--test|dotnet\s+(?:test|build|publish)|pytest|cargo\s+test|go\s+test|quality\/release\/(?:cli|pr-gate)\.mts)\b/i;
const EVENT_HEADER = /^\s*([A-Za-z0-9_-]+)\s*:\s*(.*?)\s*(?:#.*)?$/;
const LIST_ITEM = /^\s*-\s*(.*?)\s*(?:#.*)?$/;
const FILTER_KEYS = new Set(['branches', 'branches-ignore', 'paths', 'paths-ignore', 'types']);
const DEFAULT_PR_TYPES = ['opened', 'reopened', 'synchronize'] as const;

function workflowName(file: SourceFile): string {
  const name = workflowTopLevelBlock(file, 'name');
  return name?.value || file.repositoryPath.split('/').at(-1)?.replace(/\.ya?ml$/i, '') || file.repositoryPath;
}

function authoritative(file: SourceFile, name: string): boolean {
  if (!VALIDATION_COMMAND.test(file.text)) return false;
  return AUTHORITATIVE_NAME.test(name) || AUTHORITATIVE_NAME.test(file.repositoryPath);
}

function directChildIndent(lines: readonly WorkflowLine[], parentIndent: number): number | undefined {
  let result: number | undefined;
  for (const line of lines) {
    if (!line.trimmed || line.trimmed.startsWith('#') || line.indent <= parentIndent) continue;
    if (result === undefined || line.indent < result) result = line.indent;
  }
  return result;
}

function eventBlocks(on: WorkflowTopLevelBlock): EventBlock[] {
  if (on.value) return [];
  const eventIndent = directChildIndent(on.lines, on.line.indent);
  if (eventIndent === undefined) return [];
  const headers = on.lines.filter(line => line.indent === eventIndent && EVENT_HEADER.test(line.text));
  return headers.map((header, index) => {
    const match = header.text.match(EVENT_HEADER);
    const next = headers[index + 1];
    const lines = on.lines.filter(line => line.line > header.line && (!next || line.line < next.line));
    return {
      name: (match?.[1] ?? '').toLowerCase(),
      header,
      inlineValue: unquoteYamlScalar(match?.[2] ?? ''),
      lines,
    };
  });
}

function scalarEvents(on: WorkflowTopLevelBlock): Set<string> {
  const result = new Set<string>();
  const value = on.value.trim();
  if (!value) return result;
  if (value.startsWith('[') && value.endsWith(']')) {
    for (const item of value.slice(1, -1).split(',')) {
      const event = unquoteYamlScalar(item).trim().toLowerCase();
      if (event) result.add(event);
    }
    return result;
  }
  if (value.startsWith('{') && value.endsWith('}')) {
    for (const item of value.slice(1, -1).split(',')) {
      const event = unquoteYamlScalar(item.split(':', 1)[0] ?? '').trim().toLowerCase();
      if (event) result.add(event);
    }
    return result;
  }
  result.add(unquoteYamlScalar(value).toLowerCase());
  return result;
}

function eventPresent(on: WorkflowTopLevelBlock | undefined, name: string): boolean {
  if (!on) return false;
  if (on.value) return scalarEvents(on).has(name.toLowerCase());
  return eventBlocks(on).some(block => block.name === name.toLowerCase());
}

function eventBlock(on: WorkflowTopLevelBlock | undefined, name: string): EventBlock | undefined {
  if (!on || on.value) return undefined;
  return eventBlocks(on).find(block => block.name === name.toLowerCase());
}

function parseInlineList(value: string): string[] {
  const clean = value.trim();
  if (!clean) return [];
  if (clean.startsWith('[') && clean.endsWith(']')) {
    return clean.slice(1, -1).split(',').map(item => unquoteYamlScalar(item).trim()).filter(Boolean);
  }
  return [unquoteYamlScalar(clean).trim()].filter(Boolean);
}

function nestedFilter(block: EventBlock | undefined, key: string): string[] {
  if (!block) return [];
  if (block.inlineValue.startsWith('{') && block.inlineValue.endsWith('}')) {
    const body = block.inlineValue.slice(1, -1);
    const match = body.match(new RegExp(`(?:^|,)\\s*${key.replace('-', '\\-')}\\s*:\\s*(\\[[^\\]]*\\]|[^,]+)`, 'i'));
    if (match?.[1]) return parseInlineList(match[1]);
  }
  const fieldIndent = directChildIndent(block.lines, block.header.indent);
  if (fieldIndent === undefined) return [];
  const field = block.lines.find(line => line.indent === fieldIndent && new RegExp(`^\\s*${key.replace('-', '\\-')}\\s*:`, 'i').test(line.text));
  if (!field) return [];
  const raw = field.text.match(EVENT_HEADER)?.[2] ?? '';
  const inline = parseInlineList(unquoteYamlScalar(raw));
  if (inline.length > 0) return inline;
  const values: string[] = [];
  for (const line of block.lines) {
    if (line.line <= field.line) continue;
    if (line.trimmed && line.indent <= field.indent) break;
    const item = line.text.match(LIST_ITEM)?.[1];
    if (item !== undefined) {
      const value = unquoteYamlScalar(item).trim();
      if (value) values.push(value);
    }
  }
  return values;
}

function hasFilter(block: EventBlock | undefined, key: string): boolean {
  if (!block) return false;
  if (block.inlineValue.startsWith('{') && new RegExp(`(?:^|[, {])${key.replace('-', '\\-')}\\s*:`, 'i').test(block.inlineValue)) return true;
  return block.lines.some(line => {
    const match = line.text.match(EVENT_HEADER);
    return match && FILTER_KEYS.has((match[1] ?? '').toLowerCase()) && (match[1] ?? '').toLowerCase() === key.toLowerCase();
  });
}

function matchesMain(branches: readonly string[]): boolean {
  if (branches.length === 0) return true;
  return branches.some(value => value === 'main' || value === '*' || value === '**' || value === 'refs/heads/main');
}

function ignoresMain(branchesIgnore: readonly string[]): boolean {
  return branchesIgnore.some(value => value === 'main' || value === '*' || value === '**' || value === 'refs/heads/main');
}

function signal(file: SourceFile): ValidationTriggerSignal {
  const name = workflowName(file);
  const on = workflowTopLevelBlock(file, 'on');
  const pr = eventBlock(on, 'pull_request');
  const push = eventBlock(on, 'push');
  const prBranches = nestedFilter(pr, 'branches');
  const prBranchesIgnore = nestedFilter(pr, 'branches-ignore');
  const prPaths = nestedFilter(pr, 'paths');
  const prPathsIgnore = nestedFilter(pr, 'paths-ignore');
  const prTypes = nestedFilter(pr, 'types');
  const pushBranches = nestedFilter(push, 'branches');
  const pushBranchesIgnore = nestedFilter(push, 'branches-ignore');
  return {
    file: file.repositoryPath,
    workflowName: name,
    authoritative: authoritative(file, name),
    pullRequest: eventPresent(on, 'pull_request'),
    pullRequestTarget: eventPresent(on, 'pull_request_target'),
    push: eventPresent(on, 'push'),
    prBranches,
    prBranchesIgnore,
    prPaths,
    prPathsIgnore,
    prTypes,
    pushBranches,
    pushBranchesIgnore,
  };
}

function finding(current: ValidationTriggerSignal, id: string, severity: Finding['severity'], title: string, message: string, remediation: string, blocking = false): Finding {
  return {
    id,
    domain: 'release',
    severity,
    ...(blocking ? { blocking: true } : {}),
    title,
    message,
    location: { file: current.file, line: 1 },
    evidence: { metadata: { workflow: current.workflowName } },
    remediation,
    tags: ['ci', 'trigger', 'validation', 'coverage', 'release-gate'],
  };
}

function findingsFor(current: ValidationTriggerSignal): Finding[] {
  if (!current.authoritative) return [];
  const findings: Finding[] = [];
  if (!current.pullRequest) {
    findings.push(finding(current, 'ci-validation-pr-trigger-missing', 'high', 'Authoritative validation workflow does not run on pull requests', 'A test/build/audit workflow can validate main or manual runs while proposed changes bypass the same release signal before merge.', 'Add pull_request coverage without narrowing path filters so every proposed repository change receives the authoritative validation signal.', true));
  }
  if (current.pullRequestTarget && !current.pullRequest) {
    findings.push(finding(current, 'ci-validation-pull-request-target-only', 'critical', 'Authoritative validation relies on pull_request_target instead of pull_request', 'pull_request_target executes trusted base workflow code with a privileged event model and must not replace ordinary contribution validation.', 'Use pull_request for untrusted change validation. Reserve pull_request_target for narrowly reviewed metadata automation with no checkout or execution of contribution-controlled code.', true));
  }
  if (current.pullRequest && (current.prPaths.length > 0 || current.prPathsIgnore.length > 0)) {
    findings.push(finding(current, 'ci-validation-pr-path-filter', 'high', 'Authoritative pull-request validation is path filtered', `Path filters can skip the workflow for repository changes outside the selected set (paths=${current.prPaths.join(',') || '-'}; paths-ignore=${current.prPathsIgnore.join(',') || '-'}).`, 'Remove paths/paths-ignore from authoritative release checks. Keep fast path-specific workflows separate from the repository-wide required gate.', true));
  }
  if (current.pullRequest && current.prBranches.length > 0 && !matchesMain(current.prBranches)) {
    findings.push(finding(current, 'ci-validation-pr-main-branch-excluded', 'high', 'Pull-request validation does not target main', `Configured pull_request branches (${current.prBranches.join(', ')}) do not include main.`, 'Include main in pull_request branch filters or remove the branch filter from the authoritative validation workflow.', true));
  }
  if (current.pullRequest && ignoresMain(current.prBranchesIgnore)) {
    findings.push(finding(current, 'ci-validation-pr-main-branch-ignored', 'critical', 'Pull-request validation explicitly ignores main', `Configured branches-ignore (${current.prBranchesIgnore.join(', ')}) excludes the repository release branch.`, 'Never ignore main in an authoritative pull-request gate.', true));
  }
  if (current.pullRequest && current.prTypes.length > 0) {
    const normalized = new Set(current.prTypes.map(value => value.toLowerCase()));
    const missing = DEFAULT_PR_TYPES.filter(value => !normalized.has(value));
    if (missing.length > 0) {
      findings.push(finding(current, 'ci-validation-pr-types-incomplete', 'high', 'Pull-request validation omits lifecycle events that can change the head', `Custom pull_request types omit ${missing.join(', ')}. New commits or reopened PRs may therefore lack a fresh authoritative validation run.`, 'Include opened, reopened, and synchronize whenever custom pull_request types are specified, or remove the types filter to use GitHub defaults.', true));
    }
  }
  if (RELEASE_CRITICAL_NAME.test(current.workflowName) && current.push) {
    if (current.pushBranches.length > 0 && !matchesMain(current.pushBranches)) {
      findings.push(finding(current, 'ci-validation-main-push-excluded', 'medium', 'Release-critical validation push coverage excludes main', `Configured push branches (${current.pushBranches.join(', ')}) do not include main, so post-merge verification can drift from PR validation.`, 'Include main in push coverage for release-critical validation, while retaining pull_request as the pre-merge gate.'));
    }
    if (ignoresMain(current.pushBranchesIgnore)) {
      findings.push(finding(current, 'ci-validation-main-push-ignored', 'high', 'Release-critical validation explicitly ignores main pushes', 'Post-merge validation is disabled for the repository release branch.', 'Remove main from push branches-ignore so the merged tree receives the same authoritative release validation.', true));
    }
  }
  return findings;
}

export function auditValidationTriggerIntegrity(inventory: RepositoryInventory): AuditSection<ValidationTriggerIntegritySummary> {
  const started = performance.now();
  const files = workflowFiles(inventory);
  const signals = files.map(signal);
  const findings = stableSortFindings(signals.flatMap(findingsFor));
  return {
    domain: 'release',
    title: 'Authoritative validation trigger integrity audit',
    summary: {
      workflowFiles: files.length,
      authoritativeWorkflows: signals.filter(item => item.authoritative).length,
      pullRequestWorkflows: signals.filter(item => item.pullRequest).length,
      filteredPullRequestWorkflows: signals.filter(item => item.pullRequest && (item.prPaths.length > 0 || item.prPathsIgnore.length > 0 || item.prBranches.length > 0 || item.prBranchesIgnore.length > 0 || item.prTypes.length > 0)).length,
      mainPushWorkflows: signals.filter(item => item.push && matchesMain(item.pushBranches) && !ignoresMain(item.pushBranchesIgnore)).length,
      signals,
      findings,
    },
    findings,
    elapsedMs: Math.max(0, performance.now() - started),
  };
}
