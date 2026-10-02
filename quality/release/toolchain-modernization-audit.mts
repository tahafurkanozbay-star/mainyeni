import {
  stableSortFindings,
  type AuditSection,
  type Finding,
  type RepositoryInventory,
  type SourceFile,
} from './contracts.mts';

export interface PackageToolchainSignal {
  readonly file: string;
  readonly typeModule: boolean;
  readonly nodeEngine: string | null;
  readonly npmEngine: string | null;
  readonly packageManager: string | null;
  readonly typescript: string | null;
  readonly vite: string | null;
  readonly react: string | null;
  readonly prereleaseDependencies: readonly string[];
}

export interface TsconfigToolchainSignal {
  readonly file: string;
  readonly strict: boolean | null;
  readonly noUncheckedIndexedAccess: boolean | null;
  readonly exactOptionalPropertyTypes: boolean | null;
  readonly useUnknownInCatchVariables: boolean | null;
  readonly verbatimModuleSyntax: boolean | null;
  readonly moduleResolution: string | null;
  readonly allowJs: boolean | null;
  readonly checkJs: boolean | null;
}

export interface DotnetToolchainSignal {
  readonly file: string;
  readonly targetFrameworks: readonly string[];
  readonly preview: boolean;
}

export interface WorkflowRuntimeSignal {
  readonly file: string;
  readonly nodeVersions: readonly string[];
  readonly dotnetVersions: readonly string[];
}

export interface ToolchainModernizationSummary {
  readonly packageManifests: readonly PackageToolchainSignal[];
  readonly tsconfigs: readonly TsconfigToolchainSignal[];
  readonly dotnetProjects: readonly DotnetToolchainSignal[];
  readonly workflows: readonly WorkflowRuntimeSignal[];
  readonly node24CompatibleManifests: number;
  readonly strictTsconfigs: number;
  readonly modernDotnetProjects: number;
  readonly findings: readonly Finding[];
}

type JsonObject = Record<string, unknown>;

const GENERATED = /(^|\/)(?:node_modules|dist|build|coverage|bin|obj|qa-artifacts)(?:\/|$)/i;
const PACKAGE_JSON = /(^|\/)package\.json$/i;
const TSCONFIG = /(^|\/)tsconfig(?:\.[^/]+)?\.json$/i;
const CSPROJ = /\.csproj$/i;
const WORKFLOW = /^\.github\/workflows\/[^/]+\.ya?ml$/i;
const PREVIEW = /(?:^|[-.])(?:alpha|beta|rc|next|canary|preview|experimental)(?:[-.]|$)/i;
const SEMVER_MAJOR = /(?:^|[^0-9])(\d+)(?:\.\d+)?/;
const NODE_VERSION_FIELD = /\bnode-version\s*:\s*['"]?([^'"\s#]+)['"]?/gi;
const DOTNET_VERSION_FIELD = /\bdotnet-version\s*:\s*['"]?([^'"\s#]+)['"]?/gi;
const TARGET_FRAMEWORK = /<TargetFrameworks?>\s*([^<]+?)\s*<\/TargetFrameworks?>/gi;

function parseJson(file: SourceFile): JsonObject | null {
  try {
    const parsed: unknown = JSON.parse(file.text);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as JsonObject
      : null;
  } catch {
    return null;
  }
}

function objectValue(parent: JsonObject | null, key: string): JsonObject | null {
  const value = parent?.[key];
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : null;
}

function stringValue(parent: JsonObject | null, key: string): string | null {
  const value = parent?.[key];
  return typeof value === 'string' ? value : null;
}

function booleanValue(parent: JsonObject | null, key: string): boolean | null {
  const value = parent?.[key];
  return typeof value === 'boolean' ? value : null;
}

function dependencyVersion(manifest: JsonObject | null, name: string): string | null {
  for (const bucketName of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    const bucket = objectValue(manifest, bucketName);
    const value = bucket?.[name];
    if (typeof value === 'string') return value;
  }
  return null;
}

function major(version: string | null): number | null {
  const match = version?.match(SEMVER_MAJOR);
  const parsed = match?.[1] ? Number.parseInt(match[1], 10) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function packageSignals(inventory: RepositoryInventory): PackageToolchainSignal[] {
  const signals: PackageToolchainSignal[] = [];
  for (const file of inventory.files) {
    if (!PACKAGE_JSON.test(file.repositoryPath) || GENERATED.test(file.repositoryPath)) continue;
    const manifest = parseJson(file);
    if (!manifest) continue;
    const engines = objectValue(manifest, 'engines');
    const versions: string[] = [];
    for (const bucketName of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
      const bucket = objectValue(manifest, bucketName);
      for (const [name, value] of Object.entries(bucket ?? {})) {
        if (typeof value === 'string' && PREVIEW.test(value)) versions.push(`${name}@${value}`);
      }
    }
    signals.push({
      file: file.repositoryPath,
      typeModule: stringValue(manifest, 'type') === 'module',
      nodeEngine: stringValue(engines, 'node'),
      npmEngine: stringValue(engines, 'npm'),
      packageManager: stringValue(manifest, 'packageManager'),
      typescript: dependencyVersion(manifest, 'typescript'),
      vite: dependencyVersion(manifest, 'vite'),
      react: dependencyVersion(manifest, 'react'),
      prereleaseDependencies: Object.freeze(versions.sort()),
    });
  }
  return signals.sort((left, right) => left.file.localeCompare(right.file));
}

function tsconfigSignals(inventory: RepositoryInventory): TsconfigToolchainSignal[] {
  const signals: TsconfigToolchainSignal[] = [];
  for (const file of inventory.files) {
    if (!TSCONFIG.test(file.repositoryPath) || GENERATED.test(file.repositoryPath)) continue;
    const config = parseJson(file);
    if (!config) continue;
    const compiler = objectValue(config, 'compilerOptions');
    signals.push({
      file: file.repositoryPath,
      strict: booleanValue(compiler, 'strict'),
      noUncheckedIndexedAccess: booleanValue(compiler, 'noUncheckedIndexedAccess'),
      exactOptionalPropertyTypes: booleanValue(compiler, 'exactOptionalPropertyTypes'),
      useUnknownInCatchVariables: booleanValue(compiler, 'useUnknownInCatchVariables'),
      verbatimModuleSyntax: booleanValue(compiler, 'verbatimModuleSyntax'),
      moduleResolution: stringValue(compiler, 'moduleResolution'),
      allowJs: booleanValue(compiler, 'allowJs'),
      checkJs: booleanValue(compiler, 'checkJs'),
    });
  }
  return signals.sort((left, right) => left.file.localeCompare(right.file));
}

function dotnetSignals(inventory: RepositoryInventory): DotnetToolchainSignal[] {
  const signals: DotnetToolchainSignal[] = [];
  for (const file of inventory.files) {
    if (!CSPROJ.test(file.repositoryPath) || GENERATED.test(file.repositoryPath)) continue;
    const targets: string[] = [];
    const matcher = new RegExp(TARGET_FRAMEWORK.source, TARGET_FRAMEWORK.flags);
    let match: RegExpExecArray | null;
    while ((match = matcher.exec(file.text)) !== null) {
      for (const item of (match[1] ?? '').split(';')) {
        const normalized = item.trim();
        if (normalized) targets.push(normalized);
      }
    }
    const distinct = [...new Set(targets)].sort();
    signals.push({
      file: file.repositoryPath,
      targetFrameworks: distinct,
      preview: distinct.some(target => /preview/i.test(target)) || /<LangVersion>\s*preview\s*<\/LangVersion>/i.test(file.text),
    });
  }
  return signals.sort((left, right) => left.file.localeCompare(right.file));
}

function captureValues(text: string, expression: RegExp): string[] {
  const values: string[] = [];
  const matcher = new RegExp(expression.source, expression.flags);
  let match: RegExpExecArray | null;
  while ((match = matcher.exec(text)) !== null) {
    const value = (match[1] ?? '').trim();
    if (value) values.push(value);
  }
  return [...new Set(values)].sort();
}

function workflowSignals(inventory: RepositoryInventory): WorkflowRuntimeSignal[] {
  return inventory.files
    .filter(file => WORKFLOW.test(file.repositoryPath))
    .map(file => ({
      file: file.repositoryPath,
      nodeVersions: captureValues(file.text, NODE_VERSION_FIELD),
      dotnetVersions: captureValues(file.text, DOTNET_VERSION_FIELD),
    }))
    .sort((left, right) => left.file.localeCompare(right.file));
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
    domain: 'build',
    severity,
    ...(blocking ? { blocking: true } : {}),
    title,
    message,
    location: { file, line: 1 },
    remediation,
    tags,
  };
}

function packageFindings(signal: PackageToolchainSignal): Finding[] {
  const result: Finding[] = [];
  const nodeMajor = major(signal.nodeEngine);
  const tsMajor = major(signal.typescript);
  const viteMajor = major(signal.vite);
  const reactMajor = major(signal.react);

  if (signal.file === 'Webclient.app/package.json' && !signal.typeModule) {
    result.push(finding(
      'toolchain-webclient-esm-disabled', 'high', 'Webclient is not declared as native ESM',
      'The primary browser application should keep package type=module so Node tooling and Vite share one module model.',
      signal.file, 'Set "type": "module" and migrate remaining CommonJS-only tooling behind explicit compatibility adapters.',
      ['toolchain', 'esm', 'typescript'], true,
    ));
  }
  if (signal.file === 'Webclient.app/package.json' && (nodeMajor === null || nodeMajor < 24)) {
    result.push(finding(
      'toolchain-node-lts-floor', 'high', 'Webclient Node engine is below the production LTS modernization floor',
      `Configured node engine is ${signal.nodeEngine ?? 'missing'}; the modern build uses Node 24 LTS features and security maintenance.`,
      signal.file, 'Declare a Node >=24 engine and keep CI on an Active/Maintenance LTS release rather than an unpinned Current line.',
      ['toolchain', 'node', 'lts'], true,
    ));
  }
  if (signal.file === 'Webclient.app/package.json' && signal.packageManager === null) {
    result.push(finding(
      'toolchain-package-manager-unpinned', 'low', 'Package manager identity is not pinned in the manifest',
      'A packageManager field makes local and CI installs converge on one npm implementation while the lockfile remains authoritative.',
      signal.file, 'Add an exact packageManager value after verifying the repository lockfile with the chosen npm 11 release.',
      ['toolchain', 'npm', 'reproducibility'],
    ));
  }
  if (signal.file === 'Webclient.app/package.json' && tsMajor !== null && tsMajor < 7) {
    result.push(finding(
      'toolchain-typescript-modernization-floor', 'medium', 'Primary frontend TypeScript is below the modernization baseline',
      `Configured TypeScript version is ${signal.typescript}.`, signal.file,
      'Upgrade through a dedicated compiler migration with exact-base typecheck and regression validation.',
      ['toolchain', 'typescript'],
    ));
  }
  if (signal.file === 'Webclient.app/package.json' && viteMajor !== null && viteMajor < 8) {
    result.push(finding(
      'toolchain-vite-modernization-floor', 'medium', 'Primary frontend Vite is below the Rolldown-based modernization baseline',
      `Configured Vite version is ${signal.vite}.`, signal.file,
      'Upgrade to stable Vite 8+ only after plugin/build integrity compatibility is proven.',
      ['toolchain', 'vite', 'rolldown'],
    ));
  }
  if (signal.file === 'Webclient.app/package.json' && reactMajor !== null && reactMajor < 19) {
    result.push(finding(
      'toolchain-react-modernization-floor', 'medium', 'Primary frontend React is below the modern root/concurrent baseline',
      `Configured React version is ${signal.react}.`, signal.file,
      'Upgrade through a dedicated React 19 compatibility pass with accessibility and interaction regression coverage.',
      ['toolchain', 'react'],
    ));
  }
  for (const dependency of signal.prereleaseDependencies.slice(0, 8)) {
    result.push(finding(
      'toolchain-prerelease-dependency', 'medium', 'Prerelease dependency is present in a production manifest',
      `${dependency} uses alpha/beta/rc/next/canary/preview semantics.`, signal.file,
      'Prefer the latest stable release; retain prerelease packages only with an explicit rollback plan and measured benefit.',
      ['toolchain', 'dependency', 'stability'],
    ));
  }
  return result;
}

function tsconfigFindings(signal: TsconfigToolchainSignal): Finding[] {
  const result: Finding[] = [];
  if (signal.strict === false) {
    result.push(finding(
      'toolchain-typescript-strict-disabled', 'medium', 'TypeScript strict mode is explicitly disabled',
      'A typed project with strict=false creates a weaker contract island inside the repository.', signal.file,
      'Enable strict mode in a staged migration and fix diagnostics rather than suppressing them.', ['toolchain', 'typescript', 'strict'],
    ));
  }
  if (signal.strict === true && signal.noUncheckedIndexedAccess !== true) {
    result.push(finding(
      'toolchain-indexed-access-ratchet-missing', 'info', 'Strict project does not opt into checked indexed access',
      'noUncheckedIndexedAccess catches missing map/array keys that otherwise become runtime undefined values.', signal.file,
      'Enable noUncheckedIndexedAccess when the project slice can absorb the resulting diagnostics.', ['toolchain', 'typescript', 'strict'],
    ));
  }
  if (signal.strict === true && signal.exactOptionalPropertyTypes !== true) {
    result.push(finding(
      'toolchain-exact-optional-ratchet-missing', 'info', 'Strict project does not opt into exact optional properties',
      'exactOptionalPropertyTypes distinguishes omitted properties from explicit undefined and improves API contract precision.', signal.file,
      'Enable exactOptionalPropertyTypes in the next typed migration slice and fix explicit undefined assignments.', ['toolchain', 'typescript', 'strict'],
    ));
  }
  if (signal.allowJs === true && signal.checkJs !== true) {
    result.push(finding(
      'toolchain-unchecked-javascript-island', 'low', 'TypeScript project includes JavaScript without checking it',
      'allowJs=true with checkJs disabled can hide migration regressions at JS/TS boundaries.', signal.file,
      'Prefer migrating authored JavaScript to TypeScript; otherwise enable checkJs for the bounded compatibility island.', ['toolchain', 'typescript', 'migration'],
    ));
  }
  return result;
}

function dotnetFindings(signal: DotnetToolchainSignal): Finding[] {
  const result: Finding[] = [];
  if (signal.preview) {
    result.push(finding(
      'toolchain-dotnet-preview', 'medium', 'Project opts into a preview .NET or C# language surface',
      'Preview language/runtime features widen release risk without a stable support guarantee.', signal.file,
      'Use the latest stable target/language version unless a measured feature requires preview and a rollback path exists.', ['toolchain', 'dotnet', 'stability'],
    ));
  }
  for (const target of signal.targetFrameworks) {
    const match = target.match(/^net(\d+)\./i);
    const majorVersion = match?.[1] ? Number.parseInt(match[1], 10) : null;
    if (majorVersion !== null && majorVersion < 10) {
      result.push(finding(
        'toolchain-dotnet-modernization-floor', 'low', 'Project targets an older .NET generation',
        `${signal.file} targets ${target}.`, signal.file,
        'Migrate to the repository stable .NET baseline only after API/package compatibility and publish output are validated.', ['toolchain', 'dotnet'],
      ));
    }
  }
  return result;
}

function workflowFindings(signal: WorkflowRuntimeSignal): Finding[] {
  const result: Finding[] = [];
  for (const version of signal.nodeVersions) {
    const nodeMajor = major(version);
    if (nodeMajor !== null && nodeMajor < 24) {
      result.push(finding(
        'toolchain-workflow-node-floor', 'low', 'Workflow pins an older Node runtime',
        `setup-node uses ${version}.`, signal.file,
        'Align validation workflows on the production LTS Node baseline so local and CI semantics stay consistent.', ['toolchain', 'ci', 'node'],
      ));
    }
    if (nodeMajor !== null && nodeMajor > 24) {
      result.push(finding(
        'toolchain-workflow-node-current-review', 'info', 'Workflow uses a newer Current Node line than the production LTS baseline',
        `setup-node uses ${version}; production tooling is standardized on the LTS line.`, signal.file,
        'Use Current only in an explicit compatibility lane; keep required release validation on the supported LTS line.', ['toolchain', 'ci', 'node'],
      ));
    }
  }
  return result;
}

export function auditToolchainModernization(
  inventory: RepositoryInventory,
): AuditSection<ToolchainModernizationSummary> {
  const started = performance.now();
  const packageManifests = packageSignals(inventory);
  const tsconfigs = tsconfigSignals(inventory);
  const dotnetProjects = dotnetSignals(inventory);
  const workflows = workflowSignals(inventory);
  const findings = stableSortFindings([
    ...packageManifests.flatMap(packageFindings),
    ...tsconfigs.flatMap(tsconfigFindings),
    ...dotnetProjects.flatMap(dotnetFindings),
    ...workflows.flatMap(workflowFindings),
  ]);
  return {
    domain: 'build',
    title: 'Stable toolchain modernization audit',
    summary: {
      packageManifests,
      tsconfigs,
      dotnetProjects,
      workflows,
      node24CompatibleManifests: packageManifests.filter(item => (major(item.nodeEngine) ?? 0) >= 24).length,
      strictTsconfigs: tsconfigs.filter(item => item.strict === true).length,
      modernDotnetProjects: dotnetProjects.filter(item => item.targetFrameworks.some(target => /^net(?:1\d|[2-9]\d)\./i.test(target))).length,
      findings,
    },
    findings,
    elapsedMs: Math.max(0, performance.now() - started),
  };
}
