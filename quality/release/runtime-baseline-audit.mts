import {
  stableSortFindings,
  type AuditSection,
  type Finding,
  type RepositoryInventory,
  type SourceFile,
} from './contracts.mts';

export interface RuntimeBaselineSignal {
  readonly file: string;
  readonly kind: 'package' | 'dotnet' | 'workflow' | 'version-file';
  readonly runtime: 'node' | 'dotnet' | 'unknown';
  readonly declaredVersions: readonly string[];
  readonly prereleaseVersions: readonly string[];
  readonly floatingVersions: readonly string[];
}

export interface RuntimeBaselineSummary {
  readonly signals: readonly RuntimeBaselineSignal[];
  readonly nodeVersions: readonly string[];
  readonly dotnetVersions: readonly string[];
  readonly prereleaseVersions: readonly string[];
  readonly floatingVersions: readonly string[];
  readonly findings: readonly Finding[];
}

type JsonObject = Record<string, unknown>;

const PACKAGE_JSON = /(?:^|\/)package\.json$/i;
const GLOBAL_JSON = /(?:^|\/)global\.json$/i;
const VERSION_FILE = /(?:^|\/)(?:\.nvmrc|\.node-version|\.tool-versions)$/i;
const WORKFLOW = /^\.github\/workflows\/[^/]+\.ya?ml$/i;
const CSPROJ = /\.csproj$/i;
const PRE_RELEASE = /(?:alpha|beta|preview|rc|canary|nightly|next|dev)/i;
const FLOATING = /(?:^|[.@\s])(?:latest|current|stable|lts|\*|x)(?:$|[.\s])/i;
const NODE_VERSION_YAML = /node-version\s*:\s*['"]?([^'"\s#]+)/gi;
const DOTNET_VERSION_YAML = /dotnet-version\s*:\s*['"]?([^'"\s#]+)/gi;
const TARGET_FRAMEWORK = /<TargetFrameworks?>\s*([^<]+)\s*<\/TargetFrameworks?>/gi;

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

function stringValue(parent: JsonObject | null, key: string): string | null {
  if (!parent) return null;
  const value = parent[key];
  return typeof value === 'string' ? value : null;
}

function matches(text: string, pattern: RegExp): string[] {
  const result: string[] = [];
  const matcher = new RegExp(pattern.source, pattern.flags);
  let match: RegExpExecArray | null;
  while ((match = matcher.exec(text)) !== null) {
    const value = match[1]?.trim();
    if (value) result.push(value);
  }
  return result;
}

function normalizeFramework(value: string): string[] {
  return value.split(';').map(item => item.trim()).filter(Boolean);
}

function packageVersions(file: SourceFile): string[] {
  const parsed = parseObject(file);
  const engines = objectValue(parsed, 'engines');
  const node = stringValue(engines, 'node');
  const manager = stringValue(parsed, 'packageManager');
  return [node, manager].filter((value): value is string => Boolean(value));
}

function globalJsonVersions(file: SourceFile): string[] {
  const parsed = parseObject(file);
  const sdk = objectValue(parsed, 'sdk');
  const version = stringValue(sdk, 'version');
  return version ? [version] : [];
}

function versionFileVersions(file: SourceFile): string[] {
  if (file.repositoryPath.endsWith('.tool-versions')) {
    return file.text
      .split('\n')
      .map(line => line.trim())
      .filter(line => /^(?:nodejs|node|dotnet)\s+/i.test(line))
      .map(line => line.split(/\s+/).slice(1).join(' '))
      .filter(Boolean);
  }
  const value = file.text.trim();
  return value ? [value] : [];
}

function frameworkVersions(file: SourceFile): string[] {
  return matches(file.text, TARGET_FRAMEWORK).flatMap(normalizeFramework);
}

function workflowVersions(file: SourceFile): { node: string[]; dotnet: string[] } {
  return {
    node: matches(file.text, NODE_VERSION_YAML),
    dotnet: matches(file.text, DOTNET_VERSION_YAML),
  };
}

function signal(file: SourceFile): RuntimeBaselineSignal[] {
  if (PACKAGE_JSON.test(file.repositoryPath)) {
    const versions = packageVersions(file);
    return [{
      file: file.repositoryPath,
      kind: 'package',
      runtime: 'node',
      declaredVersions: versions,
      prereleaseVersions: versions.filter(value => PRE_RELEASE.test(value)),
      floatingVersions: versions.filter(value => FLOATING.test(value)),
    }];
  }
  if (GLOBAL_JSON.test(file.repositoryPath)) {
    const versions = globalJsonVersions(file);
    return [{
      file: file.repositoryPath,
      kind: 'dotnet',
      runtime: 'dotnet',
      declaredVersions: versions,
      prereleaseVersions: versions.filter(value => PRE_RELEASE.test(value)),
      floatingVersions: versions.filter(value => FLOATING.test(value)),
    }];
  }
  if (VERSION_FILE.test(file.repositoryPath)) {
    const versions = versionFileVersions(file);
    return [{
      file: file.repositoryPath,
      kind: 'version-file',
      runtime: file.repositoryPath.includes('dotnet') ? 'dotnet' : 'node',
      declaredVersions: versions,
      prereleaseVersions: versions.filter(value => PRE_RELEASE.test(value)),
      floatingVersions: versions.filter(value => FLOATING.test(value)),
    }];
  }
  if (CSPROJ.test(file.repositoryPath)) {
    const versions = frameworkVersions(file);
    return [{
      file: file.repositoryPath,
      kind: 'dotnet',
      runtime: 'dotnet',
      declaredVersions: versions,
      prereleaseVersions: versions.filter(value => PRE_RELEASE.test(value)),
      floatingVersions: versions.filter(value => FLOATING.test(value)),
    }];
  }
  if (WORKFLOW.test(file.repositoryPath)) {
    const versions = workflowVersions(file);
    const result: RuntimeBaselineSignal[] = [];
    if (versions.node.length > 0) {
      result.push({
        file: file.repositoryPath,
        kind: 'workflow',
        runtime: 'node',
        declaredVersions: versions.node,
        prereleaseVersions: versions.node.filter(value => PRE_RELEASE.test(value)),
        floatingVersions: versions.node.filter(value => FLOATING.test(value)),
      });
    }
    if (versions.dotnet.length > 0) {
      result.push({
        file: file.repositoryPath,
        kind: 'workflow',
        runtime: 'dotnet',
        declaredVersions: versions.dotnet,
        prereleaseVersions: versions.dotnet.filter(value => PRE_RELEASE.test(value)),
        floatingVersions: versions.dotnet.filter(value => FLOATING.test(value)),
      });
    }
    return result;
  }
  return [];
}

function lineOf(text: string, token: string): number {
  const index = text.indexOf(token);
  return index < 0 ? 1 : text.slice(0, index).split('\n').length;
}

function finding(
  file: string,
  line: number,
  id: string,
  severity: Finding['severity'],
  title: string,
  message: string,
  remediation: string,
  blocking: boolean,
): Finding {
  return {
    id,
    domain: 'dependencies',
    severity,
    ...(blocking ? { blocking: true } : {}),
    title,
    message,
    location: { file, line },
    remediation,
    tags: ['runtime', 'dependencies', 'modernization', 'node', 'dotnet'],
  };
}

function majorFromNode(value: string): number | null {
  const normalized = value.match(/(?:^|[^0-9])(\d{1,3})(?:\.|\s|$)/)?.[1];
  if (!normalized) return null;
  const major = Number(normalized);
  return Number.isFinite(major) ? major : null;
}

function majorFromFramework(value: string): number | null {
  const match = value.match(/^net(\d+)/i);
  if (!match?.[1]) return null;
  const major = Number(match[1]);
  return Number.isFinite(major) ? major : null;
}

function findingsFor(file: SourceFile, current: RuntimeBaselineSignal): Finding[] {
  const result: Finding[] = [];
  for (const value of current.prereleaseVersions) {
    result.push(finding(
      file.repositoryPath,
      lineOf(file.text, value),
      'runtime-prerelease-version',
      'high',
      'Production toolchain references a prerelease runtime',
      `Runtime/toolchain selector '${value}' contains a prerelease channel.`,
      'Use a stable supported release for authoritative validation and release paths; isolate experiments outside the release gate.',
      true,
    ));
  }
  for (const value of current.floatingVersions) {
    result.push(finding(
      file.repositoryPath,
      lineOf(file.text, value),
      'runtime-floating-version',
      'high',
      'Runtime version is floating',
      `Runtime/toolchain selector '${value}' can change without a reviewed repository diff.`,
      'Pin the supported stable runtime line explicitly and update it through reviewed dependency/toolchain changes.',
      true,
    ));
  }

  if (current.runtime === 'node') {
    for (const value of current.declaredVersions) {
      if (/^(?:npm|pnpm|yarn|bun)@/i.test(value)) continue;
      const major = majorFromNode(value);
      if (major !== null && major < 22) {
        result.push(finding(
          file.repositoryPath,
          lineOf(file.text, value),
          'runtime-node-below-modern-baseline',
          'high',
          'Node runtime is below the modern repository baseline',
          `Node selector '${value}' resolves to major ${major}, below the supported modern runtime line.`,
          'Raise the runtime floor through a staged compatibility-tested migration and align all CI/version files.',
          true,
        ));
      }
    }
  }

  if (current.runtime === 'dotnet') {
    for (const value of current.declaredVersions) {
      const frameworkMajor = majorFromFramework(value);
      if (frameworkMajor !== null && frameworkMajor < 8) {
        result.push(finding(
          file.repositoryPath,
          lineOf(file.text, value),
          'runtime-dotnet-framework-below-baseline',
          'high',
          'Target framework is below the supported .NET baseline',
          `${value} is below the modern server runtime baseline.`,
          'Upgrade project-by-project with API compatibility and integration tests.',
          true,
        ));
      }
      const sdkMajor = majorFromNode(value);
      if (frameworkMajor === null && sdkMajor !== null && sdkMajor < 8) {
        result.push(finding(
          file.repositoryPath,
          lineOf(file.text, value),
          'runtime-dotnet-sdk-below-baseline',
          'high',
          '.NET SDK is below the supported baseline',
          `SDK selector '${value}' is below the modern supported server toolchain.`,
          'Align CI/global.json with the stable SDK required by repository target frameworks.',
          true,
        ));
      }
    }
  }
  return result;
}

function numericMajorSet(values: readonly string[], runtime: 'node' | 'dotnet'): Set<number> {
  const result = new Set<number>();
  for (const value of values) {
    const major = runtime === 'node'
      ? majorFromNode(value)
      : majorFromFramework(value) ?? majorFromNode(value);
    if (major !== null) result.add(major);
  }
  return result;
}

function crossFileFindings(signals: readonly RuntimeBaselineSignal[]): Finding[] {
  const result: Finding[] = [];
  const nodeSignals = signals.filter(item => item.runtime === 'node');
  const dotnetSignals = signals.filter(item => item.runtime === 'dotnet');
  const nodeMajors = numericMajorSet(nodeSignals.flatMap(item => item.declaredVersions).filter(value => !/^(?:npm|pnpm|yarn|bun)@/i.test(value)), 'node');
  const dotnetMajors = numericMajorSet(dotnetSignals.flatMap(item => item.declaredVersions), 'dotnet');

  if (nodeMajors.size > 1) {
    result.push({
      id: 'runtime-node-major-drift',
      domain: 'dependencies',
      severity: 'high',
      blocking: true,
      title: 'Repository declares multiple Node major baselines',
      message: `Detected Node major lines: ${[...nodeMajors].sort((a, b) => a - b).join(', ')}. CI, package engines and local version files can execute different semantics.`,
      remediation: 'Converge package engines, version files and CI setup-node declarations on one reviewed stable Node major.',
      tags: ['runtime', 'node', 'drift', 'modernization'],
    });
  }

  if (dotnetMajors.size > 1) {
    result.push({
      id: 'runtime-dotnet-major-drift',
      domain: 'dependencies',
      severity: 'medium',
      title: 'Repository declares multiple .NET major baselines',
      message: `Detected .NET major lines: ${[...dotnetMajors].sort((a, b) => a - b).join(', ')}. Multi-targeting may be intentional but requires an explicit compatibility contract.`,
      remediation: 'Converge on one stable SDK/TFM line where possible, or document/test intentional multi-target compatibility.',
      tags: ['runtime', 'dotnet', 'drift', 'modernization'],
    });
  }
  return result;
}

export function auditRuntimeBaseline(
  inventory: RepositoryInventory,
): AuditSection<RuntimeBaselineSummary> {
  const started = performance.now();
  const relevant = inventory.files.filter(file =>
    PACKAGE_JSON.test(file.repositoryPath)
    || GLOBAL_JSON.test(file.repositoryPath)
    || VERSION_FILE.test(file.repositoryPath)
    || WORKFLOW.test(file.repositoryPath)
    || CSPROJ.test(file.repositoryPath));
  const signals = relevant.flatMap(signal);
  const findings = stableSortFindings([
    ...relevant.flatMap(file => signal(file).flatMap(current => findingsFor(file, current))),
    ...crossFileFindings(signals),
  ]);
  const nodeVersions = signals.filter(item => item.runtime === 'node').flatMap(item => item.declaredVersions);
  const dotnetVersions = signals.filter(item => item.runtime === 'dotnet').flatMap(item => item.declaredVersions);
  return {
    domain: 'dependencies',
    title: 'Stable runtime baseline audit',
    summary: {
      signals,
      nodeVersions,
      dotnetVersions,
      prereleaseVersions: signals.flatMap(item => item.prereleaseVersions),
      floatingVersions: signals.flatMap(item => item.floatingVersions),
      findings,
    },
    findings,
    elapsedMs: Math.max(0, performance.now() - started),
  };
}
