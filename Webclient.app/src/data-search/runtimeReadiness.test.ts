import { describe, expect, it } from 'vitest';
import {
  DATA_SEARCH_READINESS_LEVELS,
  createDataSearchReadinessReport,
  normalizeDataSearchReadinessPolicy,
  normalizeSearchIndexReadiness,
} from './runtimeReadiness';
import {
  SEARCH_METRICS,
  createSearchTelemetryCollector,
} from './search-observability/index';

describe('Data/Search runtime readiness governance', () => {
  it('normalizes readiness policy into bounded production-safe values', () => {
    const policy = normalizeDataSearchReadinessPolicy({
      minimumIndexedRatio: 7,
      maximumDuplicateIds: -4,
      requireRepresentativePerformance: true,
      release: {
        maxRejectedRatio: 4,
        maxInvalidRatio: -2,
        minimumSampleSize: -10,
      },
      performance: {
        searchP95Ms: -1,
        minimumSamples: 0,
      },
    });

    expect(policy.minimumIndexedRatio).toBe(1);
    expect(policy.maximumDuplicateIds).toBe(0);
    expect(policy.requireRepresentativePerformance).toBe(true);
    expect(policy.release.maxRejectedRatio).toBe(1);
    expect(policy.release.maxInvalidRatio).toBe(0);
    expect(policy.release.minimumSampleSize).toBe(0);
    expect(policy.performance.searchP95Ms).toBe(1);
    expect(policy.performance.minimumSamples).toBe(1);
  });

  it('normalizes search index diagnostics without trusting negative counts', () => {
    const metrics = normalizeSearchIndexReadiness({
      inputCount: 100,
      indexedCount: 95,
      uniqueIdCount: 90,
      duplicateIds: ['a', 'b'],
      tokenCount: 300,
      prefixCount: 900,
    });

    expect(metrics).toEqual({
      inputCount: 100,
      indexedCount: 95,
      uniqueIdCount: 90,
      duplicateIdCount: 2,
      tokenCount: 300,
      prefixCount: 900,
      indexedRatio: 0.95,
    });

    expect(normalizeSearchIndexReadiness(null)).toBeNull();
  });

  it('passes a healthy representative runtime snapshot', () => {
    const collector = createSearchTelemetryCollector();

    for (let index = 0; index < 8; index += 1) {
      collector.recordMetric(SEARCH_METRICS.SearchDurationMs, 40 + index);
      collector.recordMetric(SEARCH_METRICS.IndexBuildDurationMs, 100 + index);
      collector.recordMetric(SEARCH_METRICS.CandidateCount, 1_000 + index);
      collector.recordMetric(SEARCH_METRICS.CacheHit, 1);
    }

    const report = createDataSearchReadinessReport({
      label: 'healthy',
      telemetry: collector.snapshot(),
      indexDiagnostics: {
        inputCount: 100,
        indexedCount: 100,
        uniqueIdCount: 100,
        duplicateIds: [],
        tokenCount: 250,
        prefixCount: 600,
      },
      schemaReport: {
        diagnostics: {
          inputCount: 100,
          acceptedCount: 100,
          rejectedCount: 0,
          invalidCount: 0,
          duplicateCount: 0,
        },
        drift: {
          totalRecords: 100,
          unknownFields: [],
          missingRequired: [],
          hasDrift: false,
        },
      },
      addressReport: {
        total: 100,
        geocodedCount: 100,
        ungeocodedCount: 0,
        geocodedRatio: 1,
        hierarchyIssueCount: 0,
        diagnostics: {
          conflictingIds: [],
        },
      },
      searchResponse: {
        diagnostics: {
          candidateCount: 1_000,
          scannedCount: 1_000,
          matchedCount: 100,
          filteredOutCount: 0,
          belowScoreCount: 0,
        },
      },
    });

    expect(report.ready).toBe(true);
    expect(report.level).toBe(DATA_SEARCH_READINESS_LEVELS.Pass);
    expect(report.blockerCodes).toEqual([]);
    expect(report.warningCodes).toEqual([]);
    expect(report.quality.releasable).toBe(true);
    expect(report.performance?.withinBudget).toBe(true);
    expect(report.index?.indexedRatio).toBe(1);
  });

  it('blocks data-integrity regressions deterministically', () => {
    const report = createDataSearchReadinessReport({
      schemaReport: {
        diagnostics: {
          inputCount: 100,
          acceptedCount: 90,
          rejectedCount: 10,
          invalidCount: 5,
          duplicateCount: 3,
        },
        drift: {
          totalRecords: 100,
          unknownFields: [{ name: 'unexpected', count: 10 }],
          missingRequired: [{ name: 'title', count: 2 }],
          hasDrift: true,
        },
      },
      addressReport: {
        total: 100,
        geocodedRatio: 0.4,
        hierarchyIssueCount: 12,
        diagnostics: {
          conflictingIds: ['1'],
        },
      },
      policy: {
        release: {
          maxRejectedRatio: 0.02,
          maxInvalidRatio: 0.02,
          maxDuplicateRatio: 0.02,
          maxUnknownFieldRatio: 0.05,
          maxMissingRequiredRatio: 0,
          maxHierarchyIssueRatio: 0.02,
          maxConflictingIds: 0,
          minGeocodedRatio: 0.9,
          maxSearchFilteredOutRatio: 1,
          blockOnSchemaDrift: true,
          warnOnSchemaDrift: true,
          minimumSampleSize: 10,
        },
      },
    });

    expect(report.ready).toBe(false);
    expect(report.level).toBe(DATA_SEARCH_READINESS_LEVELS.Block);
    expect(report.blockerCodes).toContain('quality:rejected-ratio-block');
    expect(report.blockerCodes).toContain('quality:invalid-ratio-block');
    expect(report.blockerCodes).toContain('quality:duplicate-ratio-block');
    expect(report.blockerCodes).toContain('quality:schema-unknown-field-ratio-block');
    expect(report.blockerCodes).toContain('quality:missing-required-ratio-block');
    expect(report.blockerCodes).toContain('quality:address-hierarchy-ratio-block');
    expect(report.blockerCodes).toContain('quality:conflicting-id-block');
    expect(report.blockerCodes).toContain('quality:geocoded-ratio-block');
    expect(report.blockerCodes).toContain('quality:schema-drift-block');
  });

  it('blocks insufficient index coverage and duplicate identities', () => {
    const report = createDataSearchReadinessReport({
      indexDiagnostics: {
        inputCount: 100,
        indexedCount: 70,
        uniqueIdCount: 60,
        duplicateIds: ['a', 'b', 'c'],
        tokenCount: 0,
        prefixCount: 0,
      },
      policy: {
        minimumIndexedRatio: 0.95,
        maximumDuplicateIds: 0,
      },
    });

    expect(report.ready).toBe(false);
    expect(report.blockerCodes).toContain('index:indexed-ratio');
    expect(report.blockerCodes).toContain('index:duplicate-identities');
    expect(report.warningCodes).toContain('index:no-search-tokens');
  });

  it('can require representative performance evidence before release', () => {
    const collector = createSearchTelemetryCollector();
    collector.recordMetric(SEARCH_METRICS.SearchDurationMs, 20);

    const report = createDataSearchReadinessReport({
      telemetry: collector.snapshot(),
      policy: {
        requireRepresentativePerformance: true,
        performance: {
          minimumSamples: 5,
        },
      },
    });

    expect(report.ready).toBe(false);
    expect(report.blockerCodes).toContain(
      'performance:representative-sample-required',
    );
  });

  it('blocks latency budget violations when samples are representative', () => {
    const collector = createSearchTelemetryCollector();

    for (let index = 0; index < 8; index += 1) {
      collector.recordMetric(SEARCH_METRICS.SearchDurationMs, 500 + index);
    }

    const report = createDataSearchReadinessReport({
      telemetry: collector.snapshot(),
      policy: {
        performance: {
          searchP95Ms: 100,
          searchP99Ms: 150,
          minimumSamples: 5,
        },
      },
    });

    expect(report.ready).toBe(false);
    expect(report.blockerCodes).toContain('performance:search-p95');
    expect(report.blockerCodes).toContain('performance:search-p99');
  });
});
