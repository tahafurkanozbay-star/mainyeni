import {
  dedupeFindings,
  isRecord,
  safeJsonParse,
  stableSortFindings,
  type AuditDomain,
  type AuditSection,
  type Finding,
  type RepositoryInventory,
  type SourceFile,
} from './contracts.mts';
import { auditArtifactDownloadProvenance } from './artifact-download-provenance-audit.mts';
import {
  auditRuntimeSource,
  type RuntimeFinding,
  type RuntimeManifest,
} from './browser-runtime-governance.mts';
import { auditNodeExecutionBoundaries } from './node-execution-boundary-audit.mts';
import {
  auditPackageLockProvenance,
  type PackageLockProvenanceSummary,
} from './package-lock-provenance-audit.mts';
import { auditPackageScriptBoundaries } from './package-script-boundary-audit.mts';
import { auditPageUsabilityGovernance } from './page-usability-governance-audit.mts';
import { auditToolchainModernization } from './toolchain-modernization-audit.mts';
import { auditToolingLanguageModernization } from './tooling-language-modernization-audit.mts';
import { auditWorkflowCacheProvenance } from './workflow-cache-provenance-audit.mts';

export interface BrowserRuntimePackageSignal {
  readonly manifest: string;
  readonly root: string;
  readonly sourceFiles: number;
  readonly dependencies: number;
  readonly devDependencies: number;
}

export interface BrowserRuntimeGovernanceSummary {
  readonly packages: readonly BrowserRuntimePackageSignal[];
  readonly sourceFiles: number;
  readonly packageCount: number;
  readonly findings: readonly Finding[];
}

export interface ModernizationPlatformComponentSummary {
  readonly id: string;
  readonly title: string;
  readonly domain: AuditDomain;
  readonly findings: number;
  readonly blockingFindings: number;
  readonly elapsedMs: number;
}

export interface ModernizationPlatformSummary {
  readonly components: readonly ModernizationPlatformComponentSummary[];
  readonly componentCount: number;
  readonly findingCount: number;
  readonly blockingFindingCount: number;
  readonly browserRuntimeFiles: number;
  readonly packageLockFiles: number;
  readonly findings: readonly Finding[];
}

interface PackageRuntimeContext {
  readonly manifestPath: string;
  readonly root: string;
  readonly manifest: RuntimeManifest;
}

const PACKAGE_JSON = /(^|\/)package\.json$/i;
const RUNTIME_SOURCE = /\.(?:ts|tsx|js|jsx)$/i;
const TEST_SOURCE = /(?:^|\/)(?:__tests__|fixtures?|snapshots?)(?:\/|$)|(?:\.test|\.spec)\.(?:ts|tsx|js|jsx)$/i;
const GENERATED = /(?:^|\/)(?:node_modules|dist|build|coverage|generated|qa-artifacts)(?:\/|$)/i;

function stringRecord(value: unknown): Readonly<Record<string, string>> {
  if (!isRecord(value)) return Object.freeze({});
  return Object.freeze(Object.fromEntries(
    Object.entries(value)
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
      .sort(([left], [right]) => left.localeCompare(right, 'en')),
  ));
}

function packageRoot(path: string): string {
  const marker = '/package.json';
  return path.endsWith(marker) ? path.slice(0, -marker.length) : '';
}

function packageContexts(inventory: RepositoryInventory): readonly PackageRuntimeContext[] {
  const contexts: PackageRuntimeContext[] = [];
  for (const file of inventory.files) {
    if (!PACKAGE_JSON.test(file.repositoryPath) || GENERATED.test(file.repositoryPath)) continue;
    const parsed = safeJsonParse<Record<string, unknown>>(file.text);
    if (!parsed.ok || !parsed.value) continue;
    const root = packageRoot(file.repositoryPath);
    if (!root) continue;
    const sourcePrefix = `${root}/src/`;
    if (!inventory.files.some(candidate => candidate.repositoryPath.startsWith(sourcePrefix))) continue;
    contexts.push({
      manifestPath: file.repositoryPath,
      root,
      manifest: Object.freeze({
        dependencies: stringRecord(parsed.value.dependencies),
        devDependencies: stringRecord(parsed.value.devDependencies),
      }),
    });
  }
  return Object.freeze(contexts.sort((left, right) => left.root.localeCompare(right.root, 'en')));
}

function runtimeSources(inventory: RepositoryInventory, context: PackageRuntimeContext): readonly SourceFile[] {
  const prefix = `${context.root}/src/`;
  return Object.freeze(inventory.files
    .filter(file => file.repositoryPath.startsWith(prefix))
    .filter(file => RUNTIME_SOURCE.test(file.repositoryPath))
    .filter(file => !TEST_SOURCE.test(file.repositoryPath))
    .filter(file => !GENERATED.test(file.repositoryPath))
    .sort((left, right) => left.repositoryPath.localeCompare(right.repositoryPath, 'en')));
}

function runtimeSeverity(code: RuntimeFinding['code']): Finding['severity'] {
  switch (code) {
    case 'browser-remote-executable-import':
    case 'browser-dynamic-code':
      return 'critical';
    case 'browser-node-builtin':
    case 'browser-undeclared-dependency':
      return 'high';
    case 'browser-dev-dependency':
    case 'browser-commonjs':
      return 'medium';
    case 'browser-process-env':
      return 'low';
  }
}

function runtimeDomain(code: RuntimeFinding['code']): AuditDomain {
  switch (code) {
    case 'browser-dev-dependency':
    case 'browser-undeclared-dependency':
      return 'dependencies';
    case 'browser-commonjs':
    case 'browser-process-env':
      return 'architecture';
    default:
      return 'security';
  }
}

function runtimeTitle(code: RuntimeFinding['code']): string {
  switch (code) {
    case 'browser-node-builtin': return 'Browser runtime imports a Node-only builtin';
    case 'browser-remote-executable-import': return 'Browser runtime imports executable code from a remote URL';
    case 'browser-dynamic-code': return 'Browser runtime constructs executable code dynamically';
    case 'browser-commonjs': return 'Browser runtime retains a CommonJS execution contract';
    case 'browser-process-env': return 'Browser runtime reads process.env directly';
    case 'browser-dev-dependency': return 'Browser runtime imports a development-only dependency';
    case 'browser-undeclared-dependency': return 'Browser runtime imports an undeclared package';
  }
}

function runtimeRemediation(code: RuntimeFinding['code']): string {
  switch (code) {
    case 'browser-node-builtin':
      return 'Move the capability behind a same-origin backend/BFF boundary or use a browser-native API with an explicit typed adapter.';
    case 'browser-remote-executable-import':
      return 'Bundle reviewed executable dependencies through the lockfile; never execute mutable remote modules in the browser.';
    case 'browser-dynamic-code':
      return 'Replace eval/new Function with typed dispatch, parsers, or declarative data structures.';
    case 'browser-commonjs':
      return 'Migrate the module to native ESM import/export and keep compatibility adapters outside browser runtime source.';
    case 'browser-process-env':
      return 'Expose only reviewed build-time public configuration through the application configuration boundary.';
    case 'browser-dev-dependency':
      return 'Move the runtime package to dependencies or remove the runtime import; devDependencies must not provide production code.';
    case 'browser-undeclared-dependency':
      return 'Declare the dependency in the owning package manifest and lockfile, or remove the import.';
  }
}

function runtimeFinding(value: RuntimeFinding): Finding {
  const severity = runtimeSeverity(value.code);
  const blocking = severity === 'critical' || severity === 'high';
  return {
    id: `modernization-${value.code}`,
    domain: runtimeDomain(value.code),
    severity,
    ...(blocking ? { blocking: true } : {}),
    title: runtimeTitle(value.code),
    message: `${value.file} crosses the modern browser-runtime boundary: ${value.detail}.`,
    location: { file: value.file, line: value.line },
    evidence: { value: value.detail },
    remediation: runtimeRemediation(value.code),
    tags: ['modernization', 'browser-runtime', 'typescript', 'esm'],
  };
}

export function auditBrowserRuntimeGovernance(
  inventory: RepositoryInventory,
): AuditSection<BrowserRuntimeGovernanceSummary> {
  const started = performance.now();
  const contexts = packageContexts(inventory);
  const findings: Finding[] = [];
  const packages: BrowserRuntimePackageSignal[] = [];
  let sourceFiles = 0;

  for (const context of contexts) {
    const sources = runtimeSources(inventory, context);
    sourceFiles += sources.length;
    packages.push({
      manifest: context.manifestPath,
      root: context.root,
      sourceFiles: sources.length,
      dependencies: Object.keys(context.manifest.dependencies).length,
      devDependencies: Object.keys(context.manifest.devDependencies).length,
    });
    for (const source of sources) {
      findings.push(...auditRuntimeSource(source.repositoryPath, source.text, context.manifest).map(runtimeFinding));
    }
  }

  const ordered = stableSortFindings(dedupeFindings(findings));
  return {
    domain: 'architecture',
    title: 'Browser runtime TypeScript/ESM and dependency boundary audit',
    summary: {
      packages: Object.freeze(packages),
      sourceFiles,
      packageCount: packages.length,
      findings: ordered,
    },
    findings: ordered,
    elapsedMs: Math.max(0, performance.now() - started),
  };
}

function packageLockSection(inventory: RepositoryInventory): AuditSection<PackageLockProvenanceSummary> {
  const started = performance.now();
  const summary = auditPackageLockProvenance(inventory);
  return {
    domain: 'dependencies',
    title: 'Package-lock immutable dependency provenance audit',
    summary,
    findings: summary.findings,
    elapsedMs: Math.max(0, performance.now() - started),
  };
}

function component(id: string, section: AuditSection<unknown>): ModernizationPlatformComponentSummary {
  return {
    id,
    title: section.title,
    domain: section.domain,
    findings: section.findings.length,
    blockingFindings: section.findings.filter(item => item.blocking === true).length,
    elapsedMs: section.elapsedMs,
  };
}

export function auditModernizationPlatform(
  inventory: RepositoryInventory,
): AuditSection<ModernizationPlatformSummary> {
  const started = performance.now();
  const toolchain = auditToolchainModernization(inventory);
  const toolingLanguage = auditToolingLanguageModernization(inventory);
  const nodeExecution = auditNodeExecutionBoundaries(inventory);
  const packageScripts = auditPackageScriptBoundaries(inventory);
  const packageLock = packageLockSection(inventory);
  const artifactDownloads = auditArtifactDownloadProvenance(inventory);
  const cacheProvenance = auditWorkflowCacheProvenance(inventory);
  const browserRuntime = auditBrowserRuntimeGovernance(inventory);
  const pageUsability = auditPageUsabilityGovernance(inventory);

  const sections: readonly [string, AuditSection<unknown>][] = [
    ['toolchain', toolchain],
    ['tooling-language', toolingLanguage],
    ['node-execution', nodeExecution],
    ['package-scripts', packageScripts],
    ['package-lock', packageLock],
    ['artifact-downloads', artifactDownloads],
    ['cache-provenance', cacheProvenance],
    ['browser-runtime', browserRuntime],
    ['page-usability', pageUsability],
  ];
  const findings = stableSortFindings(dedupeFindings(sections.flatMap(([, section]) => section.findings)));
  const components = sections.map(([id, section]) => component(id, section));

  return {
    domain: 'architecture',
    title: 'Modern platform, typed runtime and whole-page usability governance',
    summary: {
      components: Object.freeze(components),
      componentCount: components.length,
      findingCount: findings.length,
      blockingFindingCount: findings.filter(item => item.blocking === true).length,
      browserRuntimeFiles: browserRuntime.summary.sourceFiles,
      packageLockFiles: packageLock.summary.lockfileCount,
      findings,
    },
    findings,
    elapsedMs: Math.max(0, performance.now() - started),
  };
}
