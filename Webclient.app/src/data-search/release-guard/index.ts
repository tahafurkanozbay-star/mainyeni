export * from './contracts';
export * from './policy';
export * from './metrics';
export * from './gate';

import {
  RELEASE_GATE_LEVELS,
} from './contracts';
import {
  compareDataQualitySnapshots,
  countSchemaMissingRequiredOccurrences,
  countSchemaUnknownFieldOccurrences,
  createAddressQualityMetrics,
  createDataQualitySnapshot,
  createQualityFingerprint,
  createSchemaQualityMetrics,
  createSearchQualityMetrics,
} from './metrics';
import {
  createReleaseGateSummary,
  evaluateDataReleaseGate,
} from './gate';
import {
  DEFAULT_DATA_RELEASE_POLICY,
  normalizeDataReleasePolicy,
  safeRatio,
} from './policy';

export const DataReleaseGuardRuntime = {
  RELEASE_GATE_LEVELS,
  DEFAULT_DATA_RELEASE_POLICY,
  safeRatio,
  normalizeDataReleasePolicy,
  countSchemaUnknownFieldOccurrences,
  countSchemaMissingRequiredOccurrences,
  createSchemaQualityMetrics,
  createAddressQualityMetrics,
  createSearchQualityMetrics,
  createDataQualitySnapshot,
  evaluateDataReleaseGate,
  compareDataQualitySnapshots,
  createQualityFingerprint,
  createReleaseGateSummary,
};
