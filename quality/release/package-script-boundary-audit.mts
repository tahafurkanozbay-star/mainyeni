import {
  stableSortFindings,
  type AuditSection,
  type Finding,
  type RepositoryInventory,
  type SourceFile,
} from './contracts.mts';

export interface PackageScriptSignal {
  readonly file: string;
  readonly scriptCount: number;
  readonly lifecycleScripts: readonly string[];
  readonly npxCommands: number;
  readonly remoteDownloads: number;
  readonly shellPipelines: number;
  readonly forceFlags: number;
}

export interface PackageScriptBoundarySummary {
  readonly manifests: readonly PackageScriptSignal[];
  readonly manifestCount: number;
  readonly scriptCount: number;
  readonly lifecycleScriptCount: number;
  readonly findings: readonly Finding[];
}

interface ScriptEntry {
  readonly file: SourceFile;
  readonly name: string;
  readonly command: string;
}

type JsonObject = Record<string, unknown>;

const PACKAGE_JSON = /(^|\/)package\.json$/i;
const GENERATED = /(^|\/)(?:node_modules|dist|build|coverage|bin|obj|qa-artifacts)(?:\/|$)/i;
const LIFECYCLE = /^(?:preinstall|install|postinstall|prepare|prepublish|prepublishOnly|publish|postpublish)$/i;
const REMOTE_DOWNLOAD = /\b(?:curl|wget)\b[^\n;&|]*(?:https?:\/\/|\$\{?)/i;
const PIPE_TO_SHELL = /\b(?:curl|wget)\b[^\n]*\|\s*(?:ba|z|k|c)?sh\b/i;
const REMOTE_EXECUTABLE = /(?:https?:\/\/[^\s'"`]+\.(?:js|mjs|cjs|sh|bash|ps1))(?:\s|$)/i;
const FORCE_INSTALL = /\b(?:npm|pnpm|yarn)\b[^\n]*(?:--force|--legacy-peer-deps|--ignore-engines|--no-lockfile)\b/i;
const NPM_INSTALL = /\bnpm\s+(?:install|i)\b/i;
const NPM_CI = /\bnpm\s+ci\b/i;
const SHELL_SUBSTITUTION = /\$\([^)]*\)|`[^`]+`/;
const ENV_COMMAND = /\b(?:npm_config_|NODE_OPTIONS|NPM_CONFIG_)[A-Za-z0-9_]*\s*=|\bNODE_OPTIONS\b/i;
const NPX = /\bnpx(?:\s+--yes)?\s+([^\s;&|]+)/gi;
const MAX_FINDINGS = 32;

function parseJson(file: SourceFile): JsonObject | null {
  try {
    const value: unknown = JSON.parse(file.text);
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? value as JsonObject
      : null;
  } catch {
    return null;
  }
}

function scriptEntries(file: SourceFile): ScriptEntry[] {
  const json = parseJson(file);
  const scripts = json?.scripts;
  if (scripts === null || typeof scripts !== 'object' || Array.isArray(scripts)) return [];
  return Object.entries(scripts as Record<string, unknown>)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    .map(([name, command]) => ({ file, name, command }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function manifests(inventory: RepositoryInventory): SourceFile[] {
  return inventory.files
    .filter(file => PACKAGE_JSON.test(file.repositoryPath) && !GENERATED.test(file.repositoryPath))
    .sort((left, right) => left.repositoryPath.localeCompare(right.repositoryPath));
}

function npxPackages(command: string): string[] {
  const packages: string[] = [];
  const matcher = new RegExp(NPX.source, NPX.flags);
  let match: RegExpExecArray | null;
  while ((match = matcher.exec(command)) !== null) {
    const value = (match[1] ?? '').trim();
    if (value) packages.push(value);
  }
  return packages;
}

function hasPinnedNpxIdentity(value: string): boolean {
  if (value.startsWith('-')) return true;
  if (/^@[^/]+\/[^@]+@(?:\d+|[0-9a-f]{40})/.test(value)) return true;
  return /^[^@\s]+@(?:\d+|[0-9a-f]{40})/.test(value);
}

function lineForScript(file: SourceFile, name: string): number {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`^[\\t ]*"${escaped}"\\s*:`, 'm').exec(file.text);
  if (!match || match.index === undefined) return 1;
  return file.text.slice(0, match.index).split('\n').length;
}

function finding(
  entry: ScriptEntry,
  id: string,
  severity: Finding['severity'],
  title: string,
  message: string,
  remediation: string,
  tags: readonly string[],
  blocking = false,
): Finding {
  return {
    id,
    domain: 'security',
    severity,
    ...(blocking ? { blocking: true } : {}),
    title,
    message,
    location: { file: entry.file.repositoryPath, line: lineForScript(entry.file, entry.name) },
    evidence: { value: `${entry.name}: ${entry.command.slice(0, 220)}` },
    remediation,
    tags: ['package-script', 'supply-chain', ...tags],
  };
}

function findingsFor(entry: ScriptEntry): Finding[] {
  const result: Finding[] = [];
  if (PIPE_TO_SHELL.test(entry.command)) {
    result.push(finding(
      entry,
      'package-script-remote-pipe-shell',
      'critical',
      'Package script pipes remote content directly to a shell',
      'Remote bytes become executable source without a repository-reviewed digest or artifact boundary.',
      'Download a versioned artifact separately, verify its cryptographic digest/signature, then execute a reviewed local tool.',
      ['remote-code', 'shell'],
      true,
    ));
  }
  if (REMOTE_EXECUTABLE.test(entry.command)) {
    result.push(finding(
      entry,
      'package-script-remote-executable',
      'high',
      'Package script references a remote executable file',
      'Direct remote script execution bypasses lockfile provenance and makes builds depend on mutable network content.',
      'Vendor or package the tool through the lockfile, or verify a pinned immutable digest before execution.',
      ['remote-code', 'provenance'],
      true,
    ));
  } else if (REMOTE_DOWNLOAD.test(entry.command)) {
    result.push(finding(
      entry,
      'package-script-remote-download-review',
      'medium',
      'Package script downloads remote content',
      'Network downloads in package scripts require timeout, provenance and deterministic cache behavior.',
      'Prefer lockfile-resolved packages. If download is unavoidable, pin origin/version/digest and bound timeout/retries.',
      ['network', 'provenance'],
    ));
  }

  for (const identity of npxPackages(entry.command)) {
    if (hasPinnedNpxIdentity(identity)) continue;
    result.push(finding(
      entry,
      'package-script-npx-unpinned',
      'medium',
      'Package script executes an unpinned npx package identity',
      `npx target '${identity}' is not bound to a reviewed version or immutable commit identity.`,
      'Install the tool in devDependencies and invoke its local binary, or pin an explicit reviewed version for one-off maintenance.',
      ['npx', 'dependency'],
    ));
  }

  if (FORCE_INSTALL.test(entry.command)) {
    result.push(finding(
      entry,
      'package-script-install-policy-bypass',
      'medium',
      'Package script bypasses dependency-resolution safeguards',
      'Force/legacy/no-lock install flags can hide peer, engine or lockfile inconsistencies that release validation should expose.',
      'Fix the dependency graph and keep deterministic lockfile/engine enforcement enabled.',
      ['dependency', 'lockfile'],
    ));
  }

  if (NPM_INSTALL.test(entry.command) && !NPM_CI.test(entry.command) && /(?:^|:)(?:ci|build|test|verify|release|deploy)/i.test(entry.name)) {
    result.push(finding(
      entry,
      'package-script-npm-install-in-validation',
      'low',
      'Validation script uses npm install instead of npm ci',
      'npm install can rewrite dependency resolution while a release/CI-style script is running.',
      'Use npm ci for deterministic lockfile validation in build/test/release automation.',
      ['dependency', 'reproducibility'],
    ));
  }

  if (LIFECYCLE.test(entry.name)) {
    result.push(finding(
      entry,
      'package-script-install-lifecycle-review',
      'info',
      'Install/publish lifecycle script expands package installation authority',
      `Lifecycle script '${entry.name}' executes automatically in common package-manager flows.`,
      'Keep lifecycle scripts minimal, local-only and deterministic; move optional generation into explicit developer commands.',
      ['lifecycle', 'reproducibility'],
    ));
  }

  if (SHELL_SUBSTITUTION.test(entry.command)) {
    result.push(finding(
      entry,
      'package-script-shell-substitution',
      'low',
      'Package script uses shell command substitution',
      'Command substitution makes quoting and cross-platform execution harder to audit and can turn command output into arguments.',
      'Move orchestration into a typed Node .mts script with explicit argv construction and error handling.',
      ['shell', 'portability'],
    ));
  }

  if (ENV_COMMAND.test(entry.command)) {
    result.push(finding(
      entry,
      'package-script-process-control-env',
      'low',
      'Package script mutates Node/npm process-control environment',
      'NODE_OPTIONS/npm_config changes can alter loader, TLS, registry or install behavior outside the visible command arguments.',
      'Move approved process options into reviewed configuration and keep security-sensitive overrides out of ad-hoc scripts.',
      ['environment', 'node'],
    ));
  }
  return result;
}

function signal(file: SourceFile, entries: readonly ScriptEntry[]): PackageScriptSignal {
  const commandText = entries.map(entry => entry.command).join('\n');
  return {
    file: file.repositoryPath,
    scriptCount: entries.length,
    lifecycleScripts: entries.filter(entry => LIFECYCLE.test(entry.name)).map(entry => entry.name),
    npxCommands: entries.reduce((sum, entry) => sum + npxPackages(entry.command).length, 0),
    remoteDownloads: entries.filter(entry => REMOTE_DOWNLOAD.test(entry.command)).length,
    shellPipelines: entries.filter(entry => PIPE_TO_SHELL.test(entry.command) || SHELL_SUBSTITUTION.test(entry.command)).length,
    forceFlags: countMatches(commandText, FORCE_INSTALL),
  };
}

function countMatches(text: string, pattern: RegExp): number {
  const matcher = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
  let total = 0;
  while (matcher.exec(text) !== null) total += 1;
  return total;
}

export function auditPackageScriptBoundaries(
  inventory: RepositoryInventory,
): AuditSection<PackageScriptBoundarySummary> {
  const started = performance.now();
  const files = manifests(inventory);
  const entriesByFile = new Map(files.map(file => [file.repositoryPath, scriptEntries(file)]));
  const signals = files.map(file => signal(file, entriesByFile.get(file.repositoryPath) ?? []));
  const allFindings = stableSortFindings(files.flatMap(file =>
    (entriesByFile.get(file.repositoryPath) ?? []).flatMap(findingsFor)));
  const blocking = allFindings.filter(item => item.blocking === true);
  const review = allFindings.filter(item => item.blocking !== true);
  const findings = stableSortFindings([
    ...blocking,
    ...review.slice(0, Math.max(0, MAX_FINDINGS - blocking.length)),
  ]);
  return {
    domain: 'security',
    title: 'Package script supply-chain boundary audit',
    summary: {
      manifests: signals,
      manifestCount: signals.length,
      scriptCount: signals.reduce((sum, item) => sum + item.scriptCount, 0),
      lifecycleScriptCount: signals.reduce((sum, item) => sum + item.lifecycleScripts.length, 0),
      findings,
    },
    findings,
    elapsedMs: Math.max(0, performance.now() - started),
  };
}
