import {
    DEFAULT_DATA_RELEASE_POLICY,
    RELEASE_GATE_LEVELS,
    compareDataQualitySnapshots,
    countSchemaMissingRequiredOccurrences,
    countSchemaUnknownFieldOccurrences,
    createAddressQualityMetrics,
    createDataQualitySnapshot,
    createQualityFingerprint,
    createReleaseGateSummary,
    createSchemaQualityMetrics,
    createSearchQualityMetrics,
    evaluateDataReleaseGate,
    normalizeDataReleasePolicy,
    safeRatio
} from "./DataReleaseGuardRuntime";

const healthySchemaReport = {
    diagnostics: { inputCount: 100, acceptedCount: 99, rejectedCount: 1, duplicateCount: 1, invalidCount: 0 },
    drift: { totalRecords: 100, unknownFields: [], missingRequired: [], hasDrift: false }
};

const healthyAddressReport = {
    total: 100,
    geocodedCount: 95,
    ungeocodedCount: 5,
    geocodedRatio: 0.95,
    hierarchyIssueCount: 1,
    diagnostics: { conflictingIds: [] }
};

const healthySearchResponse = {
    diagnostics: { candidateCount: 100, scannedCount: 100, matchedCount: 80, filteredOutCount: 20, belowScoreCount: 0 }
};

describe("DataReleaseGuardRuntime", () => {
    describe("ratio and policy normalization", () => {
        test("computes safe ratios", () => {
            expect(safeRatio(5, 10)).toBe(0.5);
            expect(safeRatio(0, 10)).toBe(0);
        });

        test("returns zero for an empty denominator", () => {
            expect(safeRatio(10, 0)).toBe(0);
            expect(safeRatio(10, null)).toBe(0);
        });

        test("normalizes negative counts to zero", () => {
            expect(safeRatio(-1, 10)).toBe(0);
            expect(safeRatio(1, -10)).toBe(0);
        });

        test("keeps default policy stable", () => {
            const policy = normalizeDataReleasePolicy();
            expect(policy.maxRejectedRatio).toBe(DEFAULT_DATA_RELEASE_POLICY.maxRejectedRatio);
            expect(policy.blockOnSchemaDrift).toBe(false);
            expect(policy.warnOnSchemaDrift).toBe(true);
        });

        test("clamps ratio thresholds", () => {
            const policy = normalizeDataReleasePolicy({ maxRejectedRatio: 5, maxInvalidRatio: -1, minGeocodedRatio: 2 });
            expect(policy.maxRejectedRatio).toBe(1);
            expect(policy.maxInvalidRatio).toBe(0);
            expect(policy.minGeocodedRatio).toBe(1);
        });

        test("normalizes count thresholds", () => {
            const policy = normalizeDataReleasePolicy({ maxConflictingIds: -10, minimumSampleSize: -20 });
            expect(policy.maxConflictingIds).toBe(0);
            expect(policy.minimumSampleSize).toBe(0);
        });

        test("honors explicit drift policy flags", () => {
            const policy = normalizeDataReleasePolicy({ blockOnSchemaDrift: true, warnOnSchemaDrift: false });
            expect(policy.blockOnSchemaDrift).toBe(true);
            expect(policy.warnOnSchemaDrift).toBe(false);
        });
    });

    describe("schema metrics", () => {
        test("counts unknown field occurrences", () => {
            expect(countSchemaUnknownFieldOccurrences({ unknownFields: [{ name: "legacy", count: 3 }, { name: "unexpected", count: 2 }] })).toBe(5);
        });

        test("counts missing required occurrences", () => {
            expect(countSchemaMissingRequiredOccurrences({ missingRequired: [{ name: "title", count: 4 }, { name: "id", count: 1 }] })).toBe(5);
        });

        test("creates schema ratios", () => {
            const metrics = createSchemaQualityMetrics({
                diagnostics: { inputCount: 100, acceptedCount: 90, rejectedCount: 10, invalidCount: 4, duplicateCount: 6 },
                drift: { totalRecords: 100, unknownFields: [{ name: "legacy", count: 5 }], missingRequired: [{ name: "title", count: 2 }], hasDrift: true }
            });
            expect(metrics.rejectedRatio).toBe(0.1);
            expect(metrics.invalidRatio).toBe(0.04);
            expect(metrics.duplicateRatio).toBe(0.06);
            expect(metrics.unknownFieldRatio).toBe(0.05);
            expect(metrics.missingRequiredRatio).toBe(0.02);
            expect(metrics.hasDrift).toBe(true);
        });

        test("uses drift total when diagnostics input is absent", () => {
            expect(createSchemaQualityMetrics({ diagnostics: {}, drift: { totalRecords: 20, unknownFields: [], missingRequired: [] } }).inputCount).toBe(20);
        });

        test("handles empty reports", () => {
            const metrics = createSchemaQualityMetrics(null);
            expect(metrics.inputCount).toBe(0);
            expect(metrics.rejectedRatio).toBe(0);
            expect(metrics.hasDrift).toBe(false);
        });
    });

    describe("address metrics", () => {
        test("creates normalized address metrics", () => {
            const metrics = createAddressQualityMetrics({ total: 50, geocodedCount: 40, ungeocodedCount: 10, geocodedRatio: 0.8, hierarchyIssueCount: 5, diagnostics: { conflictingIds: ["x", "y"] } });
            expect(metrics.total).toBe(50);
            expect(metrics.geocodedRatio).toBe(0.8);
            expect(metrics.hierarchyIssueRatio).toBe(0.1);
            expect(metrics.conflictingIds).toBe(2);
        });

        test("clamps malformed geocoded ratios", () => {
            expect(createAddressQualityMetrics({ total: 1, geocodedRatio: 9 }).geocodedRatio).toBe(1);
        });

        test("handles missing diagnostics", () => {
            expect(createAddressQualityMetrics({ total: 10 }).conflictingIds).toBe(0);
        });
    });

    describe("search metrics", () => {
        test("creates search filtering ratio", () => {
            const metrics = createSearchQualityMetrics({ diagnostics: { candidateCount: 100, scannedCount: 80, matchedCount: 40, filteredOutCount: 20, belowScoreCount: 20 } });
            expect(metrics.candidateCount).toBe(100);
            expect(metrics.filteredOutRatio).toBe(0.25);
        });

        test("handles empty search diagnostics", () => {
            expect(createSearchQualityMetrics(null)).toEqual({ candidateCount: 0, scannedCount: 0, matchedCount: 0, filteredOutCount: 0, belowScoreCount: 0, filteredOutRatio: 0 });
        });
    });

    describe("quality snapshots", () => {
        test("combines schema, address and search metrics", () => {
            const snapshot = createDataQualitySnapshot({ schemaReport: healthySchemaReport, addressReport: healthyAddressReport, searchResponse: healthySearchResponse, label: " candidate " });
            expect(snapshot.label).toBe("candidate");
            expect(snapshot.schema.inputCount).toBe(100);
            expect(snapshot.address.geocodedRatio).toBe(0.95);
            expect(snapshot.search.filteredOutRatio).toBe(0.2);
        });

        test("creates an empty snapshot without throwing", () => {
            const snapshot = createDataQualitySnapshot({});
            expect(snapshot.schema.inputCount).toBe(0);
            expect(snapshot.address.total).toBe(0);
            expect(snapshot.search.scannedCount).toBe(0);
        });
    });

    describe("release gate", () => {
        test("passes a healthy representative sample", () => {
            const snapshot = createDataQualitySnapshot({ schemaReport: healthySchemaReport, addressReport: healthyAddressReport, searchResponse: healthySearchResponse });
            const gate = evaluateDataReleaseGate(snapshot, { maxRejectedRatio: 0.02, maxDuplicateRatio: 0.02, maxHierarchyIssueRatio: 0.02, minGeocodedRatio: 0.9, maxSearchFilteredOutRatio: 0.5 });
            expect(gate.releasable).toBe(true);
            expect(gate.level).toBe(RELEASE_GATE_LEVELS.Pass);
            expect(gate.findings).toHaveLength(0);
        });

        test("blocks excessive rejection ratios", () => {
            const snapshot = createDataQualitySnapshot({ schemaReport: { ...healthySchemaReport, diagnostics: { ...healthySchemaReport.diagnostics, rejectedCount: 10 } } });
            const gate = evaluateDataReleaseGate(snapshot, { maxRejectedRatio: 0.05 });
            expect(gate.releasable).toBe(false);
            expect(gate.findings.some(item => item.code === "rejected-ratio-block")).toBe(true);
        });

        test("blocks excessive invalid ratios", () => {
            const snapshot = createDataQualitySnapshot({ schemaReport: { ...healthySchemaReport, diagnostics: { ...healthySchemaReport.diagnostics, invalidCount: 5 } } });
            expect(evaluateDataReleaseGate(snapshot, { maxInvalidRatio: 0.01 }).findings.some(item => item.code === "invalid-ratio-block")).toBe(true);
        });

        test("blocks excessive duplicate ratios", () => {
            const snapshot = createDataQualitySnapshot({ schemaReport: { ...healthySchemaReport, diagnostics: { ...healthySchemaReport.diagnostics, duplicateCount: 8 } } });
            expect(evaluateDataReleaseGate(snapshot, { maxDuplicateRatio: 0.02 }).findings.some(item => item.code === "duplicate-ratio-block")).toBe(true);
        });

        test("blocks unknown field ratio regressions", () => {
            const snapshot = createDataQualitySnapshot({ schemaReport: { diagnostics: healthySchemaReport.diagnostics, drift: { totalRecords: 100, unknownFields: [{ name: "renamed", count: 20 }], missingRequired: [], hasDrift: true } } });
            expect(evaluateDataReleaseGate(snapshot, { maxUnknownFieldRatio: 0.05, warnOnSchemaDrift: false }).findings.some(item => item.code === "schema-unknown-field-ratio-block")).toBe(true);
        });

        test("blocks missing required fields", () => {
            const snapshot = createDataQualitySnapshot({ schemaReport: { diagnostics: healthySchemaReport.diagnostics, drift: { totalRecords: 100, unknownFields: [], missingRequired: [{ name: "title", count: 1 }], hasDrift: true } } });
            expect(evaluateDataReleaseGate(snapshot, { maxMissingRequiredRatio: 0 }).findings.some(item => item.code === "missing-required-ratio-block")).toBe(true);
        });

        test("blocks hierarchy issue regressions", () => {
            const snapshot = createDataQualitySnapshot({ addressReport: { ...healthyAddressReport, hierarchyIssueCount: 20 } });
            expect(evaluateDataReleaseGate(snapshot, { maxHierarchyIssueRatio: 0.05 }).findings.some(item => item.code === "address-hierarchy-ratio-block")).toBe(true);
        });

        test("blocks conflicting identifiers", () => {
            const snapshot = createDataQualitySnapshot({ addressReport: { ...healthyAddressReport, diagnostics: { conflictingIds: ["1", "2"] } } });
            expect(evaluateDataReleaseGate(snapshot, { maxConflictingIds: 0 }).findings.some(item => item.code === "conflicting-id-block")).toBe(true);
        });

        test("blocks insufficient geocoded coverage", () => {
            const snapshot = createDataQualitySnapshot({ addressReport: { ...healthyAddressReport, geocodedRatio: 0.5 } });
            expect(evaluateDataReleaseGate(snapshot, { minGeocodedRatio: 0.8 }).findings.some(item => item.code === "geocoded-ratio-block")).toBe(true);
        });

        test("blocks excessive search filtering when configured", () => {
            const snapshot = createDataQualitySnapshot({ schemaReport: healthySchemaReport, searchResponse: { diagnostics: { scannedCount: 100, filteredOutCount: 95 } } });
            expect(evaluateDataReleaseGate(snapshot, { maxSearchFilteredOutRatio: 0.9 }).findings.some(item => item.code === "search-filtered-ratio-block")).toBe(true);
        });

        test("warns on schema drift by default", () => {
            const snapshot = createDataQualitySnapshot({ schemaReport: { diagnostics: healthySchemaReport.diagnostics, drift: { totalRecords: 100, unknownFields: [], missingRequired: [], hasDrift: true } } });
            const gate = evaluateDataReleaseGate(snapshot, { maxUnknownFieldRatio: 1, maxMissingRequiredRatio: 1 });
            expect(gate.releasable).toBe(true);
            expect(gate.level).toBe(RELEASE_GATE_LEVELS.Warning);
            expect(gate.findings.some(item => item.code === "schema-drift-warning")).toBe(true);
        });

        test("can block all schema drift", () => {
            const snapshot = createDataQualitySnapshot({ schemaReport: { diagnostics: healthySchemaReport.diagnostics, drift: { totalRecords: 100, unknownFields: [], missingRequired: [], hasDrift: true } } });
            const gate = evaluateDataReleaseGate(snapshot, { blockOnSchemaDrift: true });
            expect(gate.releasable).toBe(false);
            expect(gate.findings.some(item => item.code === "schema-drift-block")).toBe(true);
        });

        test("warns when sample size is too small", () => {
            const snapshot = createDataQualitySnapshot({ schemaReport: { diagnostics: { inputCount: 2, acceptedCount: 2 }, drift: { totalRecords: 2, unknownFields: [], missingRequired: [] } } });
            const gate = evaluateDataReleaseGate(snapshot, { minimumSampleSize: 10 });
            expect(gate.releasable).toBe(true);
            expect(gate.findings.some(item => item.code === "sample-size-low")).toBe(true);
        });

        test("does not apply ratio blockers to tiny samples", () => {
            const snapshot = createDataQualitySnapshot({ schemaReport: { diagnostics: { inputCount: 2, acceptedCount: 1, rejectedCount: 1 }, drift: { totalRecords: 2, unknownFields: [], missingRequired: [] } } });
            expect(evaluateDataReleaseGate(snapshot, { minimumSampleSize: 10, maxRejectedRatio: 0 }).findings.some(item => item.code === "rejected-ratio-block")).toBe(false);
        });

        test("emits warning near a nonzero boundary", () => {
            const snapshot = createDataQualitySnapshot({ schemaReport: { diagnostics: { inputCount: 100, acceptedCount: 91, rejectedCount: 9 }, drift: { totalRecords: 100, unknownFields: [], missingRequired: [] } } });
            const gate = evaluateDataReleaseGate(snapshot, { maxRejectedRatio: 0.1 });
            expect(gate.releasable).toBe(true);
            expect(gate.findings.some(item => item.code === "rejected-ratio-warning")).toBe(true);
        });
    });

    describe("baseline comparisons", () => {
        test("detects quality regressions", () => {
            const baseline = createDataQualitySnapshot({ schemaReport: healthySchemaReport, addressReport: healthyAddressReport, label: "baseline" });
            const current = createDataQualitySnapshot({ schemaReport: { ...healthySchemaReport, diagnostics: { ...healthySchemaReport.diagnostics, rejectedCount: 5 } }, addressReport: { ...healthyAddressReport, geocodedRatio: 0.9 }, label: "candidate" });
            const comparison = compareDataQualitySnapshots(baseline, current);
            expect(comparison.baselineLabel).toBe("baseline");
            expect(comparison.currentLabel).toBe("candidate");
            expect(comparison.regressions.some(item => item.path === "schema.rejectedRatio")).toBe(true);
            expect(comparison.regressions.some(item => item.path === "address.geocodedRatio")).toBe(true);
        });

        test("detects quality improvements", () => {
            const baseline = createDataQualitySnapshot({ schemaReport: { ...healthySchemaReport, diagnostics: { ...healthySchemaReport.diagnostics, rejectedCount: 10 } } });
            const current = createDataQualitySnapshot({ schemaReport: healthySchemaReport });
            expect(compareDataQualitySnapshots(baseline, current).improvements.some(item => item.path === "schema.rejectedRatio")).toBe(true);
        });

        test("produces a deterministic quality fingerprint", () => {
            const snapshot = createDataQualitySnapshot({ schemaReport: healthySchemaReport, addressReport: healthyAddressReport, searchResponse: healthySearchResponse, label: "candidate" });
            expect(createQualityFingerprint(snapshot)).toBe(createQualityFingerprint(snapshot));
            expect(createQualityFingerprint(snapshot)).toContain("candidate");
            expect(createQualityFingerprint(snapshot)).toContain("input=100");
        });

        test("changes fingerprint when metrics change", () => {
            const baseline = createDataQualitySnapshot({ schemaReport: healthySchemaReport });
            const current = createDataQualitySnapshot({ schemaReport: { ...healthySchemaReport, diagnostics: { ...healthySchemaReport.diagnostics, rejectedCount: 4 } } });
            expect(createQualityFingerprint(baseline)).not.toBe(createQualityFingerprint(current));
        });
    });

    describe("gate summaries", () => {
        test("summarizes passing gates", () => {
            const snapshot = createDataQualitySnapshot({ schemaReport: healthySchemaReport, addressReport: healthyAddressReport, searchResponse: healthySearchResponse });
            const summary = createReleaseGateSummary(evaluateDataReleaseGate(snapshot, { minGeocodedRatio: 0.9, maxSearchFilteredOutRatio: 0.5 }));
            expect(summary.level).toBe(RELEASE_GATE_LEVELS.Pass);
            expect(summary.releasable).toBe(true);
            expect(summary.blockerCount).toBe(0);
            expect(summary.warningCount).toBe(0);
        });

        test("summarizes blocker and warning codes", () => {
            const snapshot = createDataQualitySnapshot({ schemaReport: { diagnostics: { inputCount: 100, acceptedCount: 90, rejectedCount: 10 }, drift: { totalRecords: 100, unknownFields: [], missingRequired: [], hasDrift: true } } });
            const summary = createReleaseGateSummary(evaluateDataReleaseGate(snapshot, { maxRejectedRatio: 0.01, warnOnSchemaDrift: true }));
            expect(summary.releasable).toBe(false);
            expect(summary.blockerCount).toBeGreaterThan(0);
            expect(summary.warningCount).toBeGreaterThan(0);
            expect(summary.findingCodes).toContain("rejected-ratio-block");
            expect(summary.findingCodes).toContain("schema-drift-warning");
        });
    });
});
