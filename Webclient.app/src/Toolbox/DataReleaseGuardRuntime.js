import { normalizeFiniteNumber, normalizeInteger, normalizeText } from "./DataIntegrityHelper";

export const RELEASE_GATE_LEVELS = Object.freeze({
    Pass: "pass",
    Warning: "warning",
    Block: "block"
});

export const DEFAULT_DATA_RELEASE_POLICY = Object.freeze({
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
    minimumSampleSize: 10
});

const clampRatio = value => Math.min(1, Math.max(0, normalizeFiniteNumber(value, 0) || 0));
const asArray = value => Array.isArray(value) ? value : [];

export const safeRatio = (numerator, denominator) => {
    const top = Math.max(0, normalizeFiniteNumber(numerator, 0) || 0);
    const bottom = Math.max(0, normalizeFiniteNumber(denominator, 0) || 0);
    return bottom > 0 ? top / bottom : 0;
};

export const normalizeDataReleasePolicy = policy => {
    const input = policy && typeof policy === "object" ? policy : {};
    const normalized = { ...DEFAULT_DATA_RELEASE_POLICY, ...input };
    [
        "maxRejectedRatio",
        "maxInvalidRatio",
        "maxDuplicateRatio",
        "maxUnknownFieldRatio",
        "maxMissingRequiredRatio",
        "maxHierarchyIssueRatio",
        "minGeocodedRatio",
        "maxSearchFilteredOutRatio"
    ].forEach(key => {
        normalized[key] = clampRatio(normalized[key]);
    });
    normalized.maxConflictingIds = normalizeInteger(normalized.maxConflictingIds, {
        min: 0,
        fallback: DEFAULT_DATA_RELEASE_POLICY.maxConflictingIds
    });
    normalized.minimumSampleSize = normalizeInteger(normalized.minimumSampleSize, {
        min: 0,
        fallback: DEFAULT_DATA_RELEASE_POLICY.minimumSampleSize
    });
    normalized.blockOnSchemaDrift = normalized.blockOnSchemaDrift === true;
    normalized.warnOnSchemaDrift = normalized.warnOnSchemaDrift !== false;
    return normalized;
};

export const countSchemaUnknownFieldOccurrences = drift => asArray(drift?.unknownFields)
    .reduce((total, item) => total + Math.max(0, normalizeFiniteNumber(item?.count, 0) || 0), 0);

export const countSchemaMissingRequiredOccurrences = drift => asArray(drift?.missingRequired)
    .reduce((total, item) => total + Math.max(0, normalizeFiniteNumber(item?.count, 0) || 0), 0);

export const createSchemaQualityMetrics = report => {
    const diagnostics = report?.diagnostics || {};
    const drift = report?.drift || {};
    const inputCount = Math.max(0, normalizeFiniteNumber(diagnostics.inputCount ?? drift.totalRecords, 0) || 0);
    const rejectedCount = Math.max(0, normalizeFiniteNumber(diagnostics.rejectedCount, 0) || 0);
    const invalidCount = Math.max(0, normalizeFiniteNumber(diagnostics.invalidCount, 0) || 0);
    const duplicateCount = Math.max(0, normalizeFiniteNumber(diagnostics.duplicateCount, 0) || 0);
    const unknownFieldOccurrences = countSchemaUnknownFieldOccurrences(drift);
    const missingRequiredOccurrences = countSchemaMissingRequiredOccurrences(drift);
    return {
        inputCount,
        acceptedCount: Math.max(0, normalizeFiniteNumber(diagnostics.acceptedCount, 0) || 0),
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
        hasDrift: drift.hasDrift === true
    };
};

export const createAddressQualityMetrics = report => {
    const total = Math.max(0, normalizeFiniteNumber(report?.total, 0) || 0);
    const hierarchyIssueCount = Math.max(0, normalizeFiniteNumber(report?.hierarchyIssueCount, 0) || 0);
    const conflictingIds = asArray(report?.diagnostics?.conflictingIds).length;
    return {
        total,
        geocodedCount: Math.max(0, normalizeFiniteNumber(report?.geocodedCount, 0) || 0),
        ungeocodedCount: Math.max(0, normalizeFiniteNumber(report?.ungeocodedCount, 0) || 0),
        geocodedRatio: clampRatio(report?.geocodedRatio),
        hierarchyIssueCount,
        hierarchyIssueRatio: safeRatio(hierarchyIssueCount, total),
        conflictingIds
    };
};

export const createSearchQualityMetrics = response => {
    const diagnostics = response?.diagnostics || {};
    const scannedCount = Math.max(0, normalizeFiniteNumber(diagnostics.scannedCount, 0) || 0);
    const filteredOutCount = Math.max(0, normalizeFiniteNumber(diagnostics.filteredOutCount, 0) || 0);
    return {
        candidateCount: Math.max(0, normalizeFiniteNumber(diagnostics.candidateCount, 0) || 0),
        scannedCount,
        matchedCount: Math.max(0, normalizeFiniteNumber(diagnostics.matchedCount, 0) || 0),
        filteredOutCount,
        belowScoreCount: Math.max(0, normalizeFiniteNumber(diagnostics.belowScoreCount, 0) || 0),
        filteredOutRatio: safeRatio(filteredOutCount, scannedCount)
    };
};

export const createDataQualitySnapshot = ({
    schemaReport = null,
    addressReport = null,
    searchResponse = null,
    label = ""
} = {}) => ({
    label: normalizeText(label),
    schema: createSchemaQualityMetrics(schemaReport),
    address: createAddressQualityMetrics(addressReport),
    search: createSearchQualityMetrics(searchResponse)
});

const createFinding = (level, code, metric, actual, threshold, message) => ({
    level,
    code,
    metric,
    actual,
    threshold,
    message
});

const evaluateMaxRatio = (findings, metricName, actual, threshold, blockCode, warnCode) => {
    if (actual > threshold) {
        findings.push(createFinding(RELEASE_GATE_LEVELS.Block, blockCode, metricName, actual, threshold, `${metricName} ${actual.toFixed(4)} allowed maximum ${threshold.toFixed(4)} exceeded`));
        return;
    }
    const warningThreshold = threshold > 0 ? threshold * 0.8 : 0;
    if (actual > warningThreshold && actual > 0) {
        findings.push(createFinding(RELEASE_GATE_LEVELS.Warning, warnCode, metricName, actual, threshold, `${metricName} is close to the configured release boundary`));
    }
};

export const evaluateDataReleaseGate = (snapshot, policy = DEFAULT_DATA_RELEASE_POLICY) => {
    const normalizedPolicy = normalizeDataReleasePolicy(policy);
    const current = snapshot || createDataQualitySnapshot();
    const findings = [];
    const sampleSize = current.schema.inputCount || current.address.total || current.search.scannedCount || 0;
    const sampleIsRepresentative = sampleSize >= normalizedPolicy.minimumSampleSize;

    if (!sampleIsRepresentative && sampleSize > 0) {
        findings.push(createFinding(RELEASE_GATE_LEVELS.Warning, "sample-size-low", "sampleSize", sampleSize, normalizedPolicy.minimumSampleSize, "Quality sample is below the configured representative minimum"));
    }

    if (sampleIsRepresentative) {
        evaluateMaxRatio(findings, "schema.rejectedRatio", current.schema.rejectedRatio, normalizedPolicy.maxRejectedRatio, "rejected-ratio-block", "rejected-ratio-warning");
        evaluateMaxRatio(findings, "schema.invalidRatio", current.schema.invalidRatio, normalizedPolicy.maxInvalidRatio, "invalid-ratio-block", "invalid-ratio-warning");
        evaluateMaxRatio(findings, "schema.duplicateRatio", current.schema.duplicateRatio, normalizedPolicy.maxDuplicateRatio, "duplicate-ratio-block", "duplicate-ratio-warning");
        evaluateMaxRatio(findings, "schema.unknownFieldRatio", current.schema.unknownFieldRatio, normalizedPolicy.maxUnknownFieldRatio, "schema-unknown-field-ratio-block", "schema-unknown-field-ratio-warning");
        evaluateMaxRatio(findings, "schema.missingRequiredRatio", current.schema.missingRequiredRatio, normalizedPolicy.maxMissingRequiredRatio, "missing-required-ratio-block", "missing-required-ratio-warning");
        evaluateMaxRatio(findings, "address.hierarchyIssueRatio", current.address.hierarchyIssueRatio, normalizedPolicy.maxHierarchyIssueRatio, "address-hierarchy-ratio-block", "address-hierarchy-ratio-warning");
        evaluateMaxRatio(findings, "search.filteredOutRatio", current.search.filteredOutRatio, normalizedPolicy.maxSearchFilteredOutRatio, "search-filtered-ratio-block", "search-filtered-ratio-warning");
    }

    if (current.address.conflictingIds > normalizedPolicy.maxConflictingIds) {
        findings.push(createFinding(RELEASE_GATE_LEVELS.Block, "conflicting-id-block", "address.conflictingIds", current.address.conflictingIds, normalizedPolicy.maxConflictingIds, "Address index contains conflicting identifiers"));
    }

    if (current.address.total >= normalizedPolicy.minimumSampleSize && current.address.geocodedRatio < normalizedPolicy.minGeocodedRatio) {
        findings.push(createFinding(RELEASE_GATE_LEVELS.Block, "geocoded-ratio-block", "address.geocodedRatio", current.address.geocodedRatio, normalizedPolicy.minGeocodedRatio, "Geocoded coverage is below the configured minimum"));
    }

    if (current.schema.hasDrift) {
        if (normalizedPolicy.blockOnSchemaDrift) {
            findings.push(createFinding(RELEASE_GATE_LEVELS.Block, "schema-drift-block", "schema.hasDrift", true, false, "Schema drift is configured as a release blocker"));
        } else if (normalizedPolicy.warnOnSchemaDrift) {
            findings.push(createFinding(RELEASE_GATE_LEVELS.Warning, "schema-drift-warning", "schema.hasDrift", true, false, "Schema drift was detected and should be reviewed"));
        }
    }

    const blocked = findings.some(finding => finding.level === RELEASE_GATE_LEVELS.Block);
    const warned = findings.some(finding => finding.level === RELEASE_GATE_LEVELS.Warning);
    return {
        level: blocked ? RELEASE_GATE_LEVELS.Block : warned ? RELEASE_GATE_LEVELS.Warning : RELEASE_GATE_LEVELS.Pass,
        releasable: !blocked,
        findings,
        policy: normalizedPolicy,
        snapshot: current
    };
};

const metricPaths = [
    "schema.rejectedRatio",
    "schema.invalidRatio",
    "schema.duplicateRatio",
    "schema.unknownFieldRatio",
    "schema.missingRequiredRatio",
    "address.geocodedRatio",
    "address.hierarchyIssueRatio",
    "address.conflictingIds",
    "search.filteredOutRatio"
];

const readPath = (value, path) => path.split(".").reduce((current, key) => current?.[key], value);

export const compareDataQualitySnapshots = (baseline, current) => {
    const before = baseline || createDataQualitySnapshot();
    const after = current || createDataQualitySnapshot();
    const metrics = metricPaths.map(path => {
        const baselineValue = normalizeFiniteNumber(readPath(before, path), 0) || 0;
        const currentValue = normalizeFiniteNumber(readPath(after, path), 0) || 0;
        return { path, baseline: baselineValue, current: currentValue, delta: currentValue - baselineValue };
    });
    return {
        baselineLabel: normalizeText(before.label),
        currentLabel: normalizeText(after.label),
        metrics,
        regressions: metrics.filter(metric => metric.path === "address.geocodedRatio" ? metric.delta < 0 : metric.delta > 0),
        improvements: metrics.filter(metric => metric.path === "address.geocodedRatio" ? metric.delta > 0 : metric.delta < 0)
    };
};

export const createQualityFingerprint = snapshot => {
    const current = snapshot || createDataQualitySnapshot();
    const values = metricPaths.map(path => {
        const value = readPath(current, path);
        return typeof value === "number" ? value.toFixed(6) : String(value ?? "");
    });
    return [normalizeText(current.label), `input=${current.schema.inputCount}`, `address=${current.address.total}`, ...values].join("|");
};

export const createReleaseGateSummary = gate => {
    const result = gate || evaluateDataReleaseGate();
    const counts = result.findings.reduce((accumulator, finding) => ({
        ...accumulator,
        [finding.level]: (accumulator[finding.level] || 0) + 1
    }), { [RELEASE_GATE_LEVELS.Block]: 0, [RELEASE_GATE_LEVELS.Warning]: 0, [RELEASE_GATE_LEVELS.Pass]: 0 });
    return {
        level: result.level,
        releasable: result.releasable,
        blockerCount: counts[RELEASE_GATE_LEVELS.Block],
        warningCount: counts[RELEASE_GATE_LEVELS.Warning],
        findingCodes: result.findings.map(finding => finding.code)
    };
};

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
    createReleaseGateSummary
};
