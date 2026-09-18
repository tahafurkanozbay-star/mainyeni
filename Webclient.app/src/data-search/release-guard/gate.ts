import {
  RELEASE_GATE_LEVELS,
  type DataQualitySnapshot,
  type DataReleaseGate,
  type ReleaseGateFinding,
  type ReleaseGateLevel,
  type ReleaseGateSummary,
} from './contracts';
import {
  createDataQualitySnapshot,
} from './metrics';
import {
  DEFAULT_DATA_RELEASE_POLICY,
  normalizeDataReleasePolicy,
} from './policy';

const createFinding = (
  level: ReleaseGateLevel,
  code: string,
  metric: string,
  actual: number | boolean,
  threshold: number | boolean,
  message: string,
): ReleaseGateFinding => ({
  level,
  code,
  metric,
  actual,
  threshold,
  message,
});

const evaluateMaxRatio = (
  findings: ReleaseGateFinding[],
  metricName: string,
  actual: number,
  threshold: number,
  blockCode: string,
  warnCode: string,
): void => {
  if (actual > threshold) {
    findings.push(createFinding(
      RELEASE_GATE_LEVELS.Block,
      blockCode,
      metricName,
      actual,
      threshold,
      `${metricName} ${actual.toFixed(4)} allowed maximum ${threshold.toFixed(4)} exceeded`,
    ));
    return;
  }

  const warningThreshold = threshold > 0 ? threshold * 0.8 : 0;
  if (actual > warningThreshold && actual > 0) {
    findings.push(createFinding(
      RELEASE_GATE_LEVELS.Warning,
      warnCode,
      metricName,
      actual,
      threshold,
      `${metricName} is close to the configured release boundary`,
    ));
  }
};

export const evaluateDataReleaseGate = (
  snapshot?: DataQualitySnapshot | null,
  policy: unknown = DEFAULT_DATA_RELEASE_POLICY,
): DataReleaseGate => {
  const normalizedPolicy = normalizeDataReleasePolicy(policy);
  const current = snapshot ?? createDataQualitySnapshot();
  const findings: ReleaseGateFinding[] = [];
  const sampleSize = current.schema.inputCount
    || current.address.total
    || current.search.scannedCount
    || 0;
  const representative = sampleSize >= normalizedPolicy.minimumSampleSize;

  if (!representative && sampleSize > 0) {
    findings.push(createFinding(
      RELEASE_GATE_LEVELS.Warning,
      'sample-size-low',
      'sampleSize',
      sampleSize,
      normalizedPolicy.minimumSampleSize,
      'Quality sample is below the configured representative minimum',
    ));
  }

  if (representative) {
    evaluateMaxRatio(findings, 'schema.rejectedRatio', current.schema.rejectedRatio, normalizedPolicy.maxRejectedRatio, 'rejected-ratio-block', 'rejected-ratio-warning');
    evaluateMaxRatio(findings, 'schema.invalidRatio', current.schema.invalidRatio, normalizedPolicy.maxInvalidRatio, 'invalid-ratio-block', 'invalid-ratio-warning');
    evaluateMaxRatio(findings, 'schema.duplicateRatio', current.schema.duplicateRatio, normalizedPolicy.maxDuplicateRatio, 'duplicate-ratio-block', 'duplicate-ratio-warning');
    evaluateMaxRatio(findings, 'schema.unknownFieldRatio', current.schema.unknownFieldRatio, normalizedPolicy.maxUnknownFieldRatio, 'schema-unknown-field-ratio-block', 'schema-unknown-field-ratio-warning');
    evaluateMaxRatio(findings, 'schema.missingRequiredRatio', current.schema.missingRequiredRatio, normalizedPolicy.maxMissingRequiredRatio, 'missing-required-ratio-block', 'missing-required-ratio-warning');
    evaluateMaxRatio(findings, 'address.hierarchyIssueRatio', current.address.hierarchyIssueRatio, normalizedPolicy.maxHierarchyIssueRatio, 'address-hierarchy-ratio-block', 'address-hierarchy-ratio-warning');
    evaluateMaxRatio(findings, 'search.filteredOutRatio', current.search.filteredOutRatio, normalizedPolicy.maxSearchFilteredOutRatio, 'search-filtered-ratio-block', 'search-filtered-ratio-warning');
  }

  if (current.address.conflictingIds > normalizedPolicy.maxConflictingIds) {
    findings.push(createFinding(
      RELEASE_GATE_LEVELS.Block,
      'conflicting-id-block',
      'address.conflictingIds',
      current.address.conflictingIds,
      normalizedPolicy.maxConflictingIds,
      'Address index contains conflicting identifiers',
    ));
  }

  if (
    current.address.total >= normalizedPolicy.minimumSampleSize
    && current.address.geocodedRatio < normalizedPolicy.minGeocodedRatio
  ) {
    findings.push(createFinding(
      RELEASE_GATE_LEVELS.Block,
      'geocoded-ratio-block',
      'address.geocodedRatio',
      current.address.geocodedRatio,
      normalizedPolicy.minGeocodedRatio,
      'Geocoded coverage is below the configured minimum',
    ));
  }

  if (current.schema.hasDrift) {
    if (normalizedPolicy.blockOnSchemaDrift) {
      findings.push(createFinding(
        RELEASE_GATE_LEVELS.Block,
        'schema-drift-block',
        'schema.hasDrift',
        true,
        false,
        'Schema drift is configured as a release blocker',
      ));
    } else if (normalizedPolicy.warnOnSchemaDrift) {
      findings.push(createFinding(
        RELEASE_GATE_LEVELS.Warning,
        'schema-drift-warning',
        'schema.hasDrift',
        true,
        false,
        'Schema drift was detected and should be reviewed',
      ));
    }
  }

  const blocked = findings.some(finding => finding.level === RELEASE_GATE_LEVELS.Block);
  const warned = findings.some(finding => finding.level === RELEASE_GATE_LEVELS.Warning);

  return {
    level: blocked
      ? RELEASE_GATE_LEVELS.Block
      : warned
        ? RELEASE_GATE_LEVELS.Warning
        : RELEASE_GATE_LEVELS.Pass,
    releasable: !blocked,
    findings,
    policy: normalizedPolicy,
    snapshot: current,
  };
};

export const createReleaseGateSummary = (
  gate?: DataReleaseGate | null,
): ReleaseGateSummary => {
  const result = gate ?? evaluateDataReleaseGate();
  const counts: Record<ReleaseGateLevel, number> = {
    [RELEASE_GATE_LEVELS.Block]: 0,
    [RELEASE_GATE_LEVELS.Warning]: 0,
    [RELEASE_GATE_LEVELS.Pass]: 0,
  };

  for (const finding of result.findings) {
    counts[finding.level] += 1;
  }

  return {
    level: result.level,
    releasable: result.releasable,
    blockerCount: counts[RELEASE_GATE_LEVELS.Block],
    warningCount: counts[RELEASE_GATE_LEVELS.Warning],
    findingCodes: result.findings.map(finding => finding.code),
  };
};
