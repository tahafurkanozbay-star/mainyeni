export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';
export type AuditDomain =
  | 'architecture'
  | 'security'
  | 'dependencies'
  | 'network'
  | 'gis'
  | 'icons'
  | 'data'
  | 'search'
  | 'performance'
  | 'accessibility'
  | 'responsive'
  | 'observability'
  | 'testing'
  | 'build'
  | 'release';
export type GateState = 'pass' | 'review' | 'block';
export type FileKind =
  | 'javascript'
  | 'typescript'
  | 'json'
  | 'css'
  | 'html'
  | 'markdown'
  | 'csharp'
  | 'xml'
  | 'yaml'
  | 'shell'
  | 'other';

export interface SourceLocation {
  readonly file: string;
  readonly line: number;
  readonly column?: number;
}

export interface Evidence {
  readonly excerpt?: string;
  readonly value?: string | number | boolean | null;
  readonly metadata?: Readonly<Record<string, string | number | boolean | null>>;
}

export interface Finding {
  readonly id: string;
  readonly domain: AuditDomain;
  readonly severity: Severity;
  readonly title: string;
  readonly message: string;
  readonly location?: SourceLocation;
  readonly evidence?: Evidence;
  readonly remediation?: string;
  readonly blocking?: boolean;
  readonly tags?: readonly string[];
}

export interface TextRule {
  readonly id: string;
  readonly domain: AuditDomain;
  readonly severity: Severity;
  readonly title: string;
  readonly message: string;
  readonly pattern: RegExp;
  readonly includeKinds?: readonly FileKind[];
  readonly includePaths?: readonly RegExp[];
  readonly excludePaths?: readonly RegExp[];
  readonly remediation?: string;
  readonly blocking?: boolean;
  readonly maxFindingsPerFile?: number;
  readonly tags?: readonly string[];
}

export interface SourceFile {
  readonly absolutePath: string;
  readonly repositoryPath: string;
  readonly extension: string;
  readonly kind: FileKind;
  readonly bytes: number;
  readonly lines: number;
  readonly text: string;
}

export interface LanguageStats {
  readonly kind: FileKind;
  readonly files: number;
  readonly lines: number;
  readonly bytes: number;
}

export interface RepositoryInventory {
  readonly root: string;
  readonly files: readonly SourceFile[];
  readonly ignoredDirectories: readonly string[];
  readonly languageStats: readonly LanguageStats[];
  readonly totalFiles: number;
  readonly totalLines: number;
  readonly totalBytes: number;
  readonly generatedAt: string;
}

export interface DependencyRecord {
  readonly name: string;
  readonly version: string;
  readonly scope: 'runtime' | 'development' | 'unknown';
  readonly manifest: string;
}

export interface DependencyPolicy {
  readonly name: string;
  readonly legacyPattern?: RegExp;
  readonly minimumVersion?: string;
  readonly severity: Severity;
  readonly reason: string;
  readonly migration: string;
  readonly tags?: readonly string[];
}

export interface DependencySummary {
  readonly dependencies: readonly DependencyRecord[];
  readonly findings: readonly Finding[];
  readonly manifests: readonly string[];
  readonly legacyCount: number;
}

export interface ExternalReference {
  readonly source: string;
  readonly line: number;
  readonly raw: string;
  readonly protocol: string;
  readonly host: string;
  readonly path: string;
  readonly category: 'api' | 'asset' | 'font' | 'analytics' | 'map' | 'unknown';
}

export interface NetworkSummary {
  readonly references: readonly ExternalReference[];
  readonly hosts: readonly string[];
  readonly insecureCount: number;
  readonly remoteAssetCount: number;
  readonly findings: readonly Finding[];
}

export interface IconRegistryEntry {
  readonly key: string;
  readonly aliases: readonly string[];
  readonly asset?: string;
  readonly raw: unknown;
}

export interface IconRegistrySummary {
  readonly path: string | null;
  readonly entries: readonly IconRegistryEntry[];
  readonly duplicateKeys: readonly string[];
  readonly duplicateAliases: readonly string[];
  readonly missingAssets: readonly string[];
  readonly findings: readonly Finding[];
}

export interface GisRuntimePresence {
  readonly expectedPath: string;
  readonly present: boolean;
  readonly role: string;
}

export interface GisSummary {
  readonly runtimes: readonly GisRuntimePresence[];
  readonly forbiddenProtocols: readonly string[];
  readonly ownershipRisks: readonly Finding[];
  readonly lifecycleRisks: readonly Finding[];
  readonly findings: readonly Finding[];
}

export interface AccessibilitySignal {
  readonly file: string;
  readonly component: string | null;
  readonly interactiveElements: number;
  readonly ariaLabels: number;
  readonly labels: number;
  readonly keyboardHandlers: number;
  readonly clickHandlers: number;
  readonly rawTabIndexes: number;
  readonly dangerousPositiveTabIndexes: number;
  readonly imageElements: number;
  readonly altAttributes: number;
}

export interface AccessibilitySummary {
  readonly signals: readonly AccessibilitySignal[];
  readonly findings: readonly Finding[];
  readonly interactiveElementCount: number;
  readonly labelledControlCount: number;
  readonly keyboardHandlerCount: number;
}

export interface PerformanceBudget {
  readonly maxSourceFileBytes: number;
  readonly maxSourceFileLines: number;
  readonly maxInlineJsonBytes: number;
  readonly maxSynchronousLoopLines: number;
  readonly maxRemoteAssetHosts: number;
  readonly maxDuplicateLiteralOccurrences: number;
}

export interface PerformanceSignal {
  readonly id: string;
  readonly file: string;
  readonly value: number;
  readonly budget: number;
  readonly unit: string;
  readonly description: string;
}

export interface PerformanceSummary {
  readonly signals: readonly PerformanceSignal[];
  readonly findings: readonly Finding[];
  readonly largestFiles: readonly { readonly file: string; readonly bytes: number; readonly lines: number }[];
}

export interface TestContract {
  readonly id: string;
  readonly area: AuditDomain;
  readonly description: string;
  readonly required: boolean;
  readonly evidencePatterns: readonly RegExp[];
}

export interface TestCoverageSummary {
  readonly contracts: readonly TestContract[];
  readonly satisfied: readonly string[];
  readonly missing: readonly string[];
  readonly findings: readonly Finding[];
}

export interface ReleaseThresholds {
  readonly blockOnCritical: boolean;
  readonly maxHighFindings: number;
  readonly maxMediumFindings: number;
  readonly maxRiskScore: number;
  readonly requireTests: boolean;
  readonly requireBuild: boolean;
  readonly requireArchitectureAudit: boolean;
  readonly requireNoForbiddenProtocols: boolean;
  readonly requireSingleIconAuthority: boolean;
}

export interface ReleaseContext {
  readonly repository: string;
  readonly branch?: string;
  readonly commit?: string;
  readonly pullRequest?: number;
  readonly baselineCommit?: string;
  readonly generatedAt: string;
}

export interface AuditSection<T> {
  readonly domain: AuditDomain;
  readonly title: string;
  readonly summary: T;
  readonly findings: readonly Finding[];
  readonly elapsedMs: number;
}

export interface SeverityCounts {
  readonly critical: number;
  readonly high: number;
  readonly medium: number;
  readonly low: number;
  readonly info: number;
}

export interface ReleaseGateDecision {
  readonly state: GateState;
  readonly reasons: readonly string[];
  readonly riskScore: number;
  readonly counts: SeverityCounts;
  readonly blockingFindingIds: readonly string[];
}

export interface ReleaseReport {
  readonly schemaVersion: 1;
  readonly context: ReleaseContext;
  readonly inventory: RepositoryInventory;
  readonly sections: readonly AuditSection<unknown>[];
  readonly findings: readonly Finding[];
  readonly decision: ReleaseGateDecision;
  readonly fingerprint: string;
}

export interface FindingSnapshot {
  readonly key: string;
  readonly severity: Severity;
  readonly domain: AuditDomain;
  readonly file?: string;
  readonly line?: number;
}

export interface BaselineSnapshot {
  readonly schemaVersion: 1;
  readonly commit?: string;
  readonly generatedAt: string;
  readonly fingerprint: string;
  readonly findings: readonly FindingSnapshot[];
  readonly counts: SeverityCounts;
  readonly riskScore: number;
}

export interface RegressionDelta {
  readonly added: readonly FindingSnapshot[];
  readonly removed: readonly FindingSnapshot[];
  readonly unchanged: readonly FindingSnapshot[];
  readonly riskScoreDelta: number;
  readonly severityDelta: Readonly<Record<Severity, number>>;
}

export interface CliOptions {
  readonly root: string;
  readonly outputDirectory: string;
  readonly baselinePath?: string;
  readonly strict: boolean;
  readonly includeTests: boolean;
  readonly maxTextBytes: number;
}

export interface JsonResult<T> {
  readonly ok: boolean;
  readonly value?: T;
  readonly error?: string;
}

export interface TimedResult<T> {
  readonly value: T;
  readonly elapsedMs: number;
}

export const SEVERITIES: readonly Severity[] = ['critical', 'high', 'medium', 'low', 'info'] as const;
export const DOMAINS: readonly AuditDomain[] = [
  'architecture',
  'security',
  'dependencies',
  'network',
  'gis',
  'icons',
  'data',
  'search',
  'performance',
  'accessibility',
  'responsive',
  'observability',
  'testing',
  'build',
  'release',
] as const;

export const SEVERITY_WEIGHT: Readonly<Record<Severity, number>> = Object.freeze({
  critical: 100,
  high: 40,
  medium: 12,
  low: 3,
  info: 0,
});

export const DEFAULT_THRESHOLDS: ReleaseThresholds = Object.freeze({
  blockOnCritical: true,
  maxHighFindings: 0,
  maxMediumFindings: 50,
  maxRiskScore: 120,
  requireTests: true,
  requireBuild: true,
  requireArchitectureAudit: true,
  requireNoForbiddenProtocols: true,
  requireSingleIconAuthority: true,
});

export const DEFAULT_PERFORMANCE_BUDGET: PerformanceBudget = Object.freeze({
  maxSourceFileBytes: 450_000,
  maxSourceFileLines: 4_000,
  maxInlineJsonBytes: 250_000,
  maxSynchronousLoopLines: 250,
  maxRemoteAssetHosts: 0,
  maxDuplicateLiteralOccurrences: 18,
});

export function severityWeight(severity: Severity): number {
  return SEVERITY_WEIGHT[severity];
}

export function compareSeverity(left: Severity, right: Severity): number {
  return severityWeight(right) - severityWeight(left);
}

export function emptySeverityCounts(): SeverityCounts {
  return { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
}

export function countSeverities(findings: readonly Finding[]): SeverityCounts {
  const counts: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const finding of findings) counts[finding.severity] += 1;
  return counts;
}

export function riskScore(findings: readonly Finding[]): number {
  return findings.reduce((total, finding) => total + severityWeight(finding.severity), 0);
}

export function normalizeRepositoryPath(input: string): string {
  return input.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/{2,}/g, '/');
}

export function findingKey(finding: Finding): string {
  const location = finding.location ? `${normalizeRepositoryPath(finding.location.file)}:${finding.location.line}` : '-';
  const evidence = finding.evidence?.value ?? finding.evidence?.excerpt ?? '';
  return `${finding.domain}|${finding.id}|${location}|${String(evidence)}`;
}

export function snapshotFinding(finding: Finding): FindingSnapshot {
  return {
    key: findingKey(finding),
    severity: finding.severity,
    domain: finding.domain,
    ...(finding.location?.file ? { file: normalizeRepositoryPath(finding.location.file) } : {}),
    ...(finding.location?.line ? { line: finding.location.line } : {}),
  };
}

export function dedupeFindings(findings: readonly Finding[]): Finding[] {
  const seen = new Set<string>();
  const result: Finding[] = [];
  for (const finding of findings) {
    const key = findingKey(finding);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(finding);
  }
  return result;
}

export function stableSortFindings(findings: readonly Finding[]): Finding[] {
  return [...findings].sort((left, right) => {
    const severity = compareSeverity(left.severity, right.severity);
    if (severity !== 0) return severity;
    const domain = left.domain.localeCompare(right.domain, 'en');
    if (domain !== 0) return domain;
    const file = (left.location?.file ?? '').localeCompare(right.location?.file ?? '', 'en');
    if (file !== 0) return file;
    const line = (left.location?.line ?? 0) - (right.location?.line ?? 0);
    if (line !== 0) return line;
    return left.id.localeCompare(right.id, 'en');
  });
}

export function clamp(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.min(maximum, Math.max(minimum, value));
}

export function safeInteger(value: unknown, fallback = 0): number {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : fallback;
}

export function safePositiveInteger(value: unknown, fallback: number): number {
  const parsed = safeInteger(value, fallback);
  return parsed > 0 ? parsed : fallback;
}

export function percentile(values: readonly number[], percentileValue: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].filter(Number.isFinite).sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  const normalized = clamp(percentileValue, 0, 1);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(normalized * sorted.length) - 1));
  return sorted[index] ?? 0;
}

export function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b, 'en'));
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function asString(value: unknown): string {
  return typeof value === 'string' ? value : value === null || value === undefined ? '' : String(value);
}

export function safeJsonParse<T = unknown>(text: string): JsonResult<T> {
  try {
    return { ok: true, value: JSON.parse(text) as T };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function timed<T>(operation: () => T | Promise<T>): Promise<TimedResult<T>> {
  const start = performance.now();
  const value = await operation();
  return { value, elapsedMs: Math.max(0, performance.now() - start) };
}

export function assertNever(value: never, message = 'Unexpected value'): never {
  throw new Error(`${message}: ${String(value)}`);
}
