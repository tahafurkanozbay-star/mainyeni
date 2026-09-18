import {
  normalizeFiniteNumber,
  normalizeInteger,
  normalizeText,
} from '../Toolbox/DataIntegrityHelper';
import {
  createDataQualitySnapshot,
  evaluateDataReleaseGate,
  normalizeDataReleasePolicy,
  type DataQualitySnapshot,
  type DataReleaseGate,
  type DataReleasePolicy,
} from './release-guard/index';
import {
  evaluateSearchPerformanceBudget,
  normalizeSearchPerformanceBudget,
  type SearchBudgetEvaluation,
  type SearchPerformanceBudget,
  type SearchTelemetrySnapshot,
} from './search-observability/index';

export const DATA_SEARCH_READINESS_LEVELS = Object.freeze({
  Pass: 'pass',
  Warning: 'warning',
  Block: 'block',
} as const);

export type DataSearchReadinessLevel =
  typeof DATA_SEARCH_READINESS_LEVELS[keyof typeof DATA_SEARCH_READINESS_LEVELS];

export interface SearchIndexReadinessInput {
  inputCount?: unknown;
  indexedCount?: unknown;
  uniqueIdCount?: unknown;
  duplicateIds?: unknown;
  tokenCount?: unknown;
  prefixCount?: unknown;
}

export interface SearchIndexReadinessMetrics {
  inputCount: number;
  indexedCount: number;
  uniqueIdCount: number;
  duplicateIdCount: number;
  tokenCount: number;
  prefixCount: number;
  indexedRatio: number;
}

export interface DataSearchReadinessPolicy {
  release: DataReleasePolicy;
  performance: SearchPerformanceBudget;
  minimumIndexedRatio: number;
  maximumDuplicateIds: number;
  requireRepresentativePerformance: boolean;
}

export interface DataSearchReadinessPolicyInput {
  release?: unknown;
  performance?: Partial<SearchPerformanceBudget>;
  minimumIndexedRatio?: unknown;
  maximumDuplicateIds?: unknown;
  requireRepresentativePerformance?: boolean;
}

export interface DataSearchReadinessInput {
  schemaReport?: unknown;
  addressReport?: unknown;
  searchResponse?: unknown;
  qualitySnapshot?: DataQualitySnapshot;
  telemetry?: SearchTelemetrySnapshot | null;
  indexDiagnostics?: SearchIndexReadinessInput | null;
  policy?: DataSearchReadinessPolicyInput;
  label?: unknown;
}

export interface DataSearchReadinessFinding {
  level: Exclude<DataSearchReadinessLevel, 'pass'>;
  code: string;
  area: 'data-integrity' | 'performance' | 'index';
  message: string;
  actual: number | boolean | string | null;
  threshold: number | boolean | string | null;
}

export interface DataSearchReadinessReport {
  level: DataSearchReadinessLevel;
  ready: boolean;
  label: string;
  findings: readonly DataSearchReadinessFinding[];
  blockerCodes: readonly string[];
  warningCodes: readonly string[];
  quality: DataReleaseGate;
  performance: SearchBudgetEvaluation | null;
  index: SearchIndexReadinessMetrics | null;
  policy: DataSearchReadinessPolicy;
  generatedAt: number | null;
}

const boundedRatio = (value: unknown, fallback: number): number =>
  Math.min(1, Math.max(0, normalizeFiniteNumber(value, fallback) ?? fallback));

const normalizeCount = (value: unknown): number =>
  normalizeInteger(value, {
    min: 0,
    max: Number.MAX_SAFE_INTEGER,
    fallback: 0,
  }) ?? 0;

const ratio = (numerator: number, denominator: number): number =>
  denominator > 0 ? numerator / denominator : 0;

export const normalizeDataSearchReadinessPolicy = (
  input: DataSearchReadinessPolicyInput = {},
): DataSearchReadinessPolicy => ({
  release: normalizeDataReleasePolicy(input.release),
  performance: normalizeSearchPerformanceBudget(input.performance),
  minimumIndexedRatio: boundedRatio(input.minimumIndexedRatio, 0.95),
  maximumDuplicateIds: normalizeInteger(input.maximumDuplicateIds, {
    min: 0,
    max: 100_000,
    fallback: 0,
  }) ?? 0,
  requireRepresentativePerformance: input.requireRepresentativePerformance === true,
});

export const normalizeSearchIndexReadiness = (
  input: SearchIndexReadinessInput | null | undefined,
): SearchIndexReadinessMetrics | null => {
  if (!input) return null;

  const inputCount = normalizeCount(input.inputCount);
  const indexedCount = normalizeCount(input.indexedCount);
  const uniqueIdCount = normalizeCount(input.uniqueIdCount);
  const duplicateIdCount = Array.isArray(input.duplicateIds)
    ? input.duplicateIds.length
    : normalizeCount(input.duplicateIds);
  const tokenCount = normalizeCount(input.tokenCount);
  const prefixCount = normalizeCount(input.prefixCount);

  return {
    inputCount,
    indexedCount,
    uniqueIdCount,
    duplicateIdCount,
    tokenCount,
    prefixCount,
    indexedRatio: inputCount > 0 ? ratio(indexedCount, inputCount) : 1,
  };
};

const qualityFindings = (
  gate: DataReleaseGate,
): DataSearchReadinessFinding[] => gate.findings
  .filter(finding => finding.level !== 'pass')
  .map(finding => ({
    level: finding.level === 'block'
      ? DATA_SEARCH_READINESS_LEVELS.Block
      : DATA_SEARCH_READINESS_LEVELS.Warning,
    code: `quality:${finding.code}`,
    area: 'data-integrity',
    message: finding.message,
    actual: finding.actual,
    threshold: finding.threshold,
  }));

const performanceFindings = (
  evaluation: SearchBudgetEvaluation | null,
  requireRepresentative: boolean,
): DataSearchReadinessFinding[] => {
  if (!evaluation) return [];

  const findings: DataSearchReadinessFinding[] = evaluation.findings.map(finding => ({
    level: finding.level,
    code: `performance:${finding.code}`,
    area: 'performance',
    message: finding.message,
    actual: finding.actual,
    threshold: finding.threshold,
  }));

  if (requireRepresentative && !evaluation.representative) {
    findings.push({
      level: DATA_SEARCH_READINESS_LEVELS.Block,
      code: 'performance:representative-sample-required',
      area: 'performance',
      message: 'Production readiness requires a representative search performance sample',
      actual: evaluation.metrics.duration.count,
      threshold: evaluation.budget.minimumSamples,
    });
  }

  return findings;
};

const indexFindings = (
  index: SearchIndexReadinessMetrics | null,
  policy: DataSearchReadinessPolicy,
): DataSearchReadinessFinding[] => {
  if (!index) return [];

  const findings: DataSearchReadinessFinding[] = [];

  if (index.indexedRatio < policy.minimumIndexedRatio) {
    findings.push({
      level: DATA_SEARCH_READINESS_LEVELS.Block,
      code: 'index:indexed-ratio',
      area: 'index',
      message: 'Indexed record coverage is below the configured readiness threshold',
      actual: index.indexedRatio,
      threshold: policy.minimumIndexedRatio,
    });
  }

  if (index.duplicateIdCount > policy.maximumDuplicateIds) {
    findings.push({
      level: DATA_SEARCH_READINESS_LEVELS.Block,
      code: 'index:duplicate-identities',
      area: 'index',
      message: 'Search index contains more duplicate identities than the readiness policy permits',
      actual: index.duplicateIdCount,
      threshold: policy.maximumDuplicateIds,
    });
  }

  if (index.indexedCount > 0 && index.tokenCount === 0) {
    findings.push({
      level: DATA_SEARCH_READINESS_LEVELS.Warning,
      code: 'index:no-search-tokens',
      area: 'index',
      message: 'Indexed records produced no searchable token postings',
      actual: index.tokenCount,
      threshold: 1,
    });
  }

  return findings;
};

export const createDataSearchReadinessReport = (
  input: DataSearchReadinessInput = {},
): DataSearchReadinessReport => {
  const policy = normalizeDataSearchReadinessPolicy(input.policy);
  const qualitySnapshot = input.qualitySnapshot
    ?? createDataQualitySnapshot({
      schemaReport: input.schemaReport,
      addressReport: input.addressReport,
      searchResponse: input.searchResponse,
      label: input.label,
    });
  const quality = evaluateDataReleaseGate(qualitySnapshot, policy.release);
  const performance = input.telemetry
    ? evaluateSearchPerformanceBudget(input.telemetry, policy.performance)
    : null;
  const index = normalizeSearchIndexReadiness(input.indexDiagnostics);

  const findings = [
    ...qualityFindings(quality),
    ...performanceFindings(performance, policy.requireRepresentativePerformance),
    ...indexFindings(index, policy),
  ];

  const blockers = findings.filter(
    finding => finding.level === DATA_SEARCH_READINESS_LEVELS.Block,
  );
  const warnings = findings.filter(
    finding => finding.level === DATA_SEARCH_READINESS_LEVELS.Warning,
  );
  const level = blockers.length > 0
    ? DATA_SEARCH_READINESS_LEVELS.Block
    : warnings.length > 0
      ? DATA_SEARCH_READINESS_LEVELS.Warning
      : DATA_SEARCH_READINESS_LEVELS.Pass;

  return {
    level,
    ready: blockers.length === 0,
    label: normalizeText(input.label ?? qualitySnapshot.label),
    findings: Object.freeze(findings),
    blockerCodes: Object.freeze(blockers.map(finding => finding.code)),
    warningCodes: Object.freeze(warnings.map(finding => finding.code)),
    quality,
    performance,
    index,
    policy,
    generatedAt: null,
  };
};

export const DataSearchReadinessRuntime = {
  DATA_SEARCH_READINESS_LEVELS,
  normalizeDataSearchReadinessPolicy,
  normalizeSearchIndexReadiness,
  createDataSearchReadinessReport,
};
