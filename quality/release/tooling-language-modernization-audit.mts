import {
  stableSortFindings,
  type AuditSection,
  type Finding,
  type RepositoryInventory,
  type SourceFile,
} from './contracts.mts';

export interface ToolingLanguageSignal {
  readonly file: string;
  readonly extension: string;
  readonly typed: boolean;
  readonly esm: boolean;
  readonly commonJsRequire: number;
  readonly commonJsExports: number;
  readonly tsNoCheck: number;
  readonly tsIgnore: number;
  readonly tsExpectError: number;
  readonly explicitAny: number;
}

export interface ToolingLanguageModernizationSummary {
  readonly files: readonly ToolingLanguageSignal[];
  readonly totalToolingFiles: number;
  readonly typedFiles: number;
  readonly legacyJavaScriptFiles: number;
  readonly commonJsFiles: number;
  readonly typedRatio: number;
  readonly findings: readonly Finding[];
}

const TOOLING_PATH = /^(?:tools\/|quality\/|scripts\/|Webclient\.app\/scripts\/|Webclient\.Admin\/scripts\/)/i;
const SOURCE_EXT = /\.(?:js|jsx|mjs|cjs|ts|tsx|mts|cts)$/i;
const TYPED_EXT = /\.(?:ts|tsx|mts|cts)$/i;
const ESM_EXT = /\.(?:mjs|mts)$/i;
const LEGACY_EXT = /\.(?:js|jsx|mjs|cjs)$/i;
const GENERATED = /(^|\/)(?:node_modules|dist|build|coverage|bin|obj|qa-artifacts|generated)(?:\/|$)/i;
const FIXTURE = /(^|\/)(?:fixtures?|snapshots?|__snapshots__)(?:\/|$)/i;
const TEST_FILE = /(?:\.test|\.spec)\.(?:js|jsx|mjs|cjs|ts|tsx|mts|cts)$/i;
const COMMONJS_REQUIRE = /\brequire\s*\(/g;
const COMMONJS_EXPORT = /\b(?:module\.exports\b|exports\.[A-Za-z_$][\w$]*\s*=)/g;
const TS_NOCHECK = /^\s*\/\/\s*@ts-nocheck\b/gm;
const TS_IGNORE = /^\s*\/\/\s*@ts-ignore\b/gm;
const TS_EXPECT_ERROR = /^\s*\/\/\s*@ts-expect-error\b/gm;
const EXPLICIT_ANY = /(?:\bas\s+any\b|:\s*any\b|<any>)/g;
const MAX_LEGACY_FINDINGS = 24;

function count(text: string, pattern: RegExp): number {
  const matcher = new RegExp(pattern.source, pattern.flags);
  let total = 0;
  while (matcher.exec(text) !== null) total += 1;
  return total;
}

function isEligible(file: SourceFile): boolean {
  return TOOLING_PATH.test(file.repositoryPath)
    && SOURCE_EXT.test(file.repositoryPath)
    && !GENERATED.test(file.repositoryPath)
    && !FIXTURE.test(file.repositoryPath)
    && !TEST_FILE.test(file.repositoryPath);
}

function extension(file: SourceFile): string {
  const index = file.repositoryPath.lastIndexOf('.');
  return index >= 0 ? file.repositoryPath.slice(index).toLowerCase() : '';
}

function signal(file: SourceFile): ToolingLanguageSignal {
  const ext = extension(file);
  const requireCount = count(file.text, COMMONJS_REQUIRE);
  const exportCount = count(file.text, COMMONJS_EXPORT);
  return {
    file: file.repositoryPath,
    extension: ext,
    typed: TYPED_EXT.test(file.repositoryPath),
    esm: ESM_EXT.test(file.repositoryPath) || (/\b(?:import|export)\b/.test(file.text) && requireCount === 0 && exportCount === 0),
    commonJsRequire: requireCount,
    commonJsExports: exportCount,
    tsNoCheck: count(file.text, TS_NOCHECK),
    tsIgnore: count(file.text, TS_IGNORE),
    tsExpectError: count(file.text, TS_EXPECT_ERROR),
    explicitAny: count(file.text, EXPLICIT_ANY),
  };
}

function finding(
  id: string,
  severity: Finding['severity'],
  title: string,
  message: string,
  file: string,
  remediation: string,
  tags: readonly string[],
  blocking = false,
): Finding {
  return {
    id,
    domain: 'architecture',
    severity,
    ...(blocking ? { blocking: true } : {}),
    title,
    message,
    location: { file, line: 1 },
    remediation,
    tags,
  };
}

function legacyFinding(item: ToolingLanguageSignal): Finding | undefined {
  if (!LEGACY_EXT.test(item.file)) return undefined;
  if (item.extension === '.cjs') {
    return finding(
      'tooling-language-commonjs-extension',
      'medium',
      'Active tooling still uses an explicit CommonJS module extension',
      'A .cjs tooling module remains outside the repository native ESM/TypeScript execution model.',
      item.file,
      'Migrate the module to .mts with explicit node: imports and typed inputs/outputs; update callers in the same validated slice.',
      ['modernization', 'typescript', 'esm', 'tooling'],
    );
  }
  if (item.extension === '.jsx') {
    return finding(
      'tooling-language-jsx-without-types',
      'low',
      'Tooling JSX remains outside TypeScript',
      'JSX-bearing tooling should use .tsx so props and runtime contracts are compiler checked.',
      item.file,
      'Migrate to .tsx and add the file to an explicit strict tooling tsconfig.',
      ['modernization', 'typescript', 'tsx', 'tooling'],
    );
  }
  return finding(
    'tooling-language-untyped-module',
    'info',
    'Active tooling module remains JavaScript',
    `${item.file} is ${item.extension} rather than a typed .mts/.ts module.`,
    item.file,
    'Migrate the module feature-by-feature to .mts/.ts while preserving CLI/output contracts and regression tests.',
    ['modernization', 'typescript', 'esm', 'tooling'],
  );
}

function contractFindings(item: ToolingLanguageSignal): Finding[] {
  const findings: Finding[] = [];
  if (item.commonJsRequire > 0 || item.commonJsExports > 0) {
    findings.push(finding(
      'tooling-language-commonjs-contract',
      item.extension === '.cjs' ? 'medium' : 'low',
      'Tooling module contains CommonJS runtime contracts',
      `${item.commonJsRequire} require() and ${item.commonJsExports} CommonJS export occurrence(s) remain.`,
      item.file,
      'Use ESM import/export and node: builtins. Where synchronous loading is required, isolate it behind a reviewed compatibility adapter.',
      ['modernization', 'typescript', 'esm', 'commonjs'],
    ));
  }
  if (item.tsNoCheck > 0) {
    findings.push(finding(
      'tooling-language-ts-nocheck',
      'high',
      'Type checking is disabled in release/tooling code',
      'A file-level TypeScript checking disable directive creates an untyped island inside the build and release control plane.',
      item.file,
      'Remove the file-level suppression and repair the underlying types; split legacy adapters if migration must be staged.',
      ['modernization', 'typescript', 'strict', 'tooling'],
      true,
    ));
  }
  if (item.tsIgnore > 0) {
    findings.push(finding(
      'tooling-language-ts-ignore',
      'medium',
      'Tooling suppresses TypeScript diagnostics without an expectation contract',
      `${item.tsIgnore} broad TypeScript diagnostic suppression(s) hide compiler drift.`,
      item.file,
      'Fix the type contract or use a narrowly documented expected-error directive tied to a known dependency limitation.',
      ['modernization', 'typescript', 'strict', 'tooling'],
    ));
  }
  if (item.explicitAny > 0 && item.typed) {
    findings.push(finding(
      'tooling-language-explicit-any',
      'info',
      'Typed tooling still contains explicit any escapes',
      `${item.explicitAny} explicit any escape(s) reduce compiler coverage in release/tooling code.`,
      item.file,
      'Prefer unknown plus narrowing or a concrete command/report/domain type.',
      ['modernization', 'typescript', 'strict', 'tooling'],
    ));
  }
  return findings;
}

function typedRatio(items: readonly ToolingLanguageSignal[]): number {
  if (items.length === 0) return 1;
  return Number((items.filter(item => item.typed).length / items.length).toFixed(4));
}

function pathOrder(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function auditToolingLanguageModernization(
  inventory: RepositoryInventory,
): AuditSection<ToolingLanguageModernizationSummary> {
  const started = performance.now();
  const files = inventory.files.filter(isEligible);
  const signals = files.map(signal).sort((left, right) => pathOrder(left.file, right.file));
  const legacy = signals
    .map(legacyFinding)
    .filter((item): item is Finding => item !== undefined)
    .slice(0, MAX_LEGACY_FINDINGS);
  const findings = stableSortFindings([
    ...legacy,
    ...signals.flatMap(contractFindings),
  ]);
  return {
    domain: 'architecture',
    title: 'Tooling TypeScript/ESM modernization ratchet',
    summary: {
      files: signals,
      totalToolingFiles: signals.length,
      typedFiles: typedFilesCount(signals),
      legacyJavaScriptFiles: signals.filter(item => LEGACY_EXT.test(item.file)).length,
      commonJsFiles: signals.filter(item => item.commonJsRequire > 0 || item.commonJsExports > 0).length,
      typedRatio: typedRatio(signals),
      findings,
    },
    findings,
    elapsedMs: Math.max(0, performance.now() - started),
  };
}

function typedFilesCount(items: readonly ToolingLanguageSignal[]): number {
  return items.filter(item => item.typed).length;
}
