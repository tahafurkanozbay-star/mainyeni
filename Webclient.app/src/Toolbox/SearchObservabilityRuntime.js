import {
    normalizeFiniteNumber,
    normalizeInteger,
    normalizeText
} from "./DataIntegrityHelper";

export const SEARCH_METRICS = Object.freeze({
    SearchDurationMs: "search.duration.ms",
    IndexBuildDurationMs: "index.build.duration.ms",
    CandidateCount: "search.candidate.count",
    MatchedCount: "search.matched.count",
    DatasetRecordCount: "dataset.record.count",
    CacheHit: "cache.hit",
    CacheMiss: "cache.miss",
    Cancellation: "search.cancellation",
    Error: "search.error"
});

export const DEFAULT_SAMPLE_WINDOW = 200;
export const MAX_SAMPLE_WINDOW = 5000;
export const DEFAULT_SEARCH_PERFORMANCE_BUDGET = Object.freeze({
    searchP95Ms: 120,
    searchP99Ms: 250,
    indexBuildP95Ms: 500,
    candidateP95: 10000,
    maxErrorRatio: 0.01,
    maxCancellationRatio: 0.5,
    minCacheHitRatio: 0,
    minimumSamples: 5
});

const asArray = value => Array.isArray(value) ? value : [];
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const safeRatio = (numerator, denominator) => denominator > 0 ? numerator / denominator : 0;

export const normalizeMetricValue = value => normalizeFiniteNumber(value, null);

export const percentile = (values, percentileValue) => {
    const sorted = asArray(values)
        .map(normalizeMetricValue)
        .filter(value => value !== null)
        .sort((left, right) => left - right);
    if (!sorted.length) return null;
    const p = clamp(normalizeFiniteNumber(percentileValue, 0) || 0, 0, 1);
    if (sorted.length === 1) return sorted[0];
    const position = (sorted.length - 1) * p;
    const lower = Math.floor(position);
    const upper = Math.ceil(position);
    if (lower === upper) return sorted[lower];
    const weight = position - lower;
    return sorted[lower] * (1 - weight) + sorted[upper] * weight;
};

export const summarizeNumericSamples = values => {
    const samples = asArray(values)
        .map(normalizeMetricValue)
        .filter(value => value !== null);
    if (!samples.length) {
        return {
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
        };
    }
    const sum = samples.reduce((total, value) => total + value, 0);
    return {
        count: samples.length,
        min: Math.min(...samples),
        max: Math.max(...samples),
        sum,
        average: sum / samples.length,
        p50: percentile(samples, 0.5),
        p90: percentile(samples, 0.9),
        p95: percentile(samples, 0.95),
        p99: percentile(samples, 0.99),
        latest: samples[samples.length - 1]
    };
};

export const createRollingSampleWindow = (options = {}) => {
    const maxSamples = normalizeInteger(options.maxSamples, {
        min: 1,
        max: MAX_SAMPLE_WINDOW,
        fallback: DEFAULT_SAMPLE_WINDOW
    });
    const samples = [];
    return {
        add(value) {
            const normalized = normalizeMetricValue(value);
            if (normalized === null) return false;
            samples.push(normalized);
            while (samples.length > maxSamples) samples.shift();
            return true;
        },
        addMany(values) {
            return asArray(values).reduce((count, value) => count + (this.add(value) ? 1 : 0), 0);
        },
        values() {
            return samples.slice();
        },
        summary() {
            return summarizeNumericSamples(samples);
        },
        clear() {
            const count = samples.length;
            samples.length = 0;
            return count;
        },
        size() {
            return samples.length;
        },
        maxSamples
    };
};

export const normalizeTelemetryDimensions = dimensions => {
    const input = dimensions && typeof dimensions === "object" ? dimensions : {};
    return Object.keys(input).sort().reduce((result, key) => {
        const value = normalizeText(input[key]);
        if (value) result[key] = value;
        return result;
    }, {});
};

export const createMetricSeriesKey = (metric, dimensions = {}) => {
    const normalizedMetric = normalizeText(metric);
    const normalizedDimensions = normalizeTelemetryDimensions(dimensions);
    const suffix = Object.entries(normalizedDimensions)
        .map(([key, value]) => `${key}=${value}`)
        .join("|");
    return suffix ? `${normalizedMetric}|${suffix}` : normalizedMetric;
};

export const normalizeTelemetryEvent = event => {
    if (!event || typeof event !== "object") return null;
    const metric = normalizeText(event.metric);
    const value = normalizeMetricValue(event.value);
    if (!metric || value === null) return null;
    return {
        metric,
        value,
        dimensions: normalizeTelemetryDimensions(event.dimensions),
        timestamp: normalizeFiniteNumber(event.timestamp, null)
    };
};

export const createSearchTelemetryCollector = (options = {}) => {
    const maxSamples = normalizeInteger(options.maxSamples, {
        min: 1,
        max: MAX_SAMPLE_WINDOW,
        fallback: DEFAULT_SAMPLE_WINDOW
    });
    const series = new Map();
    let acceptedEvents = 0;
    let rejectedEvents = 0;

    const getSeries = (metric, dimensions) => {
        const key = createMetricSeriesKey(metric, dimensions);
        if (!series.has(key)) {
            series.set(key, {
                key,
                metric: normalizeText(metric),
                dimensions: normalizeTelemetryDimensions(dimensions),
                window: createRollingSampleWindow({ maxSamples })
            });
        }
        return series.get(key);
    };

    return {
        record(event) {
            const normalized = normalizeTelemetryEvent(event);
            if (!normalized) {
                rejectedEvents += 1;
                return false;
            }
            getSeries(normalized.metric, normalized.dimensions).window.add(normalized.value);
            acceptedEvents += 1;
            return true;
        },

        recordMetric(metric, value, dimensions = {}) {
            return this.record({ metric, value, dimensions });
        },

        get(metric, dimensions = {}) {
            return getSeries(metric, dimensions).window.summary();
        },

        find(metric) {
            const normalized = normalizeText(metric);
            return Array.from(series.values())
                .filter(item => item.metric === normalized)
                .map(item => ({
                    key: item.key,
                    metric: item.metric,
                    dimensions: { ...item.dimensions },
                    summary: item.window.summary()
                }));
        },

        snapshot() {
            return {
                acceptedEvents,
                rejectedEvents,
                seriesCount: series.size,
                series: Array.from(series.values()).map(item => ({
                    key: item.key,
                    metric: item.metric,
                    dimensions: { ...item.dimensions },
                    summary: item.window.summary()
                }))
            };
        },

        clear() {
            const count = series.size;
            series.clear();
            acceptedEvents = 0;
            rejectedEvents = 0;
            return count;
        }
    };
};

export const aggregateMetric = (snapshot, metric) => {
    const matching = asArray(snapshot?.series).filter(item => item.metric === metric);
    const values = matching.flatMap(item => {
        const summary = item.summary || {};
        if (!summary.count) return [];
        return [{
            count: summary.count,
            average: summary.average,
            min: summary.min,
            max: summary.max,
            p50: summary.p50,
            p95: summary.p95,
            p99: summary.p99
        }];
    });
    if (!values.length) return summarizeNumericSamples([]);
    const count = values.reduce((total, item) => total + item.count, 0);
    const weightedAverage = values.reduce((total, item) => total + (item.average * item.count), 0) / count;
    return {
        count,
        min: Math.min(...values.map(item => item.min)),
        max: Math.max(...values.map(item => item.max)),
        average: weightedAverage,
        p50: Math.max(...values.map(item => item.p50)),
        p95: Math.max(...values.map(item => item.p95)),
        p99: Math.max(...values.map(item => item.p99))
    };
};

export const normalizeSearchPerformanceBudget = budget => {
    const input = budget && typeof budget === "object" ? budget : {};
    const merged = { ...DEFAULT_SEARCH_PERFORMANCE_BUDGET, ...input };
    return {
        searchP95Ms: Math.max(1, normalizeFiniteNumber(merged.searchP95Ms, DEFAULT_SEARCH_PERFORMANCE_BUDGET.searchP95Ms)),
        searchP99Ms: Math.max(1, normalizeFiniteNumber(merged.searchP99Ms, DEFAULT_SEARCH_PERFORMANCE_BUDGET.searchP99Ms)),
        indexBuildP95Ms: Math.max(1, normalizeFiniteNumber(merged.indexBuildP95Ms, DEFAULT_SEARCH_PERFORMANCE_BUDGET.indexBuildP95Ms)),
        candidateP95: Math.max(1, normalizeFiniteNumber(merged.candidateP95, DEFAULT_SEARCH_PERFORMANCE_BUDGET.candidateP95)),
        maxErrorRatio: clamp(normalizeFiniteNumber(merged.maxErrorRatio, DEFAULT_SEARCH_PERFORMANCE_BUDGET.maxErrorRatio), 0, 1),
        maxCancellationRatio: clamp(normalizeFiniteNumber(merged.maxCancellationRatio, DEFAULT_SEARCH_PERFORMANCE_BUDGET.maxCancellationRatio), 0, 1),
        minCacheHitRatio: clamp(normalizeFiniteNumber(merged.minCacheHitRatio, DEFAULT_SEARCH_PERFORMANCE_BUDGET.minCacheHitRatio), 0, 1),
        minimumSamples: normalizeInteger(merged.minimumSamples, { min: 1, max: 10000, fallback: DEFAULT_SEARCH_PERFORMANCE_BUDGET.minimumSamples })
    };
};

const createBudgetFinding = (level, code, actual, threshold, message) => ({
    level,
    code,
    actual,
    threshold,
    message
});

export const evaluateSearchPerformanceBudget = (snapshot, budget = DEFAULT_SEARCH_PERFORMANCE_BUDGET) => {
    const policy = normalizeSearchPerformanceBudget(budget);
    const duration = aggregateMetric(snapshot, SEARCH_METRICS.SearchDurationMs);
    const indexBuild = aggregateMetric(snapshot, SEARCH_METRICS.IndexBuildDurationMs);
    const candidates = aggregateMetric(snapshot, SEARCH_METRICS.CandidateCount);
    const errors = aggregateMetric(snapshot, SEARCH_METRICS.Error);
    const cancellations = aggregateMetric(snapshot, SEARCH_METRICS.Cancellation);
    const cacheHits = aggregateMetric(snapshot, SEARCH_METRICS.CacheHit);
    const cacheMisses = aggregateMetric(snapshot, SEARCH_METRICS.CacheMiss);
    const attempts = Math.max(duration.count, errors.count, cancellations.count);
    const errorRatio = safeRatio(errors.sum ?? errors.count, attempts);
    const cancellationRatio = safeRatio(cancellations.sum ?? cancellations.count, attempts);
    const cacheTotal = cacheHits.count + cacheMisses.count;
    const hitCount = cacheHits.sum ?? cacheHits.count;
    const missCount = cacheMisses.sum ?? cacheMisses.count;
    const cacheHitRatio = safeRatio(hitCount, hitCount + missCount || cacheTotal);
    const findings = [];
    const representative = duration.count >= policy.minimumSamples;

    if (!representative && duration.count > 0) {
        findings.push(createBudgetFinding("warning", "sample-size-low", duration.count, policy.minimumSamples, "Search performance sample is not yet representative"));
    }
    if (representative && duration.p95 > policy.searchP95Ms) {
        findings.push(createBudgetFinding("block", "search-p95", duration.p95, policy.searchP95Ms, "Search p95 duration exceeds the production budget"));
    }
    if (representative && duration.p99 > policy.searchP99Ms) {
        findings.push(createBudgetFinding("block", "search-p99", duration.p99, policy.searchP99Ms, "Search p99 duration exceeds the production budget"));
    }
    if (indexBuild.count >= policy.minimumSamples && indexBuild.p95 > policy.indexBuildP95Ms) {
        findings.push(createBudgetFinding("block", "index-build-p95", indexBuild.p95, policy.indexBuildP95Ms, "Index build p95 duration exceeds the production budget"));
    }
    if (candidates.count >= policy.minimumSamples && candidates.p95 > policy.candidateP95) {
        findings.push(createBudgetFinding("warning", "candidate-p95", candidates.p95, policy.candidateP95, "Candidate scan p95 exceeds the configured efficiency budget"));
    }
    if (attempts >= policy.minimumSamples && errorRatio > policy.maxErrorRatio) {
        findings.push(createBudgetFinding("block", "error-ratio", errorRatio, policy.maxErrorRatio, "Search error ratio exceeds the configured budget"));
    }
    if (attempts >= policy.minimumSamples && cancellationRatio > policy.maxCancellationRatio) {
        findings.push(createBudgetFinding("warning", "cancellation-ratio", cancellationRatio, policy.maxCancellationRatio, "Search cancellation ratio indicates excessive superseded work"));
    }
    if (cacheTotal >= policy.minimumSamples && cacheHitRatio < policy.minCacheHitRatio) {
        findings.push(createBudgetFinding("warning", "cache-hit-ratio", cacheHitRatio, policy.minCacheHitRatio, "Search cache hit ratio is below the configured target"));
    }

    const blocked = findings.some(finding => finding.level === "block");
    const warned = findings.some(finding => finding.level === "warning");
    return {
        level: blocked ? "block" : warned ? "warning" : "pass",
        withinBudget: !blocked,
        representative,
        findings,
        metrics: {
            duration,
            indexBuild,
            candidates,
            errorRatio,
            cancellationRatio,
            cacheHitRatio
        },
        budget: policy
    };
};

export const recommendSearchDebounceMs = ({
    searchP95Ms = 0,
    recordCount = 0,
    queryLength = 0,
    min = 80,
    max = 600
} = {}) => {
    const p95 = Math.max(0, normalizeFiniteNumber(searchP95Ms, 0) || 0);
    const records = Math.max(0, normalizeFiniteNumber(recordCount, 0) || 0);
    const length = Math.max(0, normalizeInteger(queryLength, { min: 0, fallback: 0 }));
    const latencyWeight = Math.min(300, p95 * 0.75);
    const dataWeight = records > 100000 ? 140 : records > 25000 ? 90 : records > 5000 ? 40 : 0;
    const shortQueryWeight = length <= 1 ? 120 : length === 2 ? 50 : 0;
    return Math.round(clamp(min + latencyWeight + dataWeight + shortQueryWeight, min, max));
};

export const measureAsyncOperation = async (operation, options = {}) => {
    if (typeof operation !== "function") throw new TypeError("Measured operation must be a function");
    const now = typeof options.now === "function" ? options.now : () => Date.now();
    const startedAt = now();
    try {
        const value = await operation();
        const completedAt = now();
        return { value, durationMs: Math.max(0, completedAt - startedAt), error: null };
    } catch (error) {
        const completedAt = now();
        return { value: undefined, durationMs: Math.max(0, completedAt - startedAt), error };
    }
};

export const createSearchObservability = (options = {}) => {
    const collector = options.collector || createSearchTelemetryCollector(options);
    const budget = normalizeSearchPerformanceBudget(options.budget);

    return {
        collector,

        recordSearch(result, durationMs, context = {}) {
            const dimensions = {
                dataset: context.dataset || result?.dataset || "",
                mode: context.mode || result?.mode || ""
            };
            collector.recordMetric(SEARCH_METRICS.SearchDurationMs, durationMs, dimensions);
            if (result?.diagnostics?.candidateCount !== undefined) {
                collector.recordMetric(SEARCH_METRICS.CandidateCount, result.diagnostics.candidateCount, dimensions);
            }
            if (result?.diagnostics?.matchedCount !== undefined) {
                collector.recordMetric(SEARCH_METRICS.MatchedCount, result.diagnostics.matchedCount, dimensions);
            }
            return result;
        },

        recordIndexBuild(durationMs, context = {}) {
            collector.recordMetric(SEARCH_METRICS.IndexBuildDurationMs, durationMs, {
                dataset: context.dataset || "",
                schema: context.schema || ""
            });
        },

        recordDatasetSize(recordCount, context = {}) {
            collector.recordMetric(SEARCH_METRICS.DatasetRecordCount, recordCount, {
                dataset: context.dataset || ""
            });
        },

        recordCache(hit, context = {}) {
            collector.recordMetric(hit ? SEARCH_METRICS.CacheHit : SEARCH_METRICS.CacheMiss, 1, {
                dataset: context.dataset || ""
            });
        },

        recordCancellation(context = {}) {
            collector.recordMetric(SEARCH_METRICS.Cancellation, 1, {
                dataset: context.dataset || ""
            });
        },

        recordError(context = {}) {
            collector.recordMetric(SEARCH_METRICS.Error, 1, {
                dataset: context.dataset || ""
            });
        },

        snapshot() {
            return collector.snapshot();
        },

        evaluate(customBudget = budget) {
            return evaluateSearchPerformanceBudget(collector.snapshot(), customBudget);
        },

        recommendDebounce(context = {}) {
            const duration = aggregateMetric(collector.snapshot(), SEARCH_METRICS.SearchDurationMs);
            const records = aggregateMetric(collector.snapshot(), SEARCH_METRICS.DatasetRecordCount);
            return recommendSearchDebounceMs({
                searchP95Ms: duration.p95 || 0,
                recordCount: context.recordCount ?? records.latest ?? records.max ?? 0,
                queryLength: context.queryLength || 0,
                min: context.min,
                max: context.max
            });
        },

        clear() {
            return collector.clear();
        }
    };
};

export const SearchObservabilityRuntime = {
    SEARCH_METRICS,
    DEFAULT_SAMPLE_WINDOW,
    MAX_SAMPLE_WINDOW,
    DEFAULT_SEARCH_PERFORMANCE_BUDGET,
    normalizeMetricValue,
    percentile,
    summarizeNumericSamples,
    createRollingSampleWindow,
    normalizeTelemetryDimensions,
    createMetricSeriesKey,
    normalizeTelemetryEvent,
    createSearchTelemetryCollector,
    aggregateMetric,
    normalizeSearchPerformanceBudget,
    evaluateSearchPerformanceBudget,
    recommendSearchDebounceMs,
    measureAsyncOperation,
    createSearchObservability
};