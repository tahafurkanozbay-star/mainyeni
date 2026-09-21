import {
    DEFAULT_SEARCH_PERFORMANCE_BUDGET,
    SEARCH_METRICS,
    aggregateMetric,
    createMetricSeriesKey,
    createRollingSampleWindow,
    createSearchObservability,
    createSearchTelemetryCollector,
    evaluateSearchPerformanceBudget,
    measureAsyncOperation,
    normalizeSearchPerformanceBudget,
    normalizeTelemetryDimensions,
    normalizeTelemetryEvent,
    percentile,
    recommendSearchDebounceMs,
    summarizeNumericSamples
} from "./SearchObservabilityRuntime";

describe("SearchObservabilityRuntime", () => {
    describe("numeric summaries", () => {
        test("computes deterministic percentiles", () => {
            expect(percentile([10, 20, 30, 40, 50], 0.5)).toBe(30);
            expect(percentile([10, 20, 30, 40, 50], 0.95)).toBeCloseTo(48);
            expect(percentile([], 0.95)).toBeNull();
        });

        test("ignores invalid numeric samples", () => {
            const summary = summarizeNumericSamples([10, null, "20", "bad", Infinity]);
            expect(summary.count).toBe(2);
            expect(summary.min).toBe(10);
            expect(summary.max).toBe(20);
            expect(summary.average).toBe(15);
        });

        test("returns stable empty summaries", () => {
            expect(summarizeNumericSamples([])).toEqual({
                count: 0,
                min: null,
                max: null,
                sum: 0,
                average: null,
                p50: null,
                p90: null,
                p95: null,
                p99: null,
                latest: null
            });
        });
    });

    describe("rolling windows", () => {
        test("bounds retained samples", () => {
            const window = createRollingSampleWindow({ maxSamples: 3 });
            window.addMany([1, 2, 3, 4, 5]);
            expect(window.values()).toEqual([3, 4, 5]);
            expect(window.size()).toBe(3);
        });

        test("rejects non numeric values", () => {
            const window = createRollingSampleWindow();
            expect(window.add("invalid")).toBe(false);
            expect(window.add(25)).toBe(true);
            expect(window.summary().count).toBe(1);
        });

        test("clears samples", () => {
            const window = createRollingSampleWindow();
            window.addMany([1, 2, 3]);
            expect(window.clear()).toBe(3);
            expect(window.size()).toBe(0);
        });
    });

    describe("telemetry identity", () => {
        test("normalizes dimensions deterministically", () => {
            expect(normalizeTelemetryDimensions({ mode: " text ", dataset: " places ", empty: "" })).toEqual({
                dataset: "places",
                mode: "text"
            });
        });

        test("creates order-independent series keys", () => {
            const left = createMetricSeriesKey("search.duration.ms", { dataset: "places", mode: "text" });
            const right = createMetricSeriesKey("search.duration.ms", { mode: "text", dataset: "places" });
            expect(left).toBe(right);
        });

        test("rejects invalid telemetry events", () => {
            expect(normalizeTelemetryEvent(null)).toBeNull();
            expect(normalizeTelemetryEvent({ metric: "", value: 1 })).toBeNull();
            expect(normalizeTelemetryEvent({ metric: "x", value: "bad" })).toBeNull();
        });

        test("normalizes valid events", () => {
            expect(normalizeTelemetryEvent({
                metric: " search.duration.ms ",
                value: "42",
                dimensions: { dataset: " places " }
            })).toEqual({
                metric: "search.duration.ms",
                value: 42,
                dimensions: { dataset: "places" },
                timestamp: null
            });
        });
    });

    describe("collector", () => {
        test("records and snapshots metric series", () => {
            const collector = createSearchTelemetryCollector();
            collector.recordMetric(SEARCH_METRICS.SearchDurationMs, 10, { dataset: "places" });
            collector.recordMetric(SEARCH_METRICS.SearchDurationMs, 20, { dataset: "places" });
            const snapshot = collector.snapshot();
            expect(snapshot.acceptedEvents).toBe(2);
            expect(snapshot.rejectedEvents).toBe(0);
            expect(snapshot.seriesCount).toBe(1);
            expect(snapshot.series[0].summary.average).toBe(15);
        });

        test("separates dimensions into independent series", () => {
            const collector = createSearchTelemetryCollector();
            collector.recordMetric(SEARCH_METRICS.SearchDurationMs, 10, { dataset: "places" });
            collector.recordMetric(SEARCH_METRICS.SearchDurationMs, 20, { dataset: "addresses" });
            expect(collector.find(SEARCH_METRICS.SearchDurationMs)).toHaveLength(2);
        });

        test("tracks rejected events", () => {
            const collector = createSearchTelemetryCollector();
            expect(collector.record({ metric: "bad", value: "not-number" })).toBe(false);
            expect(collector.snapshot().rejectedEvents).toBe(1);
        });

        test("clears all series and counters", () => {
            const collector = createSearchTelemetryCollector();
            collector.recordMetric("x", 1);
            expect(collector.clear()).toBe(1);
            expect(collector.snapshot()).toEqual(expect.objectContaining({
                acceptedEvents: 0,
                rejectedEvents: 0,
                seriesCount: 0
            }));
        });
    });

    describe("aggregation", () => {
        test("aggregates metric series across datasets", () => {
            const collector = createSearchTelemetryCollector();
            [10, 20].forEach(value => collector.recordMetric(SEARCH_METRICS.SearchDurationMs, value, { dataset: "one" }));
            [30, 40].forEach(value => collector.recordMetric(SEARCH_METRICS.SearchDurationMs, value, { dataset: "two" }));
            const aggregate = aggregateMetric(collector.snapshot(), SEARCH_METRICS.SearchDurationMs);
            expect(aggregate.count).toBe(4);
            expect(aggregate.min).toBe(10);
            expect(aggregate.max).toBe(40);
            expect(aggregate.average).toBe(25);
        });

        test("returns empty summary for missing metrics", () => {
            expect(aggregateMetric(createSearchTelemetryCollector().snapshot(), "missing").count).toBe(0);
        });
    });

    describe("budget normalization", () => {
        test("uses production defaults", () => {
            expect(normalizeSearchPerformanceBudget({})).toEqual(DEFAULT_SEARCH_PERFORMANCE_BUDGET);
        });

        test("clamps ratios and invalid thresholds", () => {
            const budget = normalizeSearchPerformanceBudget({
                searchP95Ms: -1,
                maxErrorRatio: 4,
                maxCancellationRatio: -2,
                minCacheHitRatio: 2
            });
            expect(budget.searchP95Ms).toBe(1);
            expect(budget.maxErrorRatio).toBe(1);
            expect(budget.maxCancellationRatio).toBe(0);
            expect(budget.minCacheHitRatio).toBe(1);
        });
    });

    describe("performance budget evaluation", () => {
        const snapshotWithDurations = durations => {
            const collector = createSearchTelemetryCollector();
            durations.forEach(value => collector.recordMetric(SEARCH_METRICS.SearchDurationMs, value));
            return collector.snapshot();
        };

        test("passes representative fast samples", () => {
            const gate = evaluateSearchPerformanceBudget(snapshotWithDurations([20, 25, 30, 35, 40]), {
                searchP95Ms: 100,
                searchP99Ms: 120,
                minimumSamples: 5
            });
            expect(gate.withinBudget).toBe(true);
            expect(gate.level).toBe("pass");
        });

        test("blocks p95 regressions", () => {
            const gate = evaluateSearchPerformanceBudget(snapshotWithDurations([100, 120, 140, 160, 200]), {
                searchP95Ms: 120,
                searchP99Ms: 500,
                minimumSamples: 5
            });
            expect(gate.withinBudget).toBe(false);
            expect(gate.findings.map(item => item.code)).toContain("search-p95");
        });

        test("warns when sample size is too small", () => {
            const gate = evaluateSearchPerformanceBudget(snapshotWithDurations([20, 30]), {
                minimumSamples: 5
            });
            expect(gate.level).toBe("warning");
            expect(gate.representative).toBe(false);
            expect(gate.findings[0].code).toBe("sample-size-low");
        });

        test("blocks excessive error ratio", () => {
            const collector = createSearchTelemetryCollector();
            for (let index = 0; index < 10; index += 1) {
                collector.recordMetric(SEARCH_METRICS.SearchDurationMs, 20);
            }
            collector.recordMetric(SEARCH_METRICS.Error, 1);
            collector.recordMetric(SEARCH_METRICS.Error, 1);
            const gate = evaluateSearchPerformanceBudget(collector.snapshot(), {
                minimumSamples: 5,
                maxErrorRatio: 0.1
            });
            expect(gate.findings.map(item => item.code)).toContain("error-ratio");
        });

        test("warns on excessive candidate scans", () => {
            const collector = createSearchTelemetryCollector();
            for (let index = 0; index < 5; index += 1) {
                collector.recordMetric(SEARCH_METRICS.SearchDurationMs, 20);
                collector.recordMetric(SEARCH_METRICS.CandidateCount, 50000);
            }
            const gate = evaluateSearchPerformanceBudget(collector.snapshot(), {
                minimumSamples: 5,
                candidateP95: 10000
            });
            expect(gate.findings.map(item => item.code)).toContain("candidate-p95");
            expect(gate.withinBudget).toBe(true);
        });

        test("warns on poor cache hit ratio when target is configured", () => {
            const collector = createSearchTelemetryCollector();
            for (let index = 0; index < 5; index += 1) collector.recordMetric(SEARCH_METRICS.CacheMiss, 1);
            collector.recordMetric(SEARCH_METRICS.CacheHit, 1);
            const gate = evaluateSearchPerformanceBudget(collector.snapshot(), {
                minimumSamples: 5,
                minCacheHitRatio: 0.5
            });
            expect(gate.findings.map(item => item.code)).toContain("cache-hit-ratio");
        });
    });

    describe("adaptive debounce", () => {
        test("keeps fast small searches responsive", () => {
            expect(recommendSearchDebounceMs({
                searchP95Ms: 20,
                recordCount: 1000,
                queryLength: 4
            })).toBeLessThan(150);
        });

        test("increases debounce for huge datasets", () => {
            const small = recommendSearchDebounceMs({ searchP95Ms: 20, recordCount: 1000, queryLength: 4 });
            const large = recommendSearchDebounceMs({ searchP95Ms: 20, recordCount: 150000, queryLength: 4 });
            expect(large).toBeGreaterThan(small);
        });

        test("increases debounce for very short queries", () => {
            const longQuery = recommendSearchDebounceMs({ searchP95Ms: 20, recordCount: 1000, queryLength: 5 });
            const oneChar = recommendSearchDebounceMs({ searchP95Ms: 20, recordCount: 1000, queryLength: 1 });
            expect(oneChar).toBeGreaterThan(longQuery);
        });

        test("respects configured bounds", () => {
            expect(recommendSearchDebounceMs({
                searchP95Ms: 10000,
                recordCount: 1000000,
                queryLength: 1,
                min: 100,
                max: 300
            })).toBe(300);
        });
    });

    describe("measured operations", () => {
        test("measures successful async operations using injected clock", async () => {
            const times = [100, 145];
            const result = await measureAsyncOperation(async () => "ok", {
                now: () => times.shift() ?? 0
            });
            expect(result).toEqual({ value: "ok", durationMs: 45, error: null });
        });

        test("returns measured errors without swallowing identity", async () => {
            const times = [100, 130];
            const error = new Error("boom");
            const result = await measureAsyncOperation(async () => {
                throw error;
            }, { now: () => times.shift() ?? 0 });
            expect(result.error).toBe(error);
            expect(result.durationMs).toBe(30);
        });
    });

    describe("integrated observability facade", () => {
        test("records coordinator search results", () => {
            const observability = createSearchObservability();
            const result = {
                dataset: "places",
                mode: "text",
                diagnostics: { candidateCount: 100, matchedCount: 5 }
            };
            expect(observability.recordSearch(result, 40)).toBe(result);
            const snapshot = observability.snapshot();
            expect(snapshot.seriesCount).toBe(3);
        });

        test("records index builds and dataset sizes", () => {
            const observability = createSearchObservability();
            observability.recordIndexBuild(200, { dataset: "places", schema: "generic" });
            observability.recordDatasetSize(25000, { dataset: "places" });
            expect(observability.snapshot().seriesCount).toBe(2);
        });

        test("records cache/error/cancellation counters", () => {
            const observability = createSearchObservability();
            observability.recordCache(true, { dataset: "places" });
            observability.recordCache(false, { dataset: "places" });
            observability.recordCancellation({ dataset: "places" });
            observability.recordError({ dataset: "places" });
            expect(observability.snapshot().acceptedEvents).toBe(4);
        });

        test("evaluates current collector against configured budget", () => {
            const observability = createSearchObservability({
                budget: { minimumSamples: 3, searchP95Ms: 100, searchP99Ms: 150 }
            });
            [20, 30, 40].forEach(value => observability.recordSearch({ diagnostics: {} }, value));
            expect(observability.evaluate()).toEqual(expect.objectContaining({
                withinBudget: true,
                representative: true
            }));
        });

        test("recommends debounce from collected latency", () => {
            const observability = createSearchObservability();
            [100, 120, 140].forEach(value => observability.recordSearch({ diagnostics: {} }, value));
            observability.recordDatasetSize(50000);
            expect(observability.recommendDebounce({ queryLength: 1 })).toBeGreaterThan(180);
        });

        test("clears collected telemetry", () => {
            const observability = createSearchObservability();
            observability.recordSearch({ diagnostics: {} }, 20);
            expect(observability.clear()).toBeGreaterThan(0);
            expect(observability.snapshot().seriesCount).toBe(0);
        });
    });
});