import {
  stableSortFindings,
  type AuditSection,
  type Finding,
  type RepositoryInventory,
  type SourceFile,
} from './contracts.mts';

export interface ReproducibleBuildSignal {
  readonly file: string;
  readonly kind: 'dotnet-policy' | 'package' | 'workflow' | 'docker';
  readonly deterministicSignals: number;
  readonly lockedSignals: number;
  readonly timestampRisks: number;
  readonly mutableInputRisks: number;
}

export interface ReproducibleBuildSummary {
  readonly signals: readonly ReproducibleBuildSignal[];
  readonly deterministicPolicies: number;
  readonly lockedDependencyPolicies: number;
  readonly mutableInputRisks: number;
  readonly findings: readonly Finding[];
}

type JsonObject = Record<string, unknown>;

const DOTNET_POLICY = /(?:^|\/)(?:Directory\.Build\.props|[^/]+\.csproj)$/i;
const PACKAGE_JSON = /(?:^|\/)package\.json$/i;
const WORKFLOW = /^\.github\/workflows\/[^/]+\.ya?ml$/i;
const DOCKERFILE = /(?:^|\/)(?:Dockerfile|[^/]+\.Dockerfile)$/i;
const DETERMINISTIC_TRUE = /<Deterministic>\s*true\s*<\/Deterministic>/i;
const CI_BUILD_TRUE = /<ContinuousIntegrationBuild>\s*true\s*<\/ContinuousIntegrationBuild>/i;
const DEBUG_TYPE_PORTABLE = /<DebugType>\s*(?:portable|embedded)\s*<\/DebugType>/i;
const PATH_MAP = /<PathMap>\s*[^<]+\s*<\/PathMap>/i;
const LOCKED_RESTORE = /\bdotnet\s+restore\b[^\n]*(?:--locked-mode|RestoreLockedMode=true)/i;
const NPM_CI = /\bnpm\s+ci\b/i;
const PNPM_FROZEN = /\bpnpm\s+install\b[^\n]*--frozen-lockfile/i;
const YARN_FROZEN = /\byarn\s+install\b[^\n]*(?:--immutable|--frozen-lockfile)/i;
const BUN_FROZEN = /\bbun\s+install\b[^\n]*--frozen-lockfile/i;
const DATE_IN_BUILD = /\b(?:date|Get-Date|new\s+Date\s*\(|Date\.now\s*\(|System\.DateTime\.(?:Now|UtcNow))\b/i;
const RANDOM_IN_BUILD = /\b(?:Math\.random\s*\(|RandomNumberGenerator|System\.Random\b|uuidgen\b|New-Guid\b)\b/i;
const LATEST_TAG = /(?:^|[\s:=@/])(?:latest|edge|nightly|canary)(?:$|[\s#])/i;
const DOCKER_FROM = /^\s*FROM\s+([^\s]+)(?:\s+AS\s+\S+)?/gim;
const DOCKER_DIGEST = /@sha256:[0-9a-f]{64}$/i;
const DOWNLOAD_URL = /https?:\/\/[^\s'"`]+/gi;
const CHECKSUM = /\b(?:sha256sum|shasum\s+-a\s+256|Get-FileHash|openssl\s+dgst\s+-sha256|cosign\s+verify)\b/i;
const GIT_FLOATING = /\bgit\s+(?:clone|checkout|fetch)\b[^\n]*(?:\bmain\b|\bmaster\b|\bHEAD\b|--depth\s+1)(?![^\n]*[0-9a-f]{40})/i;
const NPM_VERSION_RANGE = /^[~^]|\*|\b(?:latest|next|beta|alpha|rc)\b/i;

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

function objectValue(parent: JsonObject | null, key: string): JsonObject | null {
  if (!parent) return null;
  const value = parent[key];
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as JsonObject
    : null;
}

function stringEntries(parent: JsonObject | null): readonly [string, string][] {
  if (!parent) return [];
  return Object.entries(parent).filter((entry): entry is [string, string] => typeof entry[1] === 'string');
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
    domain: 'build',
    severity,
    ...(blocking ? { blocking: true } : {}),
    title,
    message,
    location: { file: file.repositoryPath, line: pattern ? lineOf(file.text, pattern) : 1 },
    remediation,
    tags: ['reproducible-build', 'supply-chain', 'modernization', 'release'],
  };
}

function dotnetFindings(file: SourceFile): Finding[] {
  const result: Finding[] = [];
  const central = file.repositoryPath.endsWith('Directory.Build.props');
  if (central && !DETERMINISTIC_TRUE.test(file.text)) result.push(finding(file, 'repro-dotnet-deterministic-missing', 'high', 'Central .NET build does not enforce deterministic output', 'Without Deterministic=true, repeated builds of the same source/toolchain may embed unstable compiler inputs.', 'Set Deterministic=true centrally and validate artifact digests in release CI.', true));
  if (central && !CI_BUILD_TRUE.test(file.text)) result.push(finding(file, 'repro-dotnet-ci-build-missing', 'medium', 'ContinuousIntegrationBuild is not enabled centrally', 'CI builds can omit deterministic/path normalization behaviors expected for reproducible artifacts.', 'Set ContinuousIntegrationBuild=true for CI/release builds, centrally or through an authoritative CI property.', false));
  if (central && !DEBUG_TYPE_PORTABLE.test(file.text)) result.push(finding(file, 'repro-dotnet-portable-symbols-missing', 'low', 'Portable/embedded debug symbols are not explicit', 'Platform-specific symbol output can reduce build portability and provenance comparison.', 'Prefer portable or embedded debug symbols for cross-platform deterministic builds.', false));
  if (central && !PATH_MAP.test(file.text)) result.push(finding(file, 'repro-dotnet-path-map-review', 'low', 'Build path normalization is not explicit', 'Absolute build-agent paths can leak into artifacts/source maps depending on compiler settings.', 'Use PathMap or SourceLink-compatible path normalization when artifact reproducibility requires it.', false));
  if (DATE_IN_BUILD.test(file.text)) result.push(finding(file, 'repro-dotnet-build-time-input', 'high', 'Build policy references current time', 'Embedding current time makes output differ for identical source and dependency inputs.', 'Derive version metadata from the immutable commit/release identity rather than wall-clock time.', true, DATE_IN_BUILD));
  if (RANDOM_IN_BUILD.test(file.text)) result.push(finding(file, 'repro-dotnet-random-build-input', 'high', 'Build policy references random input', 'Random build metadata prevents byte-for-byte reproducibility.', 'Replace random identifiers with deterministic commit/content identities.', true, RANDOM_IN_BUILD));
  return result;
}

function packageFindings(file: SourceFile): Finding[] {
  const parsed = parseObject(file);
  if (!parsed) return [];
  const result: Finding[] = [];
  for (const section of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'] as const) {
    for (const [name, version] of stringEntries(objectValue(parsed, section))) {
      if (/^(?:file:|link:|portal:)/i.test(version)) {
        result.push(finding(file, 'repro-package-local-dependency', 'high', 'Package dependency uses a local filesystem/link protocol', `${section}.${name}=${version} depends on developer workspace topology rather than a registry/content identity.`, 'Use a published immutable package, workspace protocol with one lock authority, or a reviewed monorepo workspace contract.', true));
      }
      if (/^(?:git\+|github:|https?:).*#?(?:main|master|HEAD)?$/i.test(version) && !/[0-9a-f]{40}/i.test(version)) {
        result.push(finding(file, 'repro-package-git-dependency-unpinned', 'high', 'Git dependency is not pinned to an immutable commit', `${section}.${name}=${version} can resolve different source over time.`, 'Pin VCS dependencies to a reviewed immutable commit or publish a versioned package.', true));
      }
      if (NPM_VERSION_RANGE.test(version)) {
        result.push(finding(file, 'repro-package-range-review', 'low', 'Manifest dependency uses a floating semantic range', `${section}.${name}=${version} relies on lockfile integrity for reproducibility.`, 'Keep the lockfile authoritative and use frozen installs; exact versions may be preferred for release tooling.', false));
      }
    }
  }
  return result;
}

function workflowFindings(file: SourceFile): Finding[] {
  const result: Finding[] = [];
  const text = file.text;
  const hasBuild = /\b(?:npm\s+run\s+build|pnpm\s+build|yarn\s+build|vite\s+build|dotnet\s+(?:build|publish)|docker\s+build)/i.test(text);
  if (!hasBuild) return result;

  if (/\bdotnet\s+restore\b/i.test(text) && !LOCKED_RESTORE.test(text)) result.push(finding(file, 'repro-workflow-dotnet-restore-unlocked', 'medium', 'Build workflow restores .NET dependencies without locked mode', 'The package graph can change independently of reviewed source if locked restore is not enforced.', 'Use packages.lock.json and --locked-mode for authoritative release validation.', false, /dotnet\s+restore/));

  const hasNodeInstall = /\b(?:npm\s+(?:ci|install)|pnpm\s+install|yarn\s+install|bun\s+install)\b/i.test(text);
  const frozen = NPM_CI.test(text) || PNPM_FROZEN.test(text) || YARN_FROZEN.test(text) || BUN_FROZEN.test(text);
  if (hasNodeInstall && !frozen) result.push(finding(file, 'repro-workflow-node-install-unlocked', 'high', 'Build workflow dependency install is not frozen', 'The dependency graph can drift during CI/release builds.', 'Use the package-manager immutable/frozen install mode and one reviewed lockfile.', true));

  if (DATE_IN_BUILD.test(text)) result.push(finding(file, 'repro-workflow-time-derived-output', 'high', 'Build workflow injects current time into release path', 'Wall-clock-derived version/output metadata prevents identical-source reproducibility.', 'Use commit/tag/content identity and SOURCE_DATE_EPOCH where timestamps are required.', true, DATE_IN_BUILD));
  if (RANDOM_IN_BUILD.test(text)) result.push(finding(file, 'repro-workflow-random-derived-output', 'high', 'Build workflow injects random identity into release path', 'Random output identity prevents deterministic artifact comparison.', 'Use immutable commit/content identities for build metadata.', true, RANDOM_IN_BUILD));
  if (GIT_FLOATING.test(text)) result.push(finding(file, 'repro-workflow-git-floating-source', 'critical', 'Build workflow fetches a floating Git source', 'Building main/master/HEAD from a secondary repository does not bind output to the reviewed commit graph.', 'Pin external source to an immutable commit and verify repository identity before use.', true, GIT_FLOATING));

  const urls = text.match(DOWNLOAD_URL) ?? [];
  if (urls.length > 0 && !CHECKSUM.test(text)) result.push(finding(file, 'repro-workflow-download-without-checksum', 'high', 'Build workflow downloads external bytes without checksum verification', 'Mutable or compromised remote content can enter a build without a reviewed content identity.', 'Pin the versioned download URL and verify a reviewed SHA-256/signature before extraction or execution.', true, DOWNLOAD_URL));
  return result;
}

function dockerFindings(file: SourceFile): Finding[] {
  const result: Finding[] = [];
  const matcher = new RegExp(DOCKER_FROM.source, DOCKER_FROM.flags);
  let match: RegExpExecArray | null;
  while ((match = matcher.exec(file.text)) !== null) {
    const image = match[1]?.trim() ?? '';
    if (!image || /^scratch$/i.test(image)) continue;
    if (!DOCKER_DIGEST.test(image)) {
      result.push(finding(file, 'repro-container-base-image-not-digest-pinned', 'high', 'Container base image is not digest pinned', `FROM ${image} can resolve to different bytes when the registry tag moves.`, 'Pin production/release base images by sha256 digest and update through reviewed dependency automation.', true, /^\s*FROM\s+/im));
    }
    if (LATEST_TAG.test(image)) {
      result.push(finding(file, 'repro-container-floating-tag', 'critical', 'Container base image uses a floating tag', `FROM ${image} is explicitly floating.`, 'Use a stable version plus immutable digest.', true, /^\s*FROM\s+/im));
    }
  }
  return result;
}

function signal(file: SourceFile): ReproducibleBuildSignal {
  if (DOTNET_POLICY.test(file.repositoryPath)) {
    return {
      file: file.repositoryPath,
      kind: 'dotnet-policy',
      deterministicSignals: Number(DETERMINISTIC_TRUE.test(file.text)) + Number(CI_BUILD_TRUE.test(file.text)),
      lockedSignals: 0,
      timestampRisks: Number(DATE_IN_BUILD.test(file.text)),
      mutableInputRisks: Number(RANDOM_IN_BUILD.test(file.text)),
    };
  }
  if (PACKAGE_JSON.test(file.repositoryPath)) {
    const risks = packageFindings(file).filter(item => item.blocking === true).length;
    return { file: file.repositoryPath, kind: 'package', deterministicSignals: 0, lockedSignals: 0, timestampRisks: 0, mutableInputRisks: risks };
  }
  if (DOCKERFILE.test(file.repositoryPath)) {
    const risks = dockerFindings(file).length;
    return { file: file.repositoryPath, kind: 'docker', deterministicSignals: 0, lockedSignals: 0, timestampRisks: 0, mutableInputRisks: risks };
  }
  const lockedSignals = Number(LOCKED_RESTORE.test(file.text)) + Number(NPM_CI.test(file.text) || PNPM_FROZEN.test(file.text) || YARN_FROZEN.test(file.text) || BUN_FROZEN.test(file.text));
  return {
    file: file.repositoryPath,
    kind: 'workflow',
    deterministicSignals: Number(/SOURCE_DATE_EPOCH|ContinuousIntegrationBuild=true|Deterministic=true/i.test(file.text)),
    lockedSignals,
    timestampRisks: Number(DATE_IN_BUILD.test(file.text)),
    mutableInputRisks: Number(GIT_FLOATING.test(file.text)) + Number((file.text.match(DOWNLOAD_URL) ?? []).length > 0 && !CHECKSUM.test(file.text)),
  };
}

export function auditReproducibleBuildContract(
  inventory: RepositoryInventory,
): AuditSection<ReproducibleBuildSummary> {
  const started = performance.now();
  const files = inventory.files.filter(file =>
    DOTNET_POLICY.test(file.repositoryPath)
    || PACKAGE_JSON.test(file.repositoryPath)
    || WORKFLOW.test(file.repositoryPath)
    || DOCKERFILE.test(file.repositoryPath));
  const findings = stableSortFindings([
    ...files.filter(file => DOTNET_POLICY.test(file.repositoryPath)).flatMap(dotnetFindings),
    ...files.filter(file => PACKAGE_JSON.test(file.repositoryPath)).flatMap(packageFindings),
    ...files.filter(file => WORKFLOW.test(file.repositoryPath)).flatMap(workflowFindings),
    ...files.filter(file => DOCKERFILE.test(file.repositoryPath)).flatMap(dockerFindings),
  ]);
  const signals = files.map(signal);
  return {
    domain: 'build',
    title: 'Reproducible build and immutable input audit',
    summary: {
      signals,
      deterministicPolicies: signals.reduce((sum, item) => sum + item.deterministicSignals, 0),
      lockedDependencyPolicies: signals.reduce((sum, item) => sum + item.lockedSignals, 0),
      mutableInputRisks: signals.reduce((sum, item) => sum + item.mutableInputRisks, 0),
      findings,
    },
    findings,
    elapsedMs: Math.max(0, performance.now() - started),
  };
}
