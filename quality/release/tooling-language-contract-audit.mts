import {
  safeJsonParse,
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
  readonly test: boolean;
  readonly releaseAuthority: boolean;
  readonly commonJs: boolean;
  readonly suppression: boolean;
  readonly deprecatedNodeApi: boolean;
  readonly extensionlessRelativeImports: number;
}

export interface ToolingManifestContract {
  readonly path: string | null;
  readonly moduleType: string | null;
  readonly nodeEngine: string | null;
  readonly npmEngine: string | null;
  readonly verifyScript: string | null;
  readonly toolingTestScript: string | null;
  readonly typecheckScript: string | null;
}

export interface ToolingLanguageContractSummary {
  readonly files: readonly ToolingLanguageSignal[];
  readonly inspectedFiles: number;
  readonly typedFiles: number;
  readonly legacyFiles: number;
  readonly typedRatio: number;
  readonly releaseAuthorityFiles: number;
  readonly typedReleaseAuthorityFiles: number;
  readonly typedReleaseAuthorityRatio: number;
  readonly commonJsFiles: readonly string[];
  readonly suppressionFiles: readonly string[];
  readonly deprecatedNodeApiFiles: readonly string[];
  readonly extensionlessImportFiles: readonly string[];
  readonly manifest: ToolingManifestContract;
  readonly findings: readonly Finding[];
}

const TOOLING_PATH = /^(?:Webclient\.app\/scripts|tools)\/.*\.(?:[cm]?[jt]s|[cm]?[jt]sx)$/i;
const GENERATED_OR_VENDOR = /(?:^|\/)(?:node_modules|dist|build|coverage|vendor|generated|qa-artifacts)(?:\/|$)/i;
const TEST_FILE = /(?:^|\/).*\.(?:test|spec)\.(?:[cm]?[jt]s|[cm]?[jt]sx)$/i;
const TYPED_EXTENSION = /\.(?:ts|tsx|mts|cts)$/i;
const LEGACY_EXTENSION = /\.(?:js|jsx|mjs|cjs)$/i;
const COMMON_JS = /\brequire\s*\(|\bmodule\.exports\b|\bexports\.[A-Za-z_$][\w$]*\s*=/;
const TYPE_SUPPRESSION = /^\s*\/\/\s*@ts-(?:nocheck|ignore)\b/m;
const RELEASE_AUTHORITY = /(?:^|[-_.\/])(?:release|workflow|security|integrity|governance|quality|audit|verify|dependency|artifact|build)(?:[-_.\/]|$)/i;
const DEPRECATED_NODE_API = /\b(?:new\s+Buffer\s*\(|fs\.exists\s*\(|util\.isArray\s*\(|url\.parse\s*\(|punycode\.)/;
const RELATIVE_IMPORT = /(?:\bfrom\s*|\bimport\s*\(|\brequire\s*\()\s*['"](\.{1,2}\/[^'"]+)['"]/g;
const EXPLICIT_NODE_EXTENSION = /\.(?:js|mjs|cjs|ts|mts|cts|json|node)$/i;
const PACKAGE_PATH = 'Webclient.app/package.json';
const REQUIRED_VERIFY_STAGES = [
  'dependency:verify',
  'lint:strict',
  'typecheck',
  'test:ci',
  'test:tooling',
  'build',
  'build:verify',
] as const;

function eligible(file: SourceFile): boolean {
  return TOOLING_PATH.test(file.repositoryPath) && !GENERATED_OR_VENDOR.test(file.repositoryPath);
}

function typed(file: SourceFile): boolean {
  return TYPED_EXTENSION.test(file.repositoryPath);
}

function releaseAuthority(file: SourceFile): boolean {
  return RELEASE_AUTHORITY.test(file.repositoryPath);
}

function extensionlessRelativeImports(text: string): number {
  let total = 0;
  const matcher = new RegExp(RELATIVE_IMPORT.source, RELATIVE_IMPORT.flags);
  let match: RegExpExecArray | null;
  while ((match = matcher.exec(text)) !== null) {
    const specifier = match[1] ?? '';
    const clean = specifier.split(/[?#]/, 1)[0] ?? specifier;
    if (!EXPLICIT_NODE_EXTENSION.test(clean) && !clean.endsWith('/')) total += 1;
  }
  return total;
}

function signal(file: SourceFile): ToolingLanguageSignal {
  return {
    file: file.repositoryPath,
    extension: file.extension.toLowerCase(),
    typed: typed(file),
    test: TEST_FILE.test(file.repositoryPath),
    releaseAuthority: releaseAuthority(file),
    commonJs: COMMON_JS.test(file.text) || /\.cjs$/i.test(file.repositoryPath),
    suppression: TYPE_SUPPRESSION.test(file.text),
    deprecatedNodeApi: DEPRECATED_NODE_API.test(file.text),
    extensionlessRelativeImports: extensionlessRelativeImports(file.text),
  };
}

function manifestContract(inventory: RepositoryInventory): ToolingManifestContract {
  const file = inventory.files.find(item => item.repositoryPath === PACKAGE_PATH);
  if (!file) {
    return {
      path: null,
      moduleType: null,
      nodeEngine: null,
      npmEngine: null,
      verifyScript: null,
      toolingTestScript: null,
      typecheckScript: null,
    };
  }
  const parsed = safeJsonParse<Record<string, unknown>>(file.text);
  const value = parsed.ok && parsed.value ? parsed.value : {};
  const engines = value.engines && typeof value.engines === 'object' && !Array.isArray(value.engines)
    ? value.engines as Record<string, unknown>
    : {};
  const scripts = value.scripts && typeof value.scripts === 'object' && !Array.isArray(value.scripts)
    ? value.scripts as Record<string, unknown>
    : {};
  const asString = (input: unknown): string | null => typeof input === 'string' ? input : null;
  return {
    path: file.repositoryPath,
    moduleType: asString(value.type),
    nodeEngine: asString(engines.node),
    npmEngine: asString(engines.npm),
    verifyScript: asString(scripts.verify),
    toolingTestScript: asString(scripts['test:tooling']),
    typecheckScript: asString(scripts.typecheck),
  };
}

function majorFromEngine(value: string | null): number | null {
  if (!value) return null;
  const match = value.match(/(?:^|[^0-9])(\d{1,3})(?:\.|\b)/);
  if (!match?.[1]) return null;
  const major = Number(match[1]);
  return Number.isSafeInteger(major) ? major : null;
}

function aggregateFinding(
  id: string,
  severity: Finding['severity'],
  title: string,
  message: string,
  remediation: string,
  files: readonly string[],
  domain: Finding['domain'] = 'architecture',
  blocking = false,
): Finding {
  return {
    id,
    domain,
    severity,
    ...(blocking ? { blocking: true } : {}),
    title,
    message,
    ...(files[0] ? { location: { file: files[0], line: 1 } } : {}),
    evidence: {
      value: files.length,
      metadata: {
        files: files.slice(0, 12).join(','),
      },
    },
    remediation,
    tags: ['tooling', 'language-modernization', 'typescript', 'esm'],
  };
}

function fileFindings(files: readonly ToolingLanguageSignal[]): Finding[] {
  const findings: Finding[] = [];
  const commonJs = files.filter(item => item.commonJs).map(item => item.file);
  const commonJsAuthorities = files.filter(item => item.commonJs && item.releaseAuthority).map(item => item.file);
  if (commonJsAuthorities.length > 0) {
    findings.push(aggregateFinding(
      'tooling-release-authority-commonjs',
      'high',
      'Release-critical tooling still crosses a CommonJS boundary',
      `${commonJsAuthorities.length} release/security/build authority file(s) use CommonJS semantics. Under the repository ESM contract this weakens static module analysis and can create dual-loader behavior.`,
      'Move release-critical tooling to native ESM TypeScript (.mts/.ts), keep explicit file extensions, and protect the migration with node:test coverage.',
      commonJsAuthorities,
      'architecture',
      true,
    ));
  } else if (commonJs.length > 0) {
    findings.push(aggregateFinding(
      'tooling-commonjs-debt',
      'low',
      'Tooling still contains CommonJS migration debt',
      `${commonJs.length} tooling file(s) still use CommonJS semantics.`,
      'Migrate the remaining utilities to native ESM when they are next modified; do not introduce new CommonJS modules.',
      commonJs,
    ));
  }

  const suppressions = files.filter(item => item.suppression).map(item => item.file);
  if (suppressions.length > 0) {
    findings.push(aggregateFinding(
      'tooling-type-suppression',
      'high',
      'Tooling disables TypeScript diagnostics',
      `${suppressions.length} tooling file(s) contain @ts-nocheck or @ts-ignore. Release tooling must remain reviewable under strict compiler semantics.`,
      'Remove broad suppression and model external or parsed data as unknown with explicit narrowing.',
      suppressions,
      'build',
      true,
    ));
  }

  const deprecated = files.filter(item => item.deprecatedNodeApi).map(item => item.file);
  if (deprecated.length > 0) {
    findings.push(aggregateFinding(
      'tooling-deprecated-node-api',
      'medium',
      'Tooling uses deprecated Node.js APIs',
      `${deprecated.length} tooling file(s) depend on deprecated Node.js APIs that undermine the Node 24 modernization boundary.`,
      'Replace deprecated APIs with stable Node 24 equivalents and retain deterministic tests for changed behavior.',
      deprecated,
      'build',
    ));
  }

  const extensionless = files.filter(item => item.typed && item.extensionlessRelativeImports > 0).map(item => item.file);
  if (extensionless.length > 0) {
    findings.push(aggregateFinding(
      'tooling-typed-esm-extensionless-import',
      'medium',
      'Typed Node ESM tooling has extensionless relative imports',
      `${extensionless.length} typed tooling file(s) use extensionless relative imports. Node-native ESM resolution should remain explicit and deterministic.`,
      'Use explicit .mts/.ts/.js import specifiers consistent with the Node 24 execution path and compiler configuration.',
      extensionless,
      'build',
    ));
  }

  const authorities = files.filter(item => item.releaseAuthority && !item.test);
  const typedAuthorities = authorities.filter(item => item.typed);
  if (authorities.length >= 4 && typedAuthorities.length / authorities.length < 0.35) {
    const legacy = authorities.filter(item => !item.typed).map(item => item.file);
    findings.push(aggregateFinding(
      'tooling-release-authority-typed-ratio',
      'low',
      'Release-critical tooling remains mostly untyped',
      `Only ${typedAuthorities.length}/${authorities.length} release/security/build authority files are TypeScript. The runtime is modern ESM, but static contracts do not yet cover most operational tooling.`,
      'Migrate touched release-critical utilities incrementally to strict .mts/.ts modules, starting with parsing and policy code, while keeping CLI wrappers behavior-compatible.',
      legacy,
    ));
  }
  return findings;
}

function manifestFindings(contract: ToolingManifestContract): Finding[] {
  const findings: Finding[] = [];
  const path = contract.path ?? PACKAGE_PATH;
  const base = (id: string, severity: Finding['severity'], title: string, message: string, remediation: string, blocking = false): Finding => ({
    id,
    domain: 'build',
    severity,
    ...(blocking ? { blocking: true } : {}),
    title,
    message,
    location: { file: path, line: 1 },
    remediation,
    tags: ['tooling', 'language-modernization', 'node24', 'esm'],
  });

  if (!contract.path) {
    findings.push(base(
      'tooling-package-contract-missing',
      'critical',
      'Webclient package contract is missing',
      'The primary webclient/package tooling manifest cannot be inspected, so Node/ESM/verification guarantees are unknown.',
      'Restore Webclient.app/package.json and keep the runtime/tooling contract versioned with the application.',
      true,
    ));
    return findings;
  }

  if (contract.moduleType !== 'module') {
    findings.push(base(
      'tooling-package-esm-contract-missing',
      'critical',
      'Webclient is not declared as native ESM',
      `Expected package type "module" but found ${contract.moduleType ?? 'no module type'}.`,
      'Keep "type": "module" so Vite, Node tooling and tests share one ESM execution model.',
      true,
    ));
  }

  const nodeMajor = majorFromEngine(contract.nodeEngine);
  if (nodeMajor === null || nodeMajor < 24) {
    findings.push(base(
      'tooling-node-engine-outdated',
      'high',
      'Node.js engine contract is below the repository modernization baseline',
      `Expected Node >=24 but package engines.node is ${contract.nodeEngine ?? 'missing'}.`,
      'Declare and run Node >=24 in package metadata and CI so native ESM/TypeScript tooling behavior is consistent.',
      true,
    ));
  }

  const npmMajor = majorFromEngine(contract.npmEngine);
  if (npmMajor === null || npmMajor < 11) {
    findings.push(base(
      'tooling-npm-engine-outdated',
      'medium',
      'npm engine contract is below the repository modernization baseline',
      `Expected npm >=11 but package engines.npm is ${contract.npmEngine ?? 'missing'}.`,
      'Pin npm >=11 in package metadata and CI to keep lockfile and lifecycle behavior deterministic.',
    ));
  }

  const verify = contract.verifyScript ?? '';
  const missingStages = REQUIRED_VERIFY_STAGES.filter(stage => !verify.includes(`npm run ${stage}`));
  if (missingStages.length > 0) {
    findings.push(base(
      'tooling-verify-chain-incomplete',
      'high',
      'Primary verification chain omits required stages',
      `npm verify does not visibly include: ${missingStages.join(', ')}.`,
      'Keep dependency, lint, typecheck, tests, tooling tests, production build and post-build verification in the single fail-fast verify chain.',
      true,
    ));
  }

  if (!contract.toolingTestScript || !/node\s+--test\b/.test(contract.toolingTestScript)) {
    findings.push(base(
      'tooling-node-test-contract-missing',
      'medium',
      'Tooling regression tests are not bound to node:test',
      'The test:tooling command should execute operational tooling tests under the same Node runtime used by release automation.',
      'Keep a node --test based tooling suite and add every release-critical parser/policy regression to it.',
    ));
  }

  if (!contract.typecheckScript || !/tsc\s+--noEmit\b/.test(contract.typecheckScript)) {
    findings.push(base(
      'tooling-primary-typecheck-contract-missing',
      'high',
      'Primary TypeScript verification contract is missing',
      'The package typecheck command does not visibly run tsc --noEmit, so typed migration regressions can bypass the main verification chain.',
      'Keep tsc --noEmit in the primary typecheck command and add dedicated strict projects for newly typed tooling boundaries.',
      true,
    ));
  }
  return findings;
}

export function auditToolingLanguageContracts(
  inventory: RepositoryInventory,
): AuditSection<ToolingLanguageContractSummary> {
  const started = performance.now();
  const files = inventory.files.filter(eligible).map(signal).sort((a, b) => a.file.localeCompare(b.file, 'en'));
  const typedFiles = files.filter(item => item.typed);
  const releaseAuthorities = files.filter(item => item.releaseAuthority && !item.test);
  const typedReleaseAuthorities = releaseAuthorities.filter(item => item.typed);
  const manifest = manifestContract(inventory);
  const findings = stableSortFindings([
    ...fileFindings(files),
    ...manifestFindings(manifest),
  ]);
  return {
    domain: 'build',
    title: 'Tooling language modernization contract audit',
    summary: {
      files,
      inspectedFiles: files.length,
      typedFiles: typedFiles.length,
      legacyFiles: files.filter(item => LEGACY_EXTENSION.test(item.file)).length,
      typedRatio: files.length > 0 ? typedFiles.length / files.length : 1,
      releaseAuthorityFiles: releaseAuthorities.length,
      typedReleaseAuthorityFiles: typedReleaseAuthorities.length,
      typedReleaseAuthorityRatio: releaseAuthorities.length > 0 ? typedReleaseAuthorities.length / releaseAuthorities.length : 1,
      commonJsFiles: files.filter(item => item.commonJs).map(item => item.file),
      suppressionFiles: files.filter(item => item.suppression).map(item => item.file),
      deprecatedNodeApiFiles: files.filter(item => item.deprecatedNodeApi).map(item => item.file),
      extensionlessImportFiles: files.filter(item => item.extensionlessRelativeImports > 0).map(item => item.file),
      manifest,
      findings,
    },
    findings,
    elapsedMs: Math.max(0, performance.now() - started),
  };
}
