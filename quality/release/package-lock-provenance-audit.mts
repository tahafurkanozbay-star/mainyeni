import { stableSortFindings, type Finding, type RepositoryInventory, type SourceFile } from './contracts.mts';

export interface PackageLockProvenanceSignal {
  readonly file: string;
  readonly lockfileVersion: number | null;
  readonly packages: number;
  readonly registryPackages: number;
  readonly externalSources: number;
  readonly missingIntegrity: number;
  readonly weakIntegrity: number;
  readonly installScripts: number;
  readonly localLinks: number;
}

export interface PackageLockProvenanceSummary {
  readonly lockfiles: readonly PackageLockProvenanceSignal[];
  readonly lockfileCount: number;
  readonly packageCount: number;
  readonly findings: readonly Finding[];
}

type JsonObject = Record<string, unknown>;

type DependencyGroup = 'dependencies' | 'devDependencies' | 'optionalDependencies' | 'peerDependencies';

const TARGET_LOCK = /^Webclient\.app\/package-lock\.json$/i;
const NPM_REGISTRY_HOST = 'registry.npmjs.org';
const DIRECT_SOURCE = /^(?:https?:|git\+|git:|github:|gitlab:|bitbucket:|ssh:|file:|link:)/i;
const SHA512 = /^sha512-[A-Za-z0-9+/]+=*$/;
const WEAK_INTEGRITY = /^(?:sha1|md5)-/i;
const PACKAGE_KEY_TRAVERSAL = /(?:^|\/)\.\.(?:\/|$)|\\/;
const NODE_24 = /(?:^|\s|\|)>=?\s*24(?:\.0(?:\.0)?)?(?:\s|$)/;
const NPM_11 = /(?:^|\s|\|)>=?\s*11(?:\.0(?:\.0)?)?(?:\s|$)/;

function asObject(value: unknown): JsonObject | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : null;
}

function stringValue(object: JsonObject | null, key: string): string | undefined {
  const value = object?.[key];
  return typeof value === 'string' ? value : undefined;
}

function numberValue(object: JsonObject | null, key: string): number | undefined {
  const value = object?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function booleanValue(object: JsonObject | null, key: string): boolean | undefined {
  const value = object?.[key];
  return typeof value === 'boolean' ? value : undefined;
}

function objectValue(object: JsonObject | null, key: string): JsonObject | null {
  return asObject(object?.[key]);
}

function lockfiles(inventory: RepositoryInventory): SourceFile[] {
  return inventory.files.filter(file => TARGET_LOCK.test(file.repositoryPath));
}

function lineFor(file: SourceFile, needle: string): number {
  const offset = file.text.indexOf(needle);
  if (offset < 0) return 1;
  let line = 1;
  for (let index = 0; index < offset; index += 1) if (file.text.charCodeAt(index) === 10) line += 1;
  return line;
}

function finding(
  file: SourceFile,
  id: string,
  severity: Finding['severity'],
  title: string,
  message: string,
  remediation: string,
  blocking: boolean,
  metadata: Readonly<Record<string, string | number | boolean | null>> = {},
  lineNeedle = '"packages"',
): Finding {
  return {
    id,
    domain: 'dependencies',
    severity,
    blocking,
    title,
    message,
    location: { file: file.repositoryPath, line: lineFor(file, lineNeedle) },
    evidence: { metadata },
    remediation,
    tags: ['release', 'dependencies', 'package-lock', 'provenance', 'supply-chain'],
  };
}

function parseLock(file: SourceFile): JsonObject | null {
  try {
    return asObject(JSON.parse(file.text) as unknown);
  } catch {
    return null;
  }
}

function sourceUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function dependencyGroups(root: JsonObject | null): readonly DependencyGroup[] {
  return ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'] as const;
}

function rootSourceFindings(file: SourceFile, root: JsonObject | null): Finding[] {
  const findings: Finding[] = [];
  for (const group of dependencyGroups(root)) {
    const values = objectValue(root, group);
    if (!values) continue;
    for (const [name, raw] of Object.entries(values).sort(([left], [right]) => left.localeCompare(right))) {
      if (typeof raw !== 'string' || !DIRECT_SOURCE.test(raw.trim())) continue;
      findings.push(finding(
        file,
        'package-lock-direct-source-specifier',
        'critical',
        'Root dependency bypasses registry provenance',
        `Root ${group} entry ${name} resolves through a direct URL, VCS or local filesystem protocol.`,
        'Publish or consume the dependency through the reviewed npm registry and keep the lockfile content-addressed.',
        true,
        { group, package: name, specifier: raw },
        `"${name}"`,
      ));
    }
  }
  return findings;
}

function engineFindings(file: SourceFile, root: JsonObject | null): Finding[] {
  const engines = objectValue(root, 'engines');
  const node = stringValue(engines, 'node');
  const npm = stringValue(engines, 'npm');
  const findings: Finding[] = [];
  if (!node || !NODE_24.test(node)) findings.push(finding(
    file,
    'package-lock-node-engine-baseline',
    'high',
    'Lockfile root does not enforce Node 24 baseline',
    'Release tooling is standardized on Node 24, but the lockfile root engine metadata does not preserve that baseline.',
    'Regenerate the lockfile from package.json with an engines.node range requiring Node 24 or newer.',
    true,
    { node: node ?? null },
    '"engines"',
  ));
  if (!npm || !NPM_11.test(npm)) findings.push(finding(
    file,
    'package-lock-npm-engine-baseline',
    'high',
    'Lockfile root does not enforce npm 11 baseline',
    'Release dependency resolution is standardized on npm 11, but lockfile engine metadata does not preserve that baseline.',
    'Regenerate the lockfile from package.json with an engines.npm range requiring npm 11 or newer.',
    true,
    { npm: npm ?? null },
    '"engines"',
  ));
  return findings;
}

function packageFindings(file: SourceFile, packagePath: string, entry: JsonObject): readonly Finding[] {
  const findings: Finding[] = [];
  const version = stringValue(entry, 'version');
  const resolved = stringValue(entry, 'resolved');
  const integrity = stringValue(entry, 'integrity');
  const linked = booleanValue(entry, 'link') === true;
  const hasInstallScript = booleanValue(entry, 'hasInstallScript') === true;

  if (PACKAGE_KEY_TRAVERSAL.test(packagePath) || packagePath.startsWith('/') || /^[A-Za-z]:/.test(packagePath)) {
    findings.push(finding(file, 'package-lock-path-traversal', 'critical', 'Package lock path escapes normalized node_modules layout', `Lockfile package key ${packagePath} is not a normalized repository-relative package location.`, 'Regenerate the lockfile with npm 11 and reject local/path traversal package entries.', true, { packagePath }, `"${packagePath}"`));
  }

  if (linked) {
    findings.push(finding(file, 'package-lock-local-link', 'critical', 'Local linked package bypasses immutable dependency provenance', `Lockfile package ${packagePath} is represented as a local link.`, 'Replace local/link dependencies with a reviewed registry package or an explicitly versioned workspace release artifact.', true, { packagePath }, `"${packagePath}"`));
    return findings;
  }

  if (!version) {
    findings.push(finding(file, 'package-lock-version-missing', 'high', 'Locked package version is missing', `Lockfile package ${packagePath} does not carry an immutable version.`, 'Regenerate package-lock.json with npm 11 and require every external node_modules entry to have a version.', true, { packagePath }, `"${packagePath}"`));
  }

  if (!resolved) {
    findings.push(finding(file, 'package-lock-resolved-missing', 'high', 'Locked package source is missing', `Lockfile package ${packagePath} has no resolved source, so registry provenance cannot be proven.`, 'Regenerate package-lock.json with npm 11 and preserve the resolved registry source.', true, { packagePath, version: version ?? null }, `"${packagePath}"`));
  } else {
    const url = sourceUrl(resolved);
    if (!url) {
      findings.push(finding(file, 'package-lock-source-non-url', 'critical', 'Locked package source is not an HTTPS registry URL', `Lockfile package ${packagePath} uses non-URL source ${resolved}.`, 'Use an HTTPS npm registry artifact with integrity metadata.', true, { packagePath, resolved }, `"resolved"`));
    } else {
      if (url.username || url.password) findings.push(finding(file, 'package-lock-source-credentials', 'critical', 'Credentials are embedded in a dependency source URL', `Lockfile package ${packagePath} embeds URL credentials.`, 'Remove embedded credentials and use registry authentication outside committed lockfiles.', true, { packagePath, host: url.hostname }, `"resolved"`));
      if (url.protocol !== 'https:') findings.push(finding(file, 'package-lock-source-insecure-protocol', 'critical', 'Dependency source does not use HTTPS', `Lockfile package ${packagePath} resolves over ${url.protocol}.`, 'Resolve packages only from the reviewed HTTPS npm registry.', true, { packagePath, protocol: url.protocol }, `"resolved"`));
      else if (url.hostname.toLowerCase() !== NPM_REGISTRY_HOST) findings.push(finding(file, 'package-lock-source-unapproved-host', 'critical', 'Dependency source uses an unapproved registry host', `Lockfile package ${packagePath} resolves from ${url.hostname}.`, 'Use registry.npmjs.org or explicitly extend the reviewed registry allowlist with ownership and integrity controls.', true, { packagePath, host: url.hostname }, `"resolved"`));
    }
  }

  if (!integrity) {
    findings.push(finding(file, 'package-lock-integrity-missing', 'critical', 'Locked package has no content integrity digest', `Lockfile package ${packagePath} cannot prove downloaded artifact content.`, 'Regenerate package-lock.json with npm 11 and require SRI integrity for every registry package.', true, { packagePath, version: version ?? null }, `"${packagePath}"`));
  } else if (WEAK_INTEGRITY.test(integrity)) {
    findings.push(finding(file, 'package-lock-integrity-weak', 'critical', 'Locked package uses a weak integrity algorithm', `Lockfile package ${packagePath} uses ${integrity.split('-')[0] ?? 'unknown'} integrity.`, 'Regenerate the lockfile so registry artifacts use sha512 integrity.', true, { packagePath, integrityAlgorithm: integrity.split('-')[0] ?? 'unknown' }, `"integrity"`));
  } else if (!SHA512.test(integrity)) {
    findings.push(finding(file, 'package-lock-integrity-noncanonical', 'high', 'Locked package integrity is not canonical sha512 SRI', `Lockfile package ${packagePath} uses a non-canonical integrity value.`, 'Regenerate the lockfile with npm 11 and preserve sha512 SRI metadata.', true, { packagePath }, `"integrity"`));
  }

  if (hasInstallScript) findings.push(finding(file, 'package-lock-install-script', 'medium', 'Dependency executes an install lifecycle script', `Lockfile package ${packagePath} declares an install lifecycle script.`, 'Keep install scripts minimized; CI installs release QA dependencies with --ignore-scripts and any required native build should be separately reviewed.', false, { packagePath }, `"hasInstallScript"`));
  return findings;
}

export function auditPackageLockProvenance(inventory: RepositoryInventory): PackageLockProvenanceSummary {
  const findings: Finding[] = [];
  const signals: PackageLockProvenanceSignal[] = [];
  let totalPackages = 0;

  for (const file of lockfiles(inventory)) {
    const document = parseLock(file);
    if (!document) {
      findings.push(finding(file, 'package-lock-json-invalid', 'critical', 'package-lock.json is not valid JSON', 'Release dependency provenance cannot be evaluated because the lockfile is invalid.', 'Regenerate a valid npm 11 lockfile.', true));
      signals.push({ file: file.repositoryPath, lockfileVersion: null, packages: 0, registryPackages: 0, externalSources: 0, missingIntegrity: 0, weakIntegrity: 0, installScripts: 0, localLinks: 0 });
      continue;
    }

    const lockfileVersion = numberValue(document, 'lockfileVersion') ?? null;
    if (lockfileVersion !== 3) findings.push(finding(file, 'package-lock-version-unsupported', 'high', 'Lockfile format is not npm lockfileVersion 3', `Observed lockfileVersion ${String(lockfileVersion)}.`, 'Regenerate package-lock.json with npm 11.', true, { lockfileVersion }, '"lockfileVersion"'));
    const packages = objectValue(document, 'packages');
    if (!packages) {
      findings.push(finding(file, 'package-lock-packages-missing', 'critical', 'Lockfile package map is missing', 'The package-lock.json packages map is required for immutable source and integrity validation.', 'Regenerate package-lock.json with npm 11.', true));
      signals.push({ file: file.repositoryPath, lockfileVersion, packages: 0, registryPackages: 0, externalSources: 0, missingIntegrity: 0, weakIntegrity: 0, installScripts: 0, localLinks: 0 });
      continue;
    }

    const root = asObject(packages['']);
    findings.push(...rootSourceFindings(file, root));
    findings.push(...engineFindings(file, root));

    let packageCount = 0;
    let registryPackages = 0;
    let externalSources = 0;
    let missingIntegrity = 0;
    let weakIntegrity = 0;
    let installScripts = 0;
    let localLinks = 0;

    for (const [packagePath, raw] of Object.entries(packages).sort(([left], [right]) => left.localeCompare(right))) {
      if (packagePath === '') continue;
      const entry = asObject(raw);
      if (!entry) {
        findings.push(finding(file, 'package-lock-entry-invalid', 'high', 'Lockfile package entry is not an object', `Package entry ${packagePath} cannot be audited.`, 'Regenerate package-lock.json with npm 11.', true, { packagePath }, `"${packagePath}"`));
        continue;
      }
      packageCount += 1;
      const resolved = stringValue(entry, 'resolved');
      const integrity = stringValue(entry, 'integrity');
      const linked = booleanValue(entry, 'link') === true;
      if (resolved?.startsWith(`https://${NPM_REGISTRY_HOST}/`)) registryPackages += 1;
      else if (resolved) externalSources += 1;
      if (!integrity) missingIntegrity += 1;
      else if (WEAK_INTEGRITY.test(integrity) || !SHA512.test(integrity)) weakIntegrity += 1;
      if (booleanValue(entry, 'hasInstallScript') === true) installScripts += 1;
      if (linked) localLinks += 1;
      findings.push(...packageFindings(file, packagePath, entry));
    }

    totalPackages += packageCount;
    signals.push({ file: file.repositoryPath, lockfileVersion, packages: packageCount, registryPackages, externalSources, missingIntegrity, weakIntegrity, installScripts, localLinks });
  }

  if (signals.length === 0) findings.push({ id: 'package-lock-required-lockfile-missing', domain: 'dependencies', severity: 'critical', blocking: true, title: 'Webclient package-lock.json is missing from release inventory', message: 'Release dependency provenance requires the committed Webclient.app/package-lock.json.', remediation: 'Commit an npm 11 package-lock.json generated from the reviewed package manifest.', tags: ['release', 'dependencies', 'package-lock', 'provenance'] });

  return {
    lockfiles: Object.freeze(signals.sort((left, right) => left.file.localeCompare(right.file))),
    lockfileCount: signals.length,
    packageCount: totalPackages,
    findings: Object.freeze(stableSortFindings(findings)),
  };
}
