import {
  stableSortFindings,
  type AuditSection,
  type Finding,
  type RepositoryInventory,
  type SourceFile,
} from './contracts.mts';

export interface ToolchainManifestSignal {
  readonly file: string;
  readonly packageManager: string | null;
  readonly nodeEngine: string | null;
  readonly moduleType: string | null;
  readonly hasPackageLock: boolean;
  readonly hasPnpmLock: boolean;
  readonly hasYarnLock: boolean;
  readonly hasBunLock: boolean;
}

export interface TypeScriptConfigSignal {
  readonly file: string;
  readonly strict: boolean | null;
  readonly noUncheckedIndexedAccess: boolean | null;
  readonly exactOptionalPropertyTypes: boolean | null;
  readonly allowJs: boolean | null;
  readonly checkJs: boolean | null;
  readonly module: string | null;
  readonly moduleResolution: string | null;
  readonly target: string | null;
}

export interface DotNetToolchainSignal {
  readonly file: string;
  readonly targetFrameworks: readonly string[];
  readonly nullable: string | null;
  readonly implicitUsings: string | null;
  readonly deterministic: string | null;
  readonly continuousIntegrationBuild: string | null;
  readonly centralPackageManagement: string | null;
}

export interface RepositoryToolchainSummary {
  readonly packageManifests: readonly ToolchainManifestSignal[];
  readonly tsconfigs: readonly TypeScriptConfigSignal[];
  readonly dotnetSignals: readonly DotNetToolchainSignal[];
  readonly workflowNodeVersions: readonly string[];
  readonly workflowDotnetVersions: readonly string[];
  readonly findings: readonly Finding[];
}

type JsonObject = Record<string, unknown>;

const PACKAGE_JSON = /(?:^|\/)package\.json$/i;
const TS_CONFIG = /(?:^|\/)tsconfig(?:\.[^/]+)?\.json$/i;
const CSPROJ_OR_PROPS = /(?:\.csproj|Directory\.Build\.props|Directory\.Packages\.props)$/i;
const WORKFLOW = /^\.github\/workflows\/[^/]+\.ya?ml$/i;
const PACKAGE_LOCK = /(?:^|\/)package-lock\.json$/i;
const PNPM_LOCK = /(?:^|\/)pnpm-lock\.ya?ml$/i;
const YARN_LOCK = /(?:^|\/)yarn\.lock$/i;
const BUN_LOCK = /(?:^|\/)bun\.lockb?$/i;
const NODE_SETUP = /uses\s*:\s*actions\/setup-node@[^\n]+[\s\S]{0,500}?node-version\s*:\s*['"]?([^'"\s#]+)/gi;
const DOTNET_SETUP = /uses\s*:\s*actions\/setup-dotnet@[^\n]+[\s\S]{0,500}?dotnet-version\s*:\s*['"]?([^'"\s#]+)/gi;

function parseObject(file: SourceFile): JsonObject | null {
  try {
    const value = JSON.parse(file.text) as unknown;
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? value as JsonObject
      : null;
  } catch {
    return null;
  }
}

function nestedObject(parent: JsonObject | null, key: string): JsonObject | null {
  if (!parent) return null;
  const value = parent[key];
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as JsonObject
    : null;
}

function stringValue(parent: JsonObject | null, key: string): string | null {
  if (!parent) return null;
  const value = parent[key];
  return typeof value === 'string' ? value : null;
}

function booleanValue(parent: JsonObject | null, key: string): boolean | null {
  if (!parent) return null;
  const value = parent[key];
  return typeof value === 'boolean' ? value : null;
}

function directoryOf(path: string): string {
  const index = path.lastIndexOf('/');
  return index < 0 ? '' : path.slice(0, index);
}

function childPath(directory: string, name: string): string {
  return directory ? `${directory}/${name}` : name;
}

function hasPath(inventory: RepositoryInventory, path: string): boolean {
  return inventory.files.some(file => file.repositoryPath === path);
}

function lineOf(text: string, pattern: RegExp): number {
  const match = text.match(pattern);
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
  blocking = false,
  pattern?: RegExp,
): Finding {
  return {
    id,
    domain: 'build',
    severity,
    ...(blocking ? { blocking: true } : {}),
    title,
    message,
    location: { file: file.repositoryPath, line: pattern ? lineOf(file.text, pattern) : 1 },
    remediation,
    tags: ['modernization', 'toolchain', 'typescript', 'node', 'dotnet'],
  };
}

function packageSignal(inventory: RepositoryInventory, file: SourceFile): ToolchainManifestSignal {
  const object = parseObject(file);
  const engines = nestedObject(object, 'engines');
  const directory = directoryOf(file.repositoryPath);
  return {
    file: file.repositoryPath,
    packageManager: stringValue(object, 'packageManager'),
    nodeEngine: stringValue(engines, 'node'),
    moduleType: stringValue(object, 'type'),
    hasPackageLock: hasPath(inventory, childPath(directory, 'package-lock.json')),
    hasPnpmLock: hasPath(inventory, childPath(directory, 'pnpm-lock.yaml')) || hasPath(inventory, childPath(directory, 'pnpm-lock.yml')),
    hasYarnLock: hasPath(inventory, childPath(directory, 'yarn.lock')),
    hasBunLock: hasPath(inventory, childPath(directory, 'bun.lock')) || hasPath(inventory, childPath(directory, 'bun.lockb')),
  };
}

function packageFindings(inventory: RepositoryInventory, file: SourceFile): Finding[] {
  const object = parseObject(file);
  if (!object) {
    return [finding(
      file,
      'toolchain-package-json-invalid',
      'critical',
      'Package manifest is not valid JSON',
      'A malformed package manifest makes runtime, dependency and build-tool policy impossible to prove.',
      'Repair the manifest and keep package metadata machine-parseable.',
      true,
    )];
  }

  const result: Finding[] = [];
  const signal = packageSignal(inventory, file);
  const lockCount = [signal.hasPackageLock, signal.hasPnpmLock, signal.hasYarnLock, signal.hasBunLock].filter(Boolean).length;
  const packageManager = signal.packageManager?.toLowerCase() ?? '';
  const nodeEngine = signal.nodeEngine ?? '';

  if (!signal.packageManager) {
    result.push(finding(
      file,
      'toolchain-package-manager-unpinned',
      'medium',
      'Package manager is not pinned',
      'packageManager is missing, so local and CI installs can silently use incompatible package-manager releases.',
      'Set packageManager to an exact stable manager version and keep the matching lockfile committed.',
    ));
  } else if (!/^(?:npm|pnpm|yarn|bun)@\d+\.\d+\.\d+(?:\+sha\.[0-9a-f]+)?$/i.test(signal.packageManager)) {
    result.push(finding(
      file,
      'toolchain-package-manager-version-not-exact',
      'high',
      'Package manager version is not exact',
      `packageManager '${signal.packageManager}' is not an exact stable semantic version.`,
      'Pin the package manager to an exact stable version so CI and developer installs are reproducible.',
      false,
      /"packageManager"/,
    ));
  }

  if (!nodeEngine) {
    result.push(finding(
      file,
      'toolchain-node-engine-missing',
      'medium',
      'Node runtime contract is missing',
      'The package manifest does not state which Node runtime line is supported.',
      'Declare an engines.node range aligned with the repository CI runtime.',
    ));
  } else if (/\b(?:1[0-9]|2[0-1])\b/.test(nodeEngine)) {
    result.push(finding(
      file,
      'toolchain-node-engine-legacy',
      'high',
      'Package manifest permits a legacy Node runtime',
      `engines.node '${nodeEngine}' permits a runtime below the repository modern Node baseline.`,
      'Raise the Node engine floor to the currently supported stable/LTS line used by CI.',
      false,
      /"node"/,
    ));
  }

  if (lockCount === 0) {
    result.push(finding(
      file,
      'toolchain-lockfile-missing',
      'high',
      'Package root has no lockfile',
      'A package manifest without a lockfile cannot provide reproducible dependency resolution.',
      'Commit the package-manager lockfile and use frozen/locked installs in CI.',
      true,
    ));
  }
  if (lockCount > 1) {
    result.push(finding(
      file,
      'toolchain-lockfile-multiple',
      'high',
      'Package root has multiple package-manager lockfiles',
      'Multiple lockfile authorities make dependency resolution dependent on the developer or CI command used.',
      'Keep exactly one lockfile authority for each package root.',
      true,
    ));
  }

  if (packageManager.startsWith('npm@') && !signal.hasPackageLock) {
    result.push(finding(file, 'toolchain-npm-lock-mismatch', 'high', 'npm package root lacks package-lock.json', 'The declared npm authority does not have its canonical lockfile.', 'Commit package-lock.json and use npm ci in validation/release workflows.', true));
  }
  if (packageManager.startsWith('pnpm@') && !signal.hasPnpmLock) {
    result.push(finding(file, 'toolchain-pnpm-lock-mismatch', 'high', 'pnpm package root lacks pnpm-lock.yaml', 'The declared pnpm authority does not have its canonical lockfile.', 'Commit pnpm-lock.yaml and use --frozen-lockfile in CI.', true));
  }
  if (packageManager.startsWith('yarn@') && !signal.hasYarnLock) {
    result.push(finding(file, 'toolchain-yarn-lock-mismatch', 'high', 'Yarn package root lacks yarn.lock', 'The declared Yarn authority does not have its canonical lockfile.', 'Commit yarn.lock and use immutable/frozen installs in CI.', true));
  }
  if (packageManager.startsWith('bun@') && !signal.hasBunLock) {
    result.push(finding(file, 'toolchain-bun-lock-mismatch', 'high', 'Bun package root lacks bun.lock', 'The declared Bun authority does not have its canonical lockfile.', 'Commit the Bun lockfile and use frozen installs in CI.', true));
  }

  const sourceLike = inventory.files.some(candidate =>
    candidate.repositoryPath.startsWith(`${directory ? `${directory}/` : ''}src/`)
    && (candidate.kind === 'typescript' || candidate.kind === 'javascript'));
  if (sourceLike && signal.moduleType !== 'module') {
    result.push(finding(
      file,
      'toolchain-esm-package-boundary-missing',
      'medium',
      'Modern source package is not an explicit ESM boundary',
      'A source-bearing Node package without type=module can fall back to ambiguous CommonJS semantics for tooling files.',
      'Use an explicit ESM package boundary, or isolate intentional CommonJS files with .cjs and document the exception.',
    ));
  }
  return result;
}

function tsConfigSignal(file: SourceFile): TypeScriptConfigSignal {
  const object = parseObject(file);
  const compilerOptions = nestedObject(object, 'compilerOptions');
  return {
    file: file.repositoryPath,
    strict: booleanValue(compilerOptions, 'strict'),
    noUncheckedIndexedAccess: booleanValue(compilerOptions, 'noUncheckedIndexedAccess'),
    exactOptionalPropertyTypes: booleanValue(compilerOptions, 'exactOptionalPropertyTypes'),
    allowJs: booleanValue(compilerOptions, 'allowJs'),
    checkJs: booleanValue(compilerOptions, 'checkJs'),
    module: stringValue(compilerOptions, 'module'),
    moduleResolution: stringValue(compilerOptions, 'moduleResolution'),
    target: stringValue(compilerOptions, 'target'),
  };
}

function tsConfigFindings(file: SourceFile): Finding[] {
  const object = parseObject(file);
  if (!object) {
    return [finding(file, 'toolchain-tsconfig-invalid', 'critical', 'TypeScript configuration is not valid JSON', 'The compiler policy cannot be evaluated because tsconfig JSON is malformed.', 'Repair tsconfig and keep compiler policy explicit.', true)];
  }
  const signal = tsConfigSignal(file);
  const result: Finding[] = [];
  if (signal.strict !== true) result.push(finding(file, 'toolchain-typescript-strict-disabled', 'high', 'TypeScript strict mode is not enabled', 'A typed root without strict=true permits unsound nullability and inference behavior.', 'Enable strict=true and migrate diagnostics without suppressing them.', true, /"strict"/));
  if (signal.noUncheckedIndexedAccess !== true) result.push(finding(file, 'toolchain-typescript-indexed-access-loose', 'medium', 'Unchecked indexed access is not enabled', 'Indexed access can be treated as always present even when arrays or maps are sparse.', 'Enable noUncheckedIndexedAccess and handle absent values explicitly.', false, /"noUncheckedIndexedAccess"/));
  if (signal.exactOptionalPropertyTypes !== true) result.push(finding(file, 'toolchain-typescript-optional-properties-loose', 'medium', 'Exact optional property types are not enabled', 'Optional properties can silently conflate absence with explicit undefined.', 'Enable exactOptionalPropertyTypes and omit optional keys instead of assigning undefined.', false, /"exactOptionalPropertyTypes"/));
  if (signal.allowJs === true && signal.checkJs !== true) result.push(finding(file, 'toolchain-typescript-unchecked-js-bridge', 'high', 'JavaScript is admitted without checkJs', 'allowJs=true with checkJs disabled introduces an untyped escape hatch inside the TypeScript build graph.', 'Migrate active JavaScript to TypeScript/ESM or enable checkJs during the staged migration.', true, /"allowJs"/));

  const moduleValue = signal.module?.toLowerCase() ?? '';
  const resolution = signal.moduleResolution?.toLowerCase() ?? '';
  if (moduleValue && !/^(?:esnext|nodenext|node16|preserve)$/.test(moduleValue)) result.push(finding(file, 'toolchain-typescript-module-legacy', 'medium', 'TypeScript module target is legacy', `module=${signal.module} does not preserve a modern ESM/module-aware build boundary.`, 'Use ESNext/NodeNext/Node16/Preserve according to the actual runtime/bundler contract.'));
  if (resolution && !/^(?:bundler|nodenext|node16)$/.test(resolution)) result.push(finding(file, 'toolchain-typescript-resolution-legacy', 'medium', 'TypeScript module resolution is legacy', `moduleResolution=${signal.moduleResolution} can diverge from modern package exports/import maps.`, 'Use bundler, NodeNext or Node16 resolution to match the execution environment.'));
  return result;
}

function xmlValue(text: string, name: string): string | null {
  return text.match(new RegExp(`<${name}>([^<]+)</${name}>`, 'i'))?.[1]?.trim() ?? null;
}

function allXmlValues(text: string, name: string): string[] {
  const result: string[] = [];
  const matcher = new RegExp(`<${name}>([^<]+)</${name}>`, 'gi');
  let match: RegExpExecArray | null;
  while ((match = matcher.exec(text)) !== null) {
    const value = match[1]?.trim();
    if (value) result.push(value);
  }
  return result;
}

function dotnetSignal(file: SourceFile): DotNetToolchainSignal {
  const frameworks = [...allXmlValues(file.text, 'TargetFramework'), ...allXmlValues(file.text, 'TargetFrameworks').flatMap(value => value.split(';').map(item => item.trim()).filter(Boolean))];
  return {
    file: file.repositoryPath,
    targetFrameworks: [...new Set(frameworks)],
    nullable: xmlValue(file.text, 'Nullable'),
    implicitUsings: xmlValue(file.text, 'ImplicitUsings'),
    deterministic: xmlValue(file.text, 'Deterministic'),
    continuousIntegrationBuild: xmlValue(file.text, 'ContinuousIntegrationBuild'),
    centralPackageManagement: xmlValue(file.text, 'ManagePackageVersionsCentrally'),
  };
}

function dotnetFindings(file: SourceFile): Finding[] {
  const signal = dotnetSignal(file);
  const result: Finding[] = [];
  for (const framework of signal.targetFrameworks) {
    const major = Number(framework.match(/^net(\d+)/i)?.[1] ?? '0');
    if (major > 0 && major < 8) result.push(finding(file, 'toolchain-dotnet-target-legacy', 'high', 'Project targets a legacy .NET runtime', `Target framework ${framework} is below the modern supported server baseline.`, 'Move the project through a staged upgrade to the repository stable .NET line and validate compatibility.', true, /<TargetFramework/));
    if (/preview|rc|alpha|beta/i.test(framework)) result.push(finding(file, 'toolchain-dotnet-target-prerelease', 'high', 'Project targets a prerelease .NET runtime', `Target framework ${framework} is prerelease for a production path.`, 'Use a stable supported target framework unless an explicit migration experiment documents rollback.', true, /<TargetFramework/));
  }
  if (file.repositoryPath.endsWith('Directory.Build.props')) {
    if ((signal.nullable ?? '').toLowerCase() !== 'enable') result.push(finding(file, 'toolchain-dotnet-nullable-disabled', 'high', 'Repository nullable analysis is not enabled', 'Nullable reference analysis is a core compile-time contract for modern C#.', 'Set Nullable=enable centrally and fix warnings rather than suppressing them.', true, /<Nullable>/));
    if (!/^(?:enable|true)$/i.test(signal.implicitUsings ?? '')) result.push(finding(file, 'toolchain-dotnet-implicit-usings-disabled', 'low', 'Implicit usings are not enabled centrally', 'Modern SDK projects can reduce repetitive boilerplate with central implicit usings.', 'Enable ImplicitUsings where project compatibility permits it.'));
  }
  if (file.repositoryPath.endsWith('Directory.Packages.props') && !/true/i.test(signal.centralPackageManagement ?? '')) result.push(finding(file, 'toolchain-dotnet-central-packages-disabled', 'high', 'Central package management is not explicitly enabled', 'Package version ownership can drift across projects when central management is not authoritative.', 'Enable ManagePackageVersionsCentrally=true and keep versions in Directory.Packages.props.', true));
  return result;
}

function versions(text: string, pattern: RegExp): string[] {
  const result: string[] = [];
  const matcher = new RegExp(pattern.source, pattern.flags);
  let match: RegExpExecArray | null;
  while ((match = matcher.exec(text)) !== null) {
    const value = match[1]?.trim();
    if (value) result.push(value);
  }
  return result;
}

function workflowFindings(file: SourceFile): Finding[] {
  const result: Finding[] = [];
  for (const value of versions(file.text, NODE_SETUP)) {
    if (/^(?:1[0-9]|2[0-1])(?:\.|$)/.test(value)) result.push(finding(file, 'toolchain-ci-node-legacy', 'high', 'Workflow provisions a legacy Node runtime', `setup-node provisions ${value}, below the repository modern runtime baseline.`, 'Use the repository stable Node line consistently across validation and release workflows.', true, /node-version/));
    if (/[*x]|latest|current|nightly|canary|rc|beta|alpha|preview/i.test(value)) result.push(finding(file, 'toolchain-ci-node-floating', 'high', 'Workflow Node runtime is floating or prerelease', `node-version '${value}' can change without a reviewed repository diff.`, 'Pin a stable Node major/minor contract and update intentionally.', true, /node-version/));
  }
  for (const value of versions(file.text, DOTNET_SETUP)) {
    if (/[*x]|latest|preview|rc|beta|alpha/i.test(value)) result.push(finding(file, 'toolchain-ci-dotnet-floating', 'high', 'Workflow .NET SDK is floating or prerelease', `dotnet-version '${value}' can change or select prerelease tooling without a reviewed diff.`, 'Pin the stable SDK line required by the repository target framework.', true, /dotnet-version/));
  }
  return result;
}

export function auditRepositoryToolchainModernization(
  inventory: RepositoryInventory,
): AuditSection<RepositoryToolchainSummary> {
  const started = performance.now();
  const packageFiles = inventory.files.filter(file => PACKAGE_JSON.test(file.repositoryPath));
  const tsconfigs = inventory.files.filter(file => TS_CONFIG.test(file.repositoryPath));
  const dotnetFiles = inventory.files.filter(file => CSPROJ_OR_PROPS.test(file.repositoryPath));
  const workflows = inventory.files.filter(file => WORKFLOW.test(file.repositoryPath));
  const findings = stableSortFindings([
    ...packageFiles.flatMap(file => packageFindings(inventory, file)),
    ...tsconfigs.flatMap(tsConfigFindings),
    ...dotnetFiles.flatMap(dotnetFindings),
    ...workflows.flatMap(workflowFindings),
  ]);
  return {
    domain: 'build',
    title: 'Repository toolchain modernization audit',
    summary: {
      packageManifests: packageFiles.map(file => packageSignal(inventory, file)),
      tsconfigs: tsconfigs.map(tsConfigSignal),
      dotnetSignals: dotnetFiles.map(dotnetSignal),
      workflowNodeVersions: workflows.flatMap(file => versions(file.text, NODE_SETUP)),
      workflowDotnetVersions: workflows.flatMap(file => versions(file.text, DOTNET_SETUP)),
      findings,
    },
    findings,
    elapsedMs: Math.max(0, performance.now() - started),
  };
}
