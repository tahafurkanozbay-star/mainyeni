import { normalizeText } from '../../Toolbox/DataIntegrityHelper';
import {
  SEARCH_METRICS,
  isRecord,
  type SearchObservationContext,
  type SearchObservability,
  type SearchObservabilityOptions,
} from './contracts';
import {
  aggregateMetric,
  createSearchTelemetryCollector,
} from './collector';
import {
  evaluateSearchPerformanceBudget,
  normalizeSearchPerformanceBudget,
  recommendSearchDebounceMs,
} from './budget';

const readValue = (value: unknown, key: string): unknown =>
  isRecord(value) ? value[key] : undefined;

const readDiagnostic = (value: unknown, key: string): unknown => {
  const diagnostics = readValue(value, 'diagnostics');
  return isRecord(diagnostics) ? diagnostics[key] : undefined;
};

const contextText = (
  context: SearchObservationContext,
  key: keyof SearchObservationContext,
): string => normalizeText(context[key]);

export const createSearchObservability = (
  options: SearchObservabilityOptions = {},
): SearchObservability => {
  const collector = options.collector ?? createSearchTelemetryCollector(options);
  const budget = normalizeSearchPerformanceBudget(options.budget);

  return {
    collector,

    recordSearch<T>(result: T, durationMs: unknown, context = {}): T {
      const dimensions = {
        dataset: contextText(context, 'dataset') || normalizeText(readValue(result, 'dataset')),
        mode: contextText(context, 'mode') || normalizeText(readValue(result, 'mode')),
      };
      collector.recordMetric(SEARCH_METRICS.SearchDurationMs, durationMs, dimensions);

      const candidateCount = readDiagnostic(result, 'candidateCount');
      if (candidateCount !== undefined) {
        collector.recordMetric(SEARCH_METRICS.CandidateCount, candidateCount, dimensions);
      }
      const matchedCount = readDiagnostic(result, 'matchedCount');
      if (matchedCount !== undefined) {
        collector.recordMetric(SEARCH_METRICS.MatchedCount, matchedCount, dimensions);
      }
      return result;
    },

    recordIndexBuild(durationMs, context = {}) {
      collector.recordMetric(SEARCH_METRICS.IndexBuildDurationMs, durationMs, {
        dataset: contextText(context, 'dataset'),
        schema: contextText(context, 'schema'),
      });
    },

    recordDatasetSize(recordCount, context = {}) {
      collector.recordMetric(SEARCH_METRICS.DatasetRecordCount, recordCount, {
        dataset: contextText(context, 'dataset'),
      });
    },

    recordCache(hit, context = {}) {
      collector.recordMetric(
        hit ? SEARCH_METRICS.CacheHit : SEARCH_METRICS.CacheMiss,
        1,
        { dataset: contextText(context, 'dataset') },
      );
    },

    recordCancellation(context = {}) {
      collector.recordMetric(SEARCH_METRICS.Cancellation, 1, {
        dataset: contextText(context, 'dataset'),
      });
    },

    recordError(context = {}) {
      collector.recordMetric(SEARCH_METRICS.Error, 1, {
        dataset: contextText(context, 'dataset'),
      });
    },

    snapshot() {
      return collector.snapshot();
    },

    evaluate(customBudget = budget) {
      return evaluateSearchPerformanceBudget(collector.snapshot(), customBudget);
    },

    recommendDebounce(context = {}) {
      const snapshot = collector.snapshot();
      const duration = aggregateMetric(snapshot, SEARCH_METRICS.SearchDurationMs);
      const records = aggregateMetric(snapshot, SEARCH_METRICS.DatasetRecordCount);
      return recommendSearchDebounceMs({
        searchP95Ms: duration.p95 ?? 0,
        recordCount: context.recordCount ?? records.latest ?? records.max ?? 0,
        queryLength: context.queryLength ?? 0,
        ...(context.min !== undefined ? { min: context.min } : {}),
        ...(context.max !== undefined ? { max: context.max } : {}),
      });
    },

    clear() {
      return collector.clear();
    },
  };
};
