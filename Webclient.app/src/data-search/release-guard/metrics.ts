import {
  normalizeFiniteNumber,
  normalizeText,
} from '../../Toolbox/DataIntegrityHelper';
import {
  asArray,
  asRecord,
  isRecord,
  type AddressQualityMetrics,
  type CreateDataQualitySnapshotOptions,
  type DataQualityComparison,
  type DataQualitySnapshot,
  type QualityMetricDelta,
  type SchemaQualityMetrics,
  type SearchQualityMetrics,
} from './contracts';
import { safeRatio } from './policy';

const countDriftOccurrences = (drift: unknown, key: string): number =>
  asArray(asRecord(drift)[key]).reduce<number>((total, item) => {
    const count = isRecord(item) ? item.count : 0;
    return total + Math.max(0, normalizeFiniteNumber(count, 0) ?? 0);
  }, 0);

export const countSchemaUnknownFieldOccurrences = (drift: unknown): number =>
  countDriftOccurrences(drift, 'unknownFields');

export const countSchemaMissingRequiredOccurrences = (drift: unknown): number =>
  countDriftOccurrences(drift, 'missingRequired');

export const createSchemaQualityMetrics = (report: unknown): SchemaQualityMetrics => {
  const input = asRecord(report);
  const diagnostics = asRecord(input.diagnostics);
  const drift = asRecord(input.drift);
  const inputCount = Math.max(
    0,
    normalizeFiniteNumber(diagnostics.inputCount ?? drift.totalRecords, 0) ?? 0,
  );
  const rejectedCount = Math.max(0, normalizeFiniteNumber(diagnostics.rejectedCount, 0) ?? 0);
  const invalidCount = Math.max(0, normalizeFiniteNumber(diagnostics.invalidCount, 0) ?? 0);
  const duplicateCount = Math.max(0, normalizeFiniteNumber(diagnostics.duplicateCount, 0) ?? 0);
  const unknownFieldOccurrences = countSchemaUnknownFieldOccurrences(drift);
  const missingRequiredOccurrences = countSchemaMissingRequiredOccurrences(drift);

  return {
    inputCount,
    acceptedCount: Math.max(0, normalizeFiniteNumber(diagnostics.acceptedCount, 0) ?? 0),
    rejectedCount,
    invalidCount,
    duplicateCount,
    rejectedRatio: safeRatio(rejectedCount, inputCount),
    invalidRatio: safeRatio(invalidCount, inputCount),
    duplicateRatio: safeRatio(duplicateCount, inputCount),
    unknownFieldOccurrences,
    unknownFieldRatio: safeRatio(unknownFieldOccurrences, inputCount),
    missingRequiredOccurrences,
    missingRequiredRatio: safeRatio(missingRequiredOccurrences, inputCount),
    hasDrift: drift.hasDrift === true,
  };
};

export const createAddressQualityMetrics = (report: unknown): AddressQualityMetrics => {
  const input = asRecord(report);
  const diagnostics = asRecord(input.diagnostics);
  const total = Math.max(0, normalizeFiniteNumber(input.total, 0) ?? 0);
  const hierarchyIssueCount = Math.max(
    0,
    normalizeFiniteNumber(input.hierarchyIssueCount, 0) ?? 0,
  );

  return {
    total,
    geocodedCount: Math.max(0, normalizeFiniteNumber(input.geocodedCount, 0) ?? 0),
    ungeocodedCount: Math.max(0, normalizeFiniteNumber(input.ungeocodedCount, 0) ?? 0),
    geocodedRatio: Math.min(1, Math.max(0, normalizeFiniteNumber(input.geocodedRatio, 0) ?? 0)),
    hierarchyIssueCount,
    hierarchyIssueRatio: safeRatio(hierarchyIssueCount, total),
    conflictingIds: asArray(diagnostics.conflictingIds).length,
  };
};

export const createSearchQualityMetrics = (response: unknown): SearchQualityMetrics => {
  const diagnostics = asRecord(asRecord(response).diagnostics);
  const scannedCount = Math.max(0, normalizeFiniteNumber(diagnostics.scannedCount, 0) ?? 0);
  const filteredOutCount = Math.max(
    0,
    normalizeFiniteNumber(diagnostics.filteredOutCount, 0) ?? 0,
  );

  return {
    candidateCount: Math.max(0, normalizeFiniteNumber(diagnostics.candidateCount, 0) ?? 0),
    scannedCount,
    matchedCount: Math.max(0, normalizeFiniteNumber(diagnostics.matchedCount, 0) ?? 0),
    filteredOutCount,
    belowScoreCount: Math.max(0, normalizeFiniteNumber(diagnostics.belowScoreCount, 0) ?? 0),
    filteredOutRatio: safeRatio(filteredOutCount, scannedCount),
  };
};

export const createDataQualitySnapshot = ({
  schemaReport = null,
  addressReport = null,
  searchResponse = null,
  label = '',
}: CreateDataQualitySnapshotOptions = {}): DataQualitySnapshot => ({
  label: normalizeText(label),
  schema: createSchemaQualityMetrics(schemaReport),
  address: createAddressQualityMetrics(addressReport),
  search: createSearchQualityMetrics(searchResponse),
});

export const QUALITY_METRIC_PATHS = Object.freeze([
  'schema.rejectedRatio',
  'schema.invalidRatio',
  'schema.duplicateRatio',
  'schema.unknownFieldRatio',
  'schema.missingRequiredRatio',
  'address.geocodedRatio',
  'address.hierarchyIssueRatio',
  'address.conflictingIds',
  'search.filteredOutRatio',
] as const);

const readPath = (value: unknown, path: string): unknown =>
  path.split('.').reduce<unknown>((current, key) => (
    isRecord(current) ? current[key] : undefined
  ), value);

const classifyMetric = (metric: QualityMetricDelta, regression: boolean): boolean => {
  const geocoded = metric.path === 'address.geocodedRatio';
  return regression
    ? geocoded ? metric.delta < 0 : metric.delta > 0
    : geocoded ? metric.delta > 0 : metric.delta < 0;
};

export const compareDataQualitySnapshots = (
  baseline: DataQualitySnapshot | null | undefined,
  current: DataQualitySnapshot | null | undefined,
): DataQualityComparison => {
  const before = baseline ?? createDataQualitySnapshot();
  const after = current ?? createDataQualitySnapshot();
  const metrics = QUALITY_METRIC_PATHS.map<QualityMetricDelta>(path => {
    const baselineValue = normalizeFiniteNumber(readPath(before, path), 0) ?? 0;
    const currentValue = normalizeFiniteNumber(readPath(after, path), 0) ?? 0;
    return {
      path,
      baseline: baselineValue,
      current: currentValue,
      delta: currentValue - baselineValue,
    };
  });

  return {
    baselineLabel: normalizeText(before.label),
    currentLabel: normalizeText(after.label),
    metrics,
    regressions: metrics.filter(metric => classifyMetric(metric, true)),
    improvements: metrics.filter(metric => classifyMetric(metric, false)),
  };
};

export const createQualityFingerprint = (
  snapshot: DataQualitySnapshot | null | undefined,
): string => {
  const current = snapshot ?? createDataQualitySnapshot();
  const values = QUALITY_METRIC_PATHS.map(path => {
    const value = readPath(current, path);
    return typeof value === 'number' ? value.toFixed(6) : String(value ?? '');
  });

  return [
    normalizeText(current.label),
    `input=${current.schema.inputCount}`,
    `address=${current.address.total}`,
    ...values,
  ].join('|');
};
