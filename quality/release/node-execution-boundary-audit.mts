import {
  stableSortFindings,
  type AuditSection,
  type Finding,
  type RepositoryInventory,
  type SourceFile,
} from './contracts.mts';

export interface NodeExecutionSignal {
  readonly file: string;
  readonly evalCalls: number;
  readonly functionConstructors: number;
  readonly vmExecutions: number;
  readonly execCalls: number;
  readonly execSyncCalls: number;
  readonly shellSpawns: number;
  readonly dynamicImports: number;
  readonly dynamicRequires: number;
  readonly envCommandReferences: number;
}

export interface NodeExecutionBoundarySummary {
  readonly files: readonly NodeExecutionSignal[];
  readonly scannedFiles: number;
  readonly dynamicCodeFiles: number;
  readonly shellExecutionFiles: number;
  readonly dynamicModuleFiles: number;
  readonly findings: readonly Finding[];
}

interface MatchRule {
  readonly id: string;
  readonly severity: Finding['severity'];
  readonly title: string;
  readonly message: string;
  readonly remediation: string;
  readonly pattern: RegExp;
  readonly blocking: boolean;
  readonly tag: string;
}

const ELIGIBLE_PATH = /^(?:tools\/|quality\/|Webclient\.app\/scripts\/|Webclient\.Admin\/scripts\/|scripts\/)/i;
const SOURCE_EXT = /\.(?:[cm]?[jt]s|[cm]?tsx?)$/i;
const GENERATED = /(^|\/)(?:node_modules|dist|build|coverage|bin|obj|qa-artifacts|fixtures?)(?:\/|$)/i;
const TEST_FILE = /(?:\.test|\.spec)\.[cm]?[jt]s$/i;
const MAX_FINDINGS = 32;

const RULES: readonly MatchRule[] = [
  {
    id: 'node-execution-eval',
    severity: 'critical',
    title: 'Node tooling executes source through eval',
    message: 'eval turns data into executable source and defeats static review of the release/tooling boundary.',
    remediation: 'Replace eval with explicit parsing, dispatch tables or a typed interpreter for the bounded input grammar.',
    pattern: /\beval\s*\(/g,
    blocking: true,
    tag: 'dynamic-code',
  },
  {
    id: 'node-execution-function-constructor',
    severity: 'critical',
    title: 'Node tooling constructs executable functions from strings',
    message: 'new Function or Function(...) creates a runtime code-generation boundary that static TypeScript cannot validate.',
    remediation: 'Use typed functions selected from a closed map; do not compile source strings at runtime.',
    pattern: /(?:\bnew\s+Function\s*\(|(?<![.$\w])Function\s*\()/g,
    blocking: true,
    tag: 'dynamic-code',
  },
  {
    id: 'node-execution-vm-source',
    severity: 'critical',
    title: 'Node tooling executes source through the vm module',
    message: 'vm execution still interprets source text and can cross the release trust boundary when inputs are not immutable.',
    remediation: 'Prefer structured data parsing. If isolation is unavoidable, move execution to a separately sandboxed process with an explicit immutable source allowlist.',
    pattern: /\b(?:vm\.)?(?:runInContext|runInNewContext|runInThisContext|compileFunction|Script)\s*\(/g,
    blocking: true,
    tag: 'dynamic-code',
  },
  {
    id: 'node-execution-exec',
    severity: 'medium',
    title: 'Tooling uses shell-string child_process.exec',
    message: 'exec delegates quoting and tokenization to a shell, increasing command-injection and portability risk.',
    remediation: 'Prefer execFile or spawn with an executable plus a typed argument array and shell=false.',
    pattern: /\b(?:exec|child_process\.exec)\s*\(/g,
    blocking: false,
    tag: 'shell',
  },
  {
    id: 'node-execution-exec-sync',
    severity: 'medium',
    title: 'Tooling uses synchronous shell-string execution',
    message: 'execSync combines shell parsing risk with event-loop blocking and is unsuitable for scalable release tooling.',
    remediation: 'Prefer async execFile/spawn with explicit arguments, timeout and bounded output handling.',
    pattern: /\b(?:execSync|child_process\.execSync)\s*\(/g,
    blocking: false,
    tag: 'shell',
  },
  {
    id: 'node-execution-shell-true',
    severity: 'medium',
    title: 'Child process explicitly enables shell mode',
    message: 'shell:true reintroduces shell parsing even when spawn/execFile APIs are used.',
    remediation: 'Keep shell=false and pass each argument as a separate reviewed value.',
    pattern: /\bshell\s*:\s*true\b/g,
    blocking: false,
    tag: 'shell',
  },
  {
    id: 'node-execution-dynamic-import',
    severity: 'low',
    title: 'Tooling dynamically selects an imported module',
    message: 'Expression-derived import() makes the executable module graph harder to review and bundle deterministically.',
    remediation: 'Use a literal import or a closed typed map from allowed names to literal imports.',
    pattern: /\bimport\s*\(\s*(?!['"`][^'"`]+['"`]\s*\))[^)]+\)/g,
    blocking: false,
    tag: 'module-graph',
  },
  {
    id: 'node-execution-dynamic-require',
    severity: 'low',
    title: 'Tooling dynamically selects a CommonJS module',
    message: 'Dynamic require keeps a CommonJS execution island and makes provenance of loaded code difficult to prove.',
    remediation: 'Migrate to ESM and use a closed literal import map.',
    pattern: /\brequire\s*\(\s*(?!['"][^'"]+['"]\s*\))[^)]+\)/g,
    blocking: false,
    tag: 'module-graph',
  },
];

function isEligible(file: SourceFile): boolean {
  return ELIGIBLE_PATH.test(file.repositoryPath)
    && SOURCE_EXT.test(file.repositoryPath)
    && !GENERATED.test(file.repositoryPath)
    && !TEST_FILE.test(file.repositoryPath);
}

function lineAt(text: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (text.charCodeAt(index) === 10) line += 1;
  }
  return line;
}

function excerpt(text: string, offset: number): string {
  const start = Math.max(0, text.lastIndexOf('\n', offset - 1) + 1);
  const nextLine = text.indexOf('\n', offset);
  const end = nextLine < 0 ? text.length : nextLine;
  const value = text.slice(start, end).trim().replace(/\s+/g, ' ');
  return value.length <= 180 ? value : `${value.slice(0, 179)}…`;
}

function count(text: string, pattern: RegExp): number {
  const matcher = new RegExp(pattern.source, pattern.flags);
  let total = 0;
  while (matcher.exec(text) !== null) total += 1;
  return total;
}

function signal(file: SourceFile): NodeExecutionSignal {
  return {
    file: file.repositoryPath,
    evalCalls: count(file.text, /\beval\s*\(/g),
    functionConstructors: count(file.text, /(?:\bnew\s+Function\s*\(|(?<![.$\w])Function\s*\()/g),
    vmExecutions: count(file.text, /\b(?:vm\.)?(?:runInContext|runInNewContext|runInThisContext|compileFunction|Script)\s*\(/g),
    execCalls: count(file.text, /\b(?:exec|child_process\.exec)\s*\(/g),
    execSyncCalls: count(file.text, /\b(?:execSync|child_process\.execSync)\s*\(/g),
    shellSpawns: count(file.text, /\bshell\s*:\s*true\b/g),
    dynamicImports: count(file.text, /\bimport\s*\(\s*(?!['"`][^'"`]+['"`]\s*\))[^)]+\)/g),
    dynamicRequires: count(file.text, /\brequire\s*\(\s*(?!['"][^'"]+['"]\s*\))[^)]+\)/g),
    envCommandReferences: count(file.text, /\bprocess\.env\.[A-Za-z_][A-Za-z0-9_]*\b/g),
  };
}

function findingFor(file: SourceFile, rule: MatchRule, offset: number): Finding {
  return {
    id: rule.id,
    domain: 'security',
    severity: rule.severity,
    ...(rule.blocking ? { blocking: true } : {}),
    title: rule.title,
    message: rule.message,
    location: { file: file.repositoryPath, line: lineAt(file.text, offset) },
    evidence: { excerpt: excerpt(file.text, offset) },
    remediation: rule.remediation,
    tags: ['node', 'tooling', 'execution', rule.tag],
  };
}

function ruleFindings(file: SourceFile): Finding[] {
  const findings: Finding[] = [];
  for (const rule of RULES) {
    const matcher = new RegExp(rule.pattern.source, rule.pattern.flags);
    let match: RegExpExecArray | null;
    while ((match = matcher.exec(file.text)) !== null) {
      findings.push(findingFor(file, rule, match.index));
      if (match[0].length === 0) matcher.lastIndex += 1;
    }
  }
  return findings;
}

function envCommandFindings(file: SourceFile): Finding[] {
  const findings: Finding[] = [];
  const lines = file.text.split(/\r?\n/);
  lines.forEach((line, index) => {
    if (!/\bprocess\.env\.[A-Za-z_][A-Za-z0-9_]*\b/.test(line)) return;
    if (!/\b(?:exec|execSync|spawn|spawnSync|execFile|execFileSync)\b/.test(line)) return;
    findings.push({
      id: 'node-execution-env-command-composition',
      domain: 'security',
      severity: 'medium',
      title: 'Environment-derived value participates in child-process invocation',
      message: 'Environment values are runtime input. Passing them directly into process execution requires an allowlist and argument separation.',
      location: { file: file.repositoryPath, line: index + 1 },
      evidence: { excerpt: line.trim().slice(0, 180) },
      remediation: 'Validate environment values against a closed allowlist and pass them only as individual arguments with shell=false.',
      tags: ['node', 'tooling', 'execution', 'environment'],
    });
  });
  return findings;
}

function hasDynamicCode(item: NodeExecutionSignal): boolean {
  return item.evalCalls + item.functionConstructors + item.vmExecutions > 0;
}

function hasShellExecution(item: NodeExecutionSignal): boolean {
  return item.execCalls + item.execSyncCalls + item.shellSpawns > 0;
}

function hasDynamicModules(item: NodeExecutionSignal): boolean {
  return item.dynamicImports + item.dynamicRequires > 0;
}

export function auditNodeExecutionBoundaries(
  inventory: RepositoryInventory,
): AuditSection<NodeExecutionBoundarySummary> {
  const started = performance.now();
  const files = inventory.files.filter(isEligible);
  const signals = files.map(signal).sort((left, right) => left.file.localeCompare(right.file));
  const allFindings = stableSortFindings(files.flatMap(file => [
    ...ruleFindings(file),
    ...envCommandFindings(file),
  ]));
  const blocking = allFindings.filter(item => item.blocking === true);
  const review = allFindings.filter(item => item.blocking !== true);
  const findings = stableSortFindings([
    ...blocking,
    ...review.slice(0, Math.max(0, MAX_FINDINGS - blocking.length)),
  ]);
  return {
    domain: 'security',
    title: 'Typed Node execution boundary audit',
    summary: {
      files: signals,
      scannedFiles: signals.length,
      dynamicCodeFiles: signals.filter(hasDynamicCode).length,
      shellExecutionFiles: signals.filter(hasShellExecution).length,
      dynamicModuleFiles: signals.filter(hasDynamicModules).length,
      findings,
    },
    findings,
    elapsedMs: Math.max(0, performance.now() - started),
  };
}
