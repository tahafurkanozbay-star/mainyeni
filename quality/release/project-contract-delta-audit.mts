import {
  safeJsonParse,
  stableSortFindings,
  type AuditSection,
  type Finding,
  type RepositoryInventory,
  type SourceFile,
} from './contracts.mts';
import { collectRepositoryChanges } from './change-risk-audit.mts';

export interface ProjectContractDelta {
  readonly id: string;
  readonly file: string;
  readonly contract: string;
  readonly before: string | number | boolean | null;
  readonly after: string | number | boolean | null;
  readonly severity: Finding['severity'];
  readonly blocking: boolean;
}

export interface ProjectContractDeltaSummary {
  readonly packageManifestChanges: number;
  readonly tsconfigChanges: number;
  readonly dotnetProjectChanges: number;
  readonly globalJsonChanges: number;
  readonly deltas: readonly ProjectContractDelta[];
  readonly criticalDeltas: number;
  readonly highDeltas: number;
  readonly findingsByRule: Readonly<Record<string, number>>;
}

interface PackageJsonShape {
  readonly scripts?: Record<string, unknown>;
  readonly engines?: Record<string, unknown>;
  readonly packageManager?: unknown;
  readonly private?: unknown;
  readonly type?: unknown;
}

interface TsConfigShape {
  readonly compilerOptions?: Record<string, unknown>;
  readonly extends?: unknown;
}

interface GlobalJsonShape {
  readonly sdk?: Record<string, unknown>;
}

const PACKAGE_JSON = /(?:^|\/)package\.json$/u;
const TSCONFIG = /(?:^|\/)tsconfig(?:\.[^/]+)?\.json$/u;
const DOTNET_PROJECT = /(?:^|\/)(?:Directory\.Build\.props|[^/]+\.csproj)$/u;
const GLOBAL_JSON = /^global\.json$/u;

const CRITICAL_PACKAGE_SCRIPTS = new Set([
  'build',
  'test',
  'verify',
  'test:tooling',
  'dependency:verify',
  'build:verify',
]);

const HIGH_PACKAGE_SCRIPT_PREFIXES = [
  'lint',
  'typecheck',
  'quality:',
  'test:',
  'build:',
] as const;

const STRICT_TS_OPTIONS = [
  'strict',
  'noUncheckedIndexedAccess',
  'exactOptionalPropertyTypes',
  'useUnknownInCatchVariables',
] as const;

function fileMap(inventory: RepositoryInventory): Map<string, SourceFile> {
  return new Map(inventory.files.map(file => [file.repositoryPath, file]));
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : {};
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function normalizedCommand(value: unknown): string | null {
  const text = asString(value);
  if (text === null) return null;
  return text.replace(/\s+/gu, ' ').trim();
}

function isHighPackageScript(name: string): boolean {
  return CRITICAL_PACKAGE_SCRIPTS.has(name) || HIGH_PACKAGE_SCRIPT_PREFIXES.some(prefix => name.startsWith(prefix));
}

function packageScriptSeverity(name: string): Finding['severity'] {
  return CRITICAL_PACKAGE_SCRIPTS.has(name) ? 'critical' : 'high';
}

function packageScriptBlocking(name: string, after: string | null): boolean {
  return CRITICAL_PACKAGE_SCRIPTS.has(name) && after === null;
}

function packageDeltas(file: string, beforeText: string, afterText: string): ProjectContractDelta[] {
  const before = safeJsonParse<PackageJsonShape>(beforeText);
  const after = safeJsonParse<PackageJsonShape>(afterText);
  if (!before.ok || !before.value || !after.ok || !after.value) return [];

  const deltas: ProjectContractDelta[] = [];
  const beforeScripts = asRecord(before.value.scripts);
  const afterScripts = asRecord(after.value.scripts);
  const names = new Set([...Object.keys(beforeScripts), ...Object.keys(afterScripts)]);
  for (const name of names) {
    if (!isHighPackageScript(name)) continue;
    const oldCommand = normalizedCommand(beforeScripts[name]);
    const newCommand = normalizedCommand(afterScripts[name]);
    if (oldCommand === newCommand) continue;
    if (oldCommand === null && newCommand !== null) continue;
    deltas.push({
      id: newCommand === null ? 'project-contract-package-script-removed' : 'project-contract-package-script-changed',
      file,
      contract: `scripts.${name}`,
      before: oldCommand,
      after: newCommand,
      severity: packageScriptSeverity(name),
      blocking: packageScriptBlocking(name, newCommand),
    });
  }

  const beforeEngines = asRecord(before.value.engines);
  const afterEngines = asRecord(after.value.engines);
  const oldNode = asString(beforeEngines.node);
  const newNode = asString(afterEngines.node);
  if (oldNode && oldNode !== newNode) {
    deltas.push({
      id: newNode === null ? 'project-contract-node-engine-removed' : 'project-contract-node-engine-changed',
      file,
      contract: 'engines.node',
      before: oldNode,
      after: newNode,
      severity: 'high',
      blocking: newNode === null,
    });
  }

  const oldManager = asString(before.value.packageManager);
  const newManager = asString(after.value.packageManager);
  if (oldManager && oldManager !== newManager) {
    deltas.push({
      id: newManager === null ? 'project-contract-package-manager-removed' : 'project-contract-package-manager-changed',
      file,
      contract: 'packageManager',
      before: oldManager,
      after: newManager,
      severity: 'high',
      blocking: newManager === null,
    });
  }

  if (before.value.private === true && after.value.private !== true) {
    deltas.push({
      id: 'project-contract-package-private-weakened',
      file,
      contract: 'private',
      before: true,
      after: asBoolean(after.value.private),
      severity: 'high',
      blocking: false,
    });
  }

  const oldType = asString(before.value.type);
  const newType = asString(after.value.type);
  if (oldType === 'module' && newType !== 'module') {
    deltas.push({
      id: 'project-contract-module-type-weakened',
      file,
      contract: 'type',
      before: oldType,
      after: newType,
      severity: 'high',
      blocking: false,
    });
  }

  return deltas;
}

function tsconfigDeltas(file: string, beforeText: string, afterText: string): ProjectContractDelta[] {
  const before = safeJsonParse<TsConfigShape>(beforeText);
  const after = safeJsonParse<TsConfigShape>(afterText);
  if (!before.ok || !before.value || !after.ok || !after.value) return [];
  const beforeOptions = asRecord(before.value.compilerOptions);
  const afterOptions = asRecord(after.value.compilerOptions);
  const deltas: ProjectContractDelta[] = [];

  for (const option of STRICT_TS_OPTIONS) {
    const oldValue = asBoolean(beforeOptions[option]);
    const newValue = asBoolean(afterOptions[option]);
    if (oldValue !== true || newValue === true) continue;
    deltas.push({
      id: 'project-contract-typescript-strictness-weakened',
      file,
      contract: `compilerOptions.${option}`,
      before: true,
      after: newValue,
      severity: option === 'strict' ? 'critical' : 'high',
      blocking: option === 'strict',
    });
  }

  const oldNoEmit = asBoolean(beforeOptions.noEmit);
  const newNoEmit = asBoolean(afterOptions.noEmit);
  if (oldNoEmit === true && newNoEmit === false) {
    deltas.push({
      id: 'project-contract-typescript-noemit-weakened',
      file,
      contract: 'compilerOptions.noEmit',
      before: true,
      after: false,
      severity: 'medium',
      blocking: false,
    });
  }

  const oldCheckJs = asBoolean(beforeOptions.checkJs);
  const newCheckJs = asBoolean(afterOptions.checkJs);
  if (oldCheckJs === true && newCheckJs !== true) {
    deltas.push({
      id: 'project-contract-typescript-checkjs-weakened',
      file,
      contract: 'compilerOptions.checkJs',
      before: true,
      after: newCheckJs,
      severity: 'medium',
      blocking: false,
    });
  }

  return deltas;
}

function xmlTag(text: string, tag: string): string | null {
  const pattern = new RegExp(`<${tag}\\b[^>]*>([^<]+)</${tag}>`, 'iu');
  return pattern.exec(text)?.[1]?.trim() ?? null;
}

function targetMajor(value: string | null): number | null {
  if (!value) return null;
  const match = /net(\d+)(?:\.\d+)?/iu.exec(value);
  if (!match?.[1]) return null;
  const parsed = Number.parseInt(match[1], 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function dotnetDeltas(file: string, beforeText: string, afterText: string): ProjectContractDelta[] {
  const deltas: ProjectContractDelta[] = [];
  const oldTarget = xmlTag(beforeText, 'TargetFramework') ?? xmlTag(beforeText, 'TargetFrameworks');
  const newTarget = xmlTag(afterText, 'TargetFramework') ?? xmlTag(afterText, 'TargetFrameworks');
  const oldMajor = targetMajor(oldTarget);
  const newMajor = targetMajor(newTarget);
  if (oldTarget && !newTarget) {
    deltas.push({
      id: 'project-contract-dotnet-target-removed',
      file,
      contract: 'TargetFramework',
      before: oldTarget,
      after: null,
      severity: 'high',
      blocking: false,
    });
  } else if (oldMajor !== null && newMajor !== null && newMajor < oldMajor) {
    deltas.push({
      id: 'project-contract-dotnet-target-downgraded',
      file,
      contract: 'TargetFramework',
      before: oldTarget,
      after: newTarget,
      severity: 'high',
      blocking: false,
    });
  }

  const oldNullable = xmlTag(beforeText, 'Nullable')?.toLowerCase() ?? null;
  const newNullable = xmlTag(afterText, 'Nullable')?.toLowerCase() ?? null;
  if ((oldNullable === 'enable' || oldNullable === 'annotations') && newNullable !== oldNullable) {
    deltas.push({
      id: 'project-contract-dotnet-nullable-weakened',
      file,
      contract: 'Nullable',
      before: oldNullable,
      after: newNullable,
      severity: 'high',
      blocking: false,
    });
  }

  const oldWarnings = xmlTag(beforeText, 'TreatWarningsAsErrors')?.toLowerCase() ?? null;
  const newWarnings = xmlTag(afterText, 'TreatWarningsAsErrors')?.toLowerCase() ?? null;
  if (oldWarnings === 'true' && newWarnings !== 'true') {
    deltas.push({
      id: 'project-contract-dotnet-warnings-weakened',
      file,
      contract: 'TreatWarningsAsErrors',
      before: true,
      after: newWarnings === 'true' ? true : newWarnings === 'false' ? false : null,
      severity: 'medium',
      blocking: false,
    });
  }

  const oldAnalysis = xmlTag(beforeText, 'AnalysisLevel')?.toLowerCase() ?? null;
  const newAnalysis = xmlTag(afterText, 'AnalysisLevel')?.toLowerCase() ?? null;
  if (oldAnalysis === 'latest' && newAnalysis && newAnalysis !== 'latest') {
    deltas.push({
      id: 'project-contract-dotnet-analysis-level-weakened',
      file,
      contract: 'AnalysisLevel',
      before: oldAnalysis,
      after: newAnalysis,
      severity: 'medium',
      blocking: false,
    });
  }

  return deltas;
}

function sdkMajor(version: string | null): number | null {
  if (!version) return null;
  const match = /^(\d+)\./u.exec(version.trim());
  if (!match?.[1]) return null;
  const parsed = Number.parseInt(match[1], 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function globalJsonDeltas(file: string, beforeText: string, afterText: string): ProjectContractDelta[] {
  const before = safeJsonParse<GlobalJsonShape>(beforeText);
  const after = safeJsonParse<GlobalJsonShape>(afterText);
  if (!before.ok || !before.value || !after.ok || !after.value) return [];
  const beforeSdk = asRecord(before.value.sdk);
  const afterSdk = asRecord(after.value.sdk);
  const oldVersion = asString(beforeSdk.version);
  const newVersion = asString(afterSdk.version);
  const oldMajor = sdkMajor(oldVersion);
  const newMajor = sdkMajor(newVersion);
  const deltas: ProjectContractDelta[] = [];

  if (oldVersion && !newVersion) {
    deltas.push({
      id: 'project-contract-dotnet-sdk-pin-removed',
      file,
      contract: 'sdk.version',
      before: oldVersion,
      after: null,
      severity: 'high',
      blocking: false,
    });
  } else if (oldMajor !== null && newMajor !== null && newMajor < oldMajor) {
    deltas.push({
      id: 'project-contract-dotnet-sdk-downgraded',
      file,
      contract: 'sdk.version',
      before: oldVersion,
      after: newVersion,
      severity: 'high',
      blocking: false,
    });
  }

  const oldRollForward = asString(beforeSdk.rollForward);
  const newRollForward = asString(afterSdk.rollForward);
  if (oldRollForward && oldRollForward !== newRollForward) {
    deltas.push({
      id: 'project-contract-dotnet-rollforward-changed',
      file,
      contract: 'sdk.rollForward',
      before: oldRollForward,
      after: newRollForward,
      severity: 'medium',
      blocking: false,
    });
  }

  return deltas;
}

function deltaFinding(delta: ProjectContractDelta): Finding {
  const value = `${String(delta.before)} -> ${String(delta.after)}`;
  const titleById: Readonly<Record<string, string>> = {
    'project-contract-package-script-removed': 'Release-critical package script was removed',
    'project-contract-package-script-changed': 'Release-critical package script changed',
    'project-contract-node-engine-removed': 'Node engine contract was removed',
    'project-contract-node-engine-changed': 'Node engine contract changed',
    'project-contract-package-manager-removed': 'Package-manager pin was removed',
    'project-contract-package-manager-changed': 'Package-manager pin changed',
    'project-contract-package-private-weakened': 'Package privacy contract was weakened',
    'project-contract-module-type-weakened': 'ES module package contract was weakened',
    'project-contract-typescript-strictness-weakened': 'TypeScript strictness contract was weakened',
    'project-contract-typescript-noemit-weakened': 'TypeScript noEmit validation contract changed',
    'project-contract-typescript-checkjs-weakened': 'JavaScript type-checking contract was weakened',
    'project-contract-dotnet-target-removed': '.NET target framework contract was removed',
    'project-contract-dotnet-target-downgraded': '.NET target framework was downgraded',
    'project-contract-dotnet-nullable-weakened': '.NET nullable contract was weakened',
    'project-contract-dotnet-warnings-weakened': '.NET warnings-as-errors contract was weakened',
    'project-contract-dotnet-analysis-level-weakened': '.NET analysis level was weakened',
    'project-contract-dotnet-sdk-pin-removed': '.NET SDK pin was removed',
    'project-contract-dotnet-sdk-downgraded': '.NET SDK major was downgraded',
    'project-contract-dotnet-rollforward-changed': '.NET SDK roll-forward policy changed',
  };
  return {
    id: delta.id,
    domain: delta.id.includes('package') || delta.id.includes('node-engine')
      ? 'dependencies'
      : delta.id.includes('typescript') || delta.id.includes('dotnet')
        ? 'architecture'
        : 'release',
    severity: delta.severity,
    title: titleById[delta.id] ?? 'Project validation contract changed',
    message: `${delta.contract} changed from ${String(delta.before)} to ${String(delta.after)} relative to the exact base.`,
    location: { file: delta.file, line: 1 },
    evidence: { value },
    remediation: 'Preserve or strengthen the project validation contract. If the change is intentional, update focused regression evidence and keep release gates at least as strict.',
    tags: ['change-risk', 'project-contract', 'exact-base'],
    ...(delta.blocking ? { blocking: true } : {}),
  };
}

function findingsByRule(findings: readonly Finding[]): Readonly<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const finding of findings) counts[finding.id] = (counts[finding.id] ?? 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right, 'en')));
}

export function collectProjectContractDeltas(
  baseline: RepositoryInventory,
  current: RepositoryInventory,
): readonly ProjectContractDelta[] {
  const baselineFiles = fileMap(baseline);
  const currentFiles = fileMap(current);
  const changed = collectRepositoryChanges(baseline, current)
    .filter(change => change.kind === 'modified')
    .map(change => change.path);
  const deltas: ProjectContractDelta[] = [];

  for (const path of changed) {
    const before = baselineFiles.get(path);
    const after = currentFiles.get(path);
    if (!before || !after) continue;
    if (PACKAGE_JSON.test(path)) deltas.push(...packageDeltas(path, before.text, after.text));
    if (TSCONFIG.test(path)) deltas.push(...tsconfigDeltas(path, before.text, after.text));
    if (DOTNET_PROJECT.test(path)) deltas.push(...dotnetDeltas(path, before.text, after.text));
    if (GLOBAL_JSON.test(path)) deltas.push(...globalJsonDeltas(path, before.text, after.text));
  }

  return deltas.sort((left, right) =>
    left.file.localeCompare(right.file, 'en') ||
    left.contract.localeCompare(right.contract, 'en') ||
    left.id.localeCompare(right.id, 'en'));
}

export function auditProjectContractDelta(
  baseline: RepositoryInventory,
  current: RepositoryInventory,
): AuditSection<ProjectContractDeltaSummary> {
  const startedAt = Date.now();
  const changes = collectRepositoryChanges(baseline, current);
  const deltas = collectProjectContractDeltas(baseline, current);
  const findings = stableSortFindings(deltas.map(deltaFinding));
  const summary: ProjectContractDeltaSummary = {
    packageManifestChanges: changes.filter(change => PACKAGE_JSON.test(change.path) && change.kind !== 'renamed').length,
    tsconfigChanges: changes.filter(change => TSCONFIG.test(change.path) && change.kind !== 'renamed').length,
    dotnetProjectChanges: changes.filter(change => DOTNET_PROJECT.test(change.path) && change.kind !== 'renamed').length,
    globalJsonChanges: changes.filter(change => GLOBAL_JSON.test(change.path) && change.kind !== 'renamed').length,
    deltas,
    criticalDeltas: deltas.filter(delta => delta.severity === 'critical').length,
    highDeltas: deltas.filter(delta => delta.severity === 'high').length,
    findingsByRule: findingsByRule(findings),
  };
  return {
    domain: 'release',
    title: 'Exact-base project contract delta audit',
    summary,
    findings,
    elapsedMs: Math.max(0, Date.now() - startedAt),
  };
}

export function projectContractDeltaMarkdown(section: AuditSection<ProjectContractDeltaSummary>): string {
  const lines = [
    '# Kent Rehberi — Project Contract Delta',
    '',
    `- Package manifest changes: ${section.summary.packageManifestChanges}`,
    `- TypeScript config changes: ${section.summary.tsconfigChanges}`,
    `- .NET project/props changes: ${section.summary.dotnetProjectChanges}`,
    `- global.json changes: ${section.summary.globalJsonChanges}`,
    `- Contract deltas: ${section.summary.deltas.length}`,
    `- Critical deltas: ${section.summary.criticalDeltas}`,
    `- High deltas: ${section.summary.highDeltas}`,
    '',
    '## Contract drift',
    '',
  ];
  if (section.findings.length === 0) lines.push('No weakened project contracts relative to the exact base.');
  else {
    for (const finding of section.findings) {
      lines.push(`- **${finding.severity.toUpperCase()}** \`${finding.id}\` — ${finding.title} (${finding.location?.file ?? 'repository'})`);
    }
  }
  lines.push('');
  return `${lines.join('\n')}\n`;
}
