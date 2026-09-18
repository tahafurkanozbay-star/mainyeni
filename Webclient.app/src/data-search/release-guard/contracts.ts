export const RELEASE_GATE_LEVELS = Object.freeze({
  Pass: 'pass',
  Warning: 'warning',
  Block: 'block',
} as const);

export type ReleaseGateLevel =
  typeof RELEASE_GATE_LEVELS[keyof typeof RELEASE_GATE_LEVELS];

export interface DataReleasePolicy {
  maxRejectedRatio: number;
  maxInvalidRatio: number;
  maxDuplicateRatio: number;
  maxUnknownFieldRatio: number;
  maxMissingRequiredRatio: number;
  maxHierarchyIssueRatio: number;
  maxConflictingIds: number;
  minGeocodedRatio: number;
  maxSearchFilteredOutRatio: number;
  blockOnSchemaDrift: boolean;
  warnOnSchemaDrift: boolean;
  minimumSampleSize: number;
}

export interface SchemaQualityMetrics {
  inputCount: number;
  acceptedCount: number;
  rejectedCount: number;
  invalidCount: number;
  duplicateCount: number;
  rejectedRatio: number;
  invalidRatio: number;
  duplicateRatio: number;
  unknownFieldOccurrences: number;
  unknownFieldRatio: number;
  missingRequiredOccurrences: number;
  missingRequiredRatio: number;
  hasDrift: boolean;
}

export interface AddressQualityMetrics {
  total: number;
  geocodedCount: number;
  ungeocodedCount: number;
  geocodedRatio: number;
  hierarchyIssueCount: number;
  hierarchyIssueRatio: number;
  conflictingIds: number;
}

export interface SearchQualityMetrics {
  candidateCount: number;
  scannedCount: number;
  matchedCount: number;
  filteredOutCount: number;
  belowScoreCount: number;
  filteredOutRatio: number;
}

export interface DataQualitySnapshot {
  label: string;
  schema: SchemaQualityMetrics;
  address: AddressQualityMetrics;
  search: SearchQualityMetrics;
}

export interface CreateDataQualitySnapshotOptions {
  schemaReport?: unknown;
  addressReport?: unknown;
  searchResponse?: unknown;
  label?: unknown;
}

export interface ReleaseGateFinding {
  level: ReleaseGateLevel;
  code: string;
  metric: string;
  actual: number | boolean;
  threshold: number | boolean;
  message: string;
}

export interface DataReleaseGate {
  level: ReleaseGateLevel;
  releasable: boolean;
  findings: readonly ReleaseGateFinding[];
  policy: DataReleasePolicy;
  snapshot: DataQualitySnapshot;
}

export interface QualityMetricDelta {
  path: string;
  baseline: number;
  current: number;
  delta: number;
}

export interface DataQualityComparison {
  baselineLabel: string;
  currentLabel: string;
  metrics: readonly QualityMetricDelta[];
  regressions: readonly QualityMetricDelta[];
  improvements: readonly QualityMetricDelta[];
}

export interface ReleaseGateSummary {
  level: ReleaseGateLevel;
  releasable: boolean;
  blockerCount: number;
  warningCount: number;
  findingCodes: readonly string[];
}

export type UnknownRecord = Record<string, unknown>;

export const isRecord = (value: unknown): value is UnknownRecord =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export const asRecord = (value: unknown): UnknownRecord =>
  isRecord(value) ? value : {};

export const asArray = (value: unknown): readonly unknown[] =>
  Array.isArray(value) ? value : [];
