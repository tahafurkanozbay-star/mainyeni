import { stableSortFindings, type AuditSection, type Finding, type RepositoryInventory, type SourceFile } from './contracts.mts';
import { createLineIndex, snippetAround } from './inventory.mts';

export interface WorkflowCacheSignal {
  readonly file: string;
  readonly cacheSteps: number;
  readonly dynamicKeys: number;
  readonly dynamicPaths: number;
  readonly broadRestorePrefixes: number;
  readonly sensitivePaths: number;
}

export interface WorkflowCacheSummary {
  readonly workflows: readonly WorkflowCacheSignal[];
  readonly workflowFiles: number;
  readonly cacheSteps: number;
  readonly dynamicKeys: number;
  readonly dynamicPaths: number;
  readonly broadRestorePrefixes: number;
  readonly sensitivePaths: number;
  readonly findings: readonly Finding[];
}

interface Line { readonly text: string; readonly offset: number; readonly number: number }
interface CacheStep {
  readonly file: SourceFile;
  readonly start: number;
  readonly line: number;
  readonly uses: string;
  readonly body: string;
  readonly key: string | undefined;
  readonly restoreKeys: readonly string[];
  readonly paths: readonly string[];
}

const WORKFLOW_PATH = /^\.github\/workflows\/[^/]+\.ya?ml$/i;
const CACHE_ACTION = /^\s*-\s+uses\s*:\s*actions\/cache(?:\/restore|\/save)?@([^\s#]+)(?:\s+#.*)?$/i;
const EXPRESSION = /\$\{\{([\s\S]*?)\}\}/g;
const UNTRUSTED = /\b(?:github\.event\.(?:pull_request\.(?:title|body|head\.ref|head\.sha)|issue\.(?:title|body)|comment\.body|review\.body|review_comment\.body|discussion\.(?:title|body)|head_commit\.message|commits|inputs\.)|github\.head_ref|inputs\.)\b/i;
const SENSITIVE_PATH = /(?:^|[\\/])(?:\.git|\.ssh|\.gnupg|\.aws|\.azure|\.config\/gcloud|\.docker)(?:[\\/]|$)|(?:^|[\\/])(?:\.env(?:\.[^/\\]+)?|\.npmrc|\.pypirc|credentials(?:\.json)?|config\.json)$/i;
const EXECUTABLE_PATH = /(?:^|[\\/])(?:node_modules|vendor|bin|dist|build|target|\.venv|venv)(?:[\\/]|$)/i;
const WRITE_PERMISSION = /^\s*(?:contents|packages|actions|deployments|id-token|security-events|statuses|checks|pull-requests)\s*:\s*write\b/im;

function lines(text: string): Line[] {
  const out: Line[] = [];
  let offset = 0;
  text.split('\n').forEach((raw, index) => {
    const value = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    out.push({ text: value, offset, number: index + 1 });
    offset += raw.length + 1;
  });
  return out;
}

function indent(text: string): number { return text.match(/^\s*/)?.[0].length ?? 0; }
function workflows(inventory: RepositoryInventory): SourceFile[] { return inventory.files.filter(file => WORKFLOW_PATH.test(file.repositoryPath)); }

function scalar(lines_: readonly Line[], index: number, baseIndent: number, name: string): { value?: string; values: string[] } {
  const pattern = new RegExp(`^\\s*${name}\\s*:\\s*(.*)$`, 'i');
  for (let cursor = index + 1; cursor < lines_.length; cursor += 1) {
    const current = lines_[cursor]!;
    if (current.text.trim() && indent(current.text) <= baseIndent && /^\s*-\s+/.test(current.text)) break;
    const match = current.text.match(pattern);
    if (!match) continue;
    const raw = (match[1] ?? '').trim();
    if (raw && !/^[>|][+-]?$/.test(raw)) return { value: raw.replace(/^['"]|['"]$/g, ''), values: [raw.replace(/^['"]|['"]$/g, '')] };
    const fieldIndent = indent(current.text);
    const values: string[] = [];
    for (let next = cursor + 1; next < lines_.length; next += 1) {
      const candidate = lines_[next]!;
      if (candidate.text.trim() && indent(candidate.text) <= fieldIndent) break;
      const trimmed = candidate.text.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      values.push(trimmed.replace(/^[-]\s*/, '').replace(/^['"]|['"]$/g, ''));
    }
    return { value: values.join('\n'), values };
  }
  return { values: [] };
}

function cacheSteps(file: SourceFile): CacheStep[] {
  const source = lines(file.text);
  const result: CacheStep[] = [];
  for (let index = 0; index < source.length; index += 1) {
    const current = source[index]!;
    const match = current.text.match(CACHE_ACTION);
    if (!match) continue;
    const stepIndent = indent(current.text);
    let end = index + 1;
    while (end < source.length && !(source[end]!.text.trim() && indent(source[end]!.text) <= stepIndent && /^\s*-\s+/.test(source[end]!.text))) end += 1;
    const body = source.slice(index, end).map(item => item.text).join('\n');
    const key = scalar(source, index, stepIndent, 'key').value;
    const restoreKeys = scalar(source, index, stepIndent, 'restore-keys').values;
    const paths = scalar(source, index, stepIndent, 'path').values;
    result.push({ file, start: current.offset, line: current.number, uses: match[1] ?? '', body, key, restoreKeys, paths });
  }
  return result;
}

function expressions(value: string | undefined): string[] {
  if (!value) return [];
  const found: string[] = [];
  let match: RegExpExecArray | null;
  const matcher = new RegExp(EXPRESSION.source, EXPRESSION.flags);
  while ((match = matcher.exec(value)) !== null) found.push((match[1] ?? '').trim());
  return found;
}

function untrusted(value: string | undefined): boolean { return expressions(value).some(item => UNTRUSTED.test(item)); }
function dynamic(value: string | undefined): boolean { return expressions(value).length > 0; }
function privileged(file: SourceFile): boolean { return WRITE_PERMISSION.test(file.text) || /permissions\s*:\s*write-all\b/i.test(file.text); }
function broadPrefix(value: string): boolean {
  const normalized = value.trim().replace(/^['"]|['"]$/g, '');
  if (!normalized) return true;
  if (untrusted(normalized)) return true;
  const literal = normalized.replace(/\$\{\{[\s\S]*?\}\}/g, '').replace(/[-_/.:]+$/g, '');
  return literal.length < 8 || /^(?:npm|node|build|cache|deps|packages?|linux|windows|macos)$/i.test(literal);
}

function finding(step: CacheStep, id: string, severity: Finding['severity'], title: string, message: string, remediation: string, blocking: boolean): Finding {
  return {
    id, domain: 'security', severity, blocking, title, message,
    location: { file: step.file.repositoryPath, line: step.line },
    evidence: { excerpt: snippetAround(step.file.text, step.start, 180) },
    remediation,
    tags: ['ci', 'workflow', 'cache', 'supply-chain'],
  };
}

function findingsFor(step: CacheStep): Finding[] {
  const result: Finding[] = [];
  const isPrivileged = privileged(step.file);
  if (!/^[0-9a-f]{40}$/i.test(step.uses)) {
    result.push(finding(step, 'ci-cache-action-mutable-ref', 'critical', 'Cache action is not pinned to an immutable commit', 'A mutable cache action identity can replace code in the CI trust boundary.', 'Pin actions/cache to a reviewed 40-character commit SHA.', true));
  }
  if (!step.key) {
    result.push(finding(step, 'ci-cache-key-missing', isPrivileged ? 'critical' : 'high', 'Cache key is missing', 'A cache step without an explicit reviewed key cannot demonstrate deterministic cache isolation.', 'Provide an explicit key containing stable dependency and platform identity.', isPrivileged));
  } else if (untrusted(step.key)) {
    result.push(finding(step, 'ci-cache-key-untrusted-input', 'critical', 'Cache key includes attacker-controlled input', 'Attacker-controlled event or workflow input participates directly in cache namespace selection.', 'Derive cache keys only from trusted repository state, runner facts and immutable dependency hashes.', true));
  }
  if (step.paths.some(path => untrusted(path))) {
    result.push(finding(step, 'ci-cache-path-untrusted-input', 'critical', 'Cache path includes attacker-controlled input', 'Untrusted path selection can move sensitive or executable files across the cache boundary.', 'Use literal reviewed cache paths.', true));
  }
  if (step.paths.some(path => SENSITIVE_PATH.test(path))) {
    result.push(finding(step, 'ci-cache-sensitive-path', 'critical', 'Cache includes credential or repository-control material', 'Credential stores, Git metadata, environment files and client authentication configuration must not cross cache trust boundaries.', 'Remove sensitive paths from the cache and recreate credentials ephemerally.', true));
  }
  const executable = step.paths.filter(path => EXECUTABLE_PATH.test(path));
  if (isPrivileged && executable.length > 0 && step.restoreKeys.some(broadPrefix)) {
    result.push(finding(step, 'ci-cache-privileged-broad-executable-restore', 'critical', 'Privileged workflow broadly restores executable cache content', 'A broad fallback prefix can select older or unintended executable dependency/build content before a privileged job.', 'Use an exact content-addressed key for executable cache content and remove broad restore prefixes from privileged jobs.', true));
  }
  if (isPrivileged && step.restoreKeys.some(value => untrusted(value))) {
    result.push(finding(step, 'ci-cache-privileged-untrusted-restore-prefix', 'critical', 'Privileged cache restore prefix is attacker-controlled', 'An attacker-controlled restore prefix can steer a privileged workflow toward an unintended cache entry.', 'Use literal or trusted content-addressed restore namespaces.', true));
  }
  return result;
}

function signal(file: SourceFile): WorkflowCacheSignal {
  const steps = cacheSteps(file);
  return {
    file: file.repositoryPath,
    cacheSteps: steps.length,
    dynamicKeys: steps.filter(step => dynamic(step.key)).length,
    dynamicPaths: steps.filter(step => step.paths.some(dynamic)).length,
    broadRestorePrefixes: steps.reduce((sum, step) => sum + step.restoreKeys.filter(broadPrefix).length, 0),
    sensitivePaths: steps.reduce((sum, step) => sum + step.paths.filter(path => SENSITIVE_PATH.test(path)).length, 0),
  };
}

export function auditWorkflowCacheBoundaries(inventory: RepositoryInventory): AuditSection<WorkflowCacheSummary> {
  const started = performance.now();
  const files = workflows(inventory);
  const workflowSignals = files.map(signal);
  const findings = stableSortFindings(files.flatMap(file => cacheSteps(file).flatMap(findingsFor)));
  return {
    domain: 'security',
    title: 'Workflow cache trust boundary audit',
    summary: {
      workflows: workflowSignals,
      workflowFiles: files.length,
      cacheSteps: workflowSignals.reduce((sum, item) => sum + item.cacheSteps, 0),
      dynamicKeys: workflowSignals.reduce((sum, item) => sum + item.dynamicKeys, 0),
      dynamicPaths: workflowSignals.reduce((sum, item) => sum + item.dynamicPaths, 0),
      broadRestorePrefixes: workflowSignals.reduce((sum, item) => sum + item.broadRestorePrefixes, 0),
      sensitivePaths: workflowSignals.reduce((sum, item) => sum + item.sensitivePaths, 0),
      findings,
    },
    findings,
    elapsedMs: Math.max(0, performance.now() - started),
  };
}
