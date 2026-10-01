import {
  stableSortFindings,
  type AuditSection,
  type Finding,
  type RepositoryInventory,
  type SourceFile,
} from './contracts.mts';

export interface ModuleBoundarySignal {
  readonly file: string;
  readonly extension: string;
  readonly commonJsRequires: number;
  readonly commonJsExports: number;
  readonly dynamicRequires: number;
  readonly dynamicImports: number;
  readonly importMetaUses: number;
  readonly esmImports: number;
  readonly esmExports: number;
}

export interface ModuleBoundarySummary {
  readonly files: readonly ModuleBoundarySignal[];
  readonly javascriptFiles: number;
  readonly typedFiles: number;
  readonly commonJsFiles: number;
  readonly mixedModuleFiles: number;
  readonly findings: readonly Finding[];
}

const ACTIVE_SOURCE = /^(?:Webclient[^/]*|AdminWebClient[^/]*|tools|scripts|quality)\//i;
const EXCLUDED = /(?:^|\/)(?:node_modules|dist|build|coverage|wwwroot\/dist|obj|bin|vendor)(?:\/|$)/i;
const JS_EXTENSION = /\.(?:js|jsx|mjs|cjs)$/i;
const TS_EXTENSION = /\.(?:ts|tsx|mts|cts)$/i;
const REQUIRE_CALL = /\brequire\s*\(\s*(['"])([^'"]+)\1\s*\)/g;
const DYNAMIC_REQUIRE = /\brequire\s*\(\s*(?!['"])[^)]+\)/g;
const MODULE_EXPORTS = /\bmodule\.exports\b/g;
const EXPORTS_ASSIGN = /(?:^|[^\w])exports\.[A-Za-z_$][\w$]*\s*=/g;
const ESM_IMPORT = /(?:^|\n)\s*import\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)?['"][^'"]+['"]/g;
const ESM_EXPORT = /(?:^|\n)\s*export\s+(?:default\s+|type\s+|interface\s+|class\s+|function\s+|const\s+|let\s+|var\s+|\{|\*)/g;
const DYNAMIC_IMPORT = /\bimport\s*\(\s*([^)]+)\)/g;
const IMPORT_META = /\bimport\.meta\b/g;
const REQUIRE_RESOLVE = /\brequire\.resolve\s*\(/g;
const NODE_REQUIRE_BRIDGE = /\bcreateRequire\s*\(\s*import\.meta\.url\s*\)/g;
const TS_IGNORE = /@ts-ignore|@ts-nocheck/i;
const FILE_PROTOCOL_HACK = /fileURLToPath\s*\(\s*new\s+URL\s*\([^,]+,\s*import\.meta\.url\s*\)\s*\)/g;
const CJS_GLOBALS = /\b(?:__dirname|__filename)\b/g;
const JSON_REQUIRE = /\brequire\s*\(\s*['"][^'"]+\.json['"]\s*\)/g;

function count(text: string, pattern: RegExp): number {
  return [...text.matchAll(new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`))].length;
}

function sourceFiles(inventory: RepositoryInventory): SourceFile[] {
  return inventory.files.filter(file =>
    ACTIVE_SOURCE.test(file.repositoryPath)
    && !EXCLUDED.test(file.repositoryPath)
    && (JS_EXTENSION.test(file.repositoryPath) || TS_EXTENSION.test(file.repositoryPath)));
}

function signal(file: SourceFile): ModuleBoundarySignal {
  return {
    file: file.repositoryPath,
    extension: file.extension.toLowerCase(),
    commonJsRequires: count(file.text, REQUIRE_CALL),
    commonJsExports: count(file.text, MODULE_EXPORTS) + count(file.text, EXPORTS_ASSIGN),
    dynamicRequires: count(file.text, DYNAMIC_REQUIRE),
    dynamicImports: count(file.text, DYNAMIC_IMPORT),
    importMetaUses: count(file.text, IMPORT_META),
    esmImports: count(file.text, ESM_IMPORT),
    esmExports: count(file.text, ESM_EXPORT),
  };
}

function lineOf(text: string, pattern: RegExp): number {
  const matcher = new RegExp(pattern.source, pattern.flags.replace('g', ''));
  const match = matcher.exec(text);
  if (!match || match.index === undefined) return 1;
  return text.slice(0, match.index).split('\n').length;
}

function finding(
  file: SourceFile,
  id: string,
  severity: Finding['severity'],
  title: string,
  message: string,
  remediation: string,
  blocking: boolean,
  pattern?: RegExp,
): Finding {
  return {
    id,
    domain: 'architecture',
    severity,
    ...(blocking ? { blocking: true } : {}),
    title,
    message,
    location: { file: file.repositoryPath, line: pattern ? lineOf(file.text, pattern) : 1 },
    remediation,
    tags: ['modernization', 'modules', 'esm', 'typescript', 'architecture'],
  };
}

function packageBoundary(inventory: RepositoryInventory, file: SourceFile): 'module' | 'commonjs' | 'unknown' {
  const parts = file.repositoryPath.split('/');
  parts.pop();
  while (parts.length >= 0) {
    const prefix = parts.length > 0 ? `${parts.join('/')}/` : '';
    const manifest = inventory.files.find(candidate => candidate.repositoryPath === `${prefix}package.json`);
    if (manifest) {
      try {
        const parsed = JSON.parse(manifest.text) as { type?: unknown };
        return parsed.type === 'module' ? 'module' : parsed.type === 'commonjs' ? 'commonjs' : 'unknown';
      } catch {
        return 'unknown';
      }
    }
    if (parts.length === 0) break;
    parts.pop();
  }
  return 'unknown';
}

function literalDynamicImport(argument: string): boolean {
  const value = argument.trim();
  return /^(['"])[^'"]+\1(?:\s*,[\s\S]*)?$/.test(value);
}

function dynamicImportArguments(text: string): string[] {
  const result: string[] = [];
  const matcher = new RegExp(DYNAMIC_IMPORT.source, DYNAMIC_IMPORT.flags);
  let match: RegExpExecArray | null;
  while ((match = matcher.exec(text)) !== null) result.push((match[1] ?? '').trim());
  return result;
}

function findingsFor(inventory: RepositoryInventory, file: SourceFile): Finding[] {
  const current = signal(file);
  const result: Finding[] = [];
  const boundary = packageBoundary(inventory, file);
  const isTyped = TS_EXTENSION.test(file.repositoryPath);
  const isJs = JS_EXTENSION.test(file.repositoryPath);
  const hasCommonJs = current.commonJsRequires + current.commonJsExports + current.dynamicRequires > 0;
  const hasEsm = current.esmImports + current.esmExports + current.importMetaUses > 0;

  if (file.repositoryPath.endsWith('.cjs') && ACTIVE_SOURCE.test(file.repositoryPath)) {
    result.push(finding(
      file,
      'module-active-commonjs-file',
      'medium',
      'Active tooling still uses a CommonJS .cjs module',
      'A .cjs file creates a permanent CommonJS island inside the modern tooling/source surface.',
      'Migrate the module to TypeScript ESM (.mts/.ts) unless a specific third-party runtime requires CommonJS.',
      false,
    ));
  }

  if (/\.m?js$/i.test(file.repositoryPath) && ACTIVE_SOURCE.test(file.repositoryPath) && !/\.config\.(?:m?js)$/i.test(file.repositoryPath)) {
    result.push(finding(
      file,
      'module-active-javascript-migration-candidate',
      'low',
      'Active JavaScript module remains outside the typed source boundary',
      'The repository still contains executable JavaScript in an active source/tooling root.',
      'Migrate behavior-bearing JavaScript to .ts/.mts with strict compiler coverage, preserving runtime semantics.',
      false,
    ));
  }

  if (isTyped && count(file.text, REQUIRE_CALL) > 0 && count(file.text, NODE_REQUIRE_BRIDGE) === 0) {
    result.push(finding(
      file,
      'module-commonjs-require-in-typescript',
      'high',
      'Typed module uses CommonJS require()',
      'require() bypasses static ESM import analysis and can create runtime/type-resolution divergence.',
      'Use static ESM imports, import(), or an explicit createRequire bridge only for documented compatibility boundaries.',
      true,
      /\brequire\s*\(/,
    ));
  }

  if (isTyped && current.commonJsExports > 0) {
    result.push(finding(
      file,
      'module-commonjs-export-in-typescript',
      'high',
      'Typed module exports through CommonJS',
      'module.exports/exports assignments bypass the TypeScript ESM export contract.',
      'Use named/default ESM exports and update consumers atomically.',
      true,
      /module\.exports|exports\./,
    ));
  }

  if (hasCommonJs && hasEsm) {
    result.push(finding(
      file,
      'module-mixed-esm-commonjs',
      'high',
      'File mixes ESM and CommonJS semantics',
      'Mixed module systems can produce different behavior between Node, bundlers and test runners.',
      'Choose one explicit module system; prefer ESM for active TypeScript/tooling code.',
      true,
      /\brequire\s*\(|module\.exports|exports\./,
    ));
  }

  if (boundary === 'module' && (file.repositoryPath.endsWith('.js') || file.repositoryPath.endsWith('.mjs')) && current.commonJsRequires > 0) {
    result.push(finding(
      file,
      'module-commonjs-in-esm-package',
      'critical',
      'ESM package contains CommonJS require()',
      'Node treats .js as ESM under type=module, so require() will fail unless a compatibility bridge is created explicitly.',
      'Replace require() with ESM import semantics or isolate compatibility code in .cjs/createRequire.',
      true,
      /\brequire\s*\(/,
    ));
  }

  if (boundary === 'commonjs' && hasEsm && file.repositoryPath.endsWith('.js')) {
    result.push(finding(
      file,
      'module-esm-syntax-in-commonjs-package',
      'critical',
      'CommonJS package contains ESM syntax in a .js file',
      'The package boundary declares CommonJS but the file uses ESM import/export syntax.',
      'Migrate the package boundary to type=module or use the correct .mjs/.cjs extensions during staged migration.',
      true,
      /(?:^|\n)\s*(?:import|export)\b/,
    ));
  }

  if (current.dynamicRequires > 0) {
    result.push(finding(
      file,
      'module-dynamic-require',
      'high',
      'Module identity is selected by dynamic require()',
      'Computed require() prevents static dependency analysis and can load unexpected executable modules.',
      'Replace dynamic require with a closed allowlist mapped to explicit imports.',
      true,
      DYNAMIC_REQUIRE,
    ));
  }

  const nonLiteralImports = dynamicImportArguments(file.text).filter(argument => !literalDynamicImport(argument));
  if (nonLiteralImports.length > 0) {
    result.push(finding(
      file,
      'module-dynamic-import-unbounded',
      'high',
      'Dynamic import target is not a literal module identity',
      'Expression-derived import targets make bundle/runtime dependency boundaries difficult to review and can admit path traversal or uncontrolled chunks.',
      'Map runtime choices through a closed literal import table and reject unknown selectors.',
      true,
      DYNAMIC_IMPORT,
    ));
  }

  if (isTyped && TS_IGNORE.test(file.text)) {
    result.push(finding(
      file,
      'module-typescript-diagnostic-suppression',
      'high',
      'Typed module suppresses compiler diagnostics',
      '@ts-ignore/@ts-nocheck creates an unreviewed escape hatch from strict compiler guarantees.',
      'Model the type boundary explicitly or use a narrowly justified @ts-expect-error with a regression test.',
      true,
      /@ts-ignore|@ts-nocheck/,
    ));
  }

  if (isJs && boundary === 'module' && count(file.text, CJS_GLOBALS) > 0 && count(file.text, FILE_PROTOCOL_HACK) === 0) {
    result.push(finding(
      file,
      'module-cjs-globals-in-esm',
      'high',
      'ESM file relies on CommonJS path globals',
      '__dirname/__filename are not defined in native ESM modules.',
      'Use import.meta.url with fileURLToPath/new URL, or remove filesystem-relative module assumptions.',
      true,
      CJS_GLOBALS,
    ));
  }

  if (count(file.text, JSON_REQUIRE) > 0 && boundary === 'module') {
    result.push(finding(
      file,
      'module-json-require-in-esm',
      'medium',
      'ESM module loads JSON through require()',
      'JSON require() depends on CommonJS behavior inside an ESM package.',
      'Use an explicit JSON import supported by the runtime/toolchain, or read/parse JSON through a typed filesystem boundary.',
      false,
      JSON_REQUIRE,
    ));
  }

  if (count(file.text, REQUIRE_RESOLVE) > 0 && boundary === 'module' && count(file.text, NODE_REQUIRE_BRIDGE) === 0) {
    result.push(finding(
      file,
      'module-require-resolve-in-esm',
      'medium',
      'ESM module relies on require.resolve()',
      'require.resolve is not a native ESM primitive and can fail under a strict module boundary.',
      'Use import.meta.resolve where supported or create an explicit compatibility bridge with createRequire.',
      false,
      REQUIRE_RESOLVE,
    ));
  }
  return result;
}

export function auditModuleBoundaryModernization(
  inventory: RepositoryInventory,
): AuditSection<ModuleBoundarySummary> {
  const started = performance.now();
  const files = sourceFiles(inventory);
  const signals = files.map(signal);
  const findings = stableSortFindings(files.flatMap(file => findingsFor(inventory, file)));
  return {
    domain: 'architecture',
    title: 'TypeScript and ESM module-boundary modernization audit',
    summary: {
      files: signals,
      javascriptFiles: signals.filter(item => JS_EXTENSION.test(item.file)).length,
      typedFiles: signals.filter(item => TS_EXTENSION.test(item.file)).length,
      commonJsFiles: signals.filter(item => item.commonJsRequires + item.commonJsExports + item.dynamicRequires > 0).length,
      mixedModuleFiles: signals.filter(item => item.commonJsRequires + item.commonJsExports + item.dynamicRequires > 0 && item.esmImports + item.esmExports + item.importMetaUses > 0).length,
      findings,
    },
    findings,
    elapsedMs: Math.max(0, performance.now() - started),
  };
}
