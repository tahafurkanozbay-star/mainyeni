import {
  normalizeFiniteNumber,
  normalizeInteger,
} from '../../Toolbox/DataIntegrityHelper';
import {
  asRecord,
  type DataReleasePolicy,
} from './contracts';

export const DEFAULT_DATA_RELEASE_POLICY: Readonly<DataReleasePolicy> = Object.freeze({
  maxRejectedRatio: 0.02,
  maxInvalidRatio: 0.01,
  maxDuplicateRatio: 0.02,
  maxUnknownFieldRatio: 0.05,
  maxMissingRequiredRatio: 0,
  maxHierarchyIssueRatio: 0.02,
  maxConflictingIds: 0,
  minGeocodedRatio: 0,
  maxSearchFilteredOutRatio: 1,
  blockOnSchemaDrift: false,
  warnOnSchemaDrift: true,
  minimumSampleSize: 10,
});

const clampRatio = (value: unknown): number =>
  Math.min(1, Math.max(0, normalizeFiniteNumber(value, 0) ?? 0));

export const safeRatio = (numerator: unknown, denominator: unknown): number => {
  const top = Math.max(0, normalizeFiniteNumber(numerator, 0) ?? 0);
  const bottom = Math.max(0, normalizeFiniteNumber(denominator, 0) ?? 0);
  return bottom > 0 ? top / bottom : 0;
};

export const normalizeDataReleasePolicy = (policy: unknown): DataReleasePolicy => {
  const input = asRecord(policy);
  return {
    maxRejectedRatio: clampRatio(input.maxRejectedRatio ?? DEFAULT_DATA_RELEASE_POLICY.maxRejectedRatio),
    maxInvalidRatio: clampRatio(input.maxInvalidRatio ?? DEFAULT_DATA_RELEASE_POLICY.maxInvalidRatio),
    maxDuplicateRatio: clampRatio(input.maxDuplicateRatio ?? DEFAULT_DATA_RELEASE_POLICY.maxDuplicateRatio),
    maxUnknownFieldRatio: clampRatio(input.maxUnknownFieldRatio ?? DEFAULT_DATA_RELEASE_POLICY.maxUnknownFieldRatio),
    maxMissingRequiredRatio: clampRatio(input.maxMissingRequiredRatio ?? DEFAULT_DATA_RELEASE_POLICY.maxMissingRequiredRatio),
    maxHierarchyIssueRatio: clampRatio(input.maxHierarchyIssueRatio ?? DEFAULT_DATA_RELEASE_POLICY.maxHierarchyIssueRatio),
    maxConflictingIds: normalizeInteger(input.maxConflictingIds, {
      min: 0,
      fallback: DEFAULT_DATA_RELEASE_POLICY.maxConflictingIds,
    }) ?? DEFAULT_DATA_RELEASE_POLICY.maxConflictingIds,
    minGeocodedRatio: clampRatio(input.minGeocodedRatio ?? DEFAULT_DATA_RELEASE_POLICY.minGeocodedRatio),
    maxSearchFilteredOutRatio: clampRatio(
      input.maxSearchFilteredOutRatio ?? DEFAULT_DATA_RELEASE_POLICY.maxSearchFilteredOutRatio,
    ),
    blockOnSchemaDrift: input.blockOnSchemaDrift === true,
    warnOnSchemaDrift: input.warnOnSchemaDrift !== false,
    minimumSampleSize: normalizeInteger(input.minimumSampleSize, {
      min: 0,
      fallback: DEFAULT_DATA_RELEASE_POLICY.minimumSampleSize,
    }) ?? DEFAULT_DATA_RELEASE_POLICY.minimumSampleSize,
  };
};
