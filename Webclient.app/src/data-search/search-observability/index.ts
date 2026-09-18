export * from './contracts';
export * from './statistics';
export * from './collector';
export * from './budget';
export * from './measure';
export * from './runtime';

import {
  SEARCH_METRICS,
} from './contracts';
import {
  aggregateMetric,
  createMetricSeriesKey,
  createSearchTelemetryCollector,
  normalizeTelemetryDimensions,
  normalizeTelemetryEvent,
} from './collector';
import {
  DEFAULT_SEARCH_PERFORMANCE_BUDGET,
  evaluateSearchPerformanceBudget,
  normalizeSearchPerformanceBudget,
  recommendSearchDebounceMs,
} from './budget';
import {
  measureAsyncOperation,
} from './measure';
import {
  createSearchObservability,
} from './runtime';
import {
  DEFAULT_SAMPLE_WINDOW,
  MAX_SAMPLE_WINDOW,
  createRollingSampleWindow,
  normalizeMetricValue,
  percentile,
  summarizeNumericSamples,
} from './statistics';

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
  createSearchObservability,
};
