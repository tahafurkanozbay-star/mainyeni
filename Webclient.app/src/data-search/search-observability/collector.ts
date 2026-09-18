import {
  normalizeFiniteNumber,
  normalizeInteger,
  normalizeText,
} from '../../Toolbox/DataIntegrityHelper';
import {
  isRecord,
  type NumericSampleSummary,
  type SearchTelemetryCollector,
  type SearchTelemetryCollectorOptions,
  type SearchTelemetrySnapshot,
  type TelemetryDimensions,
  type TelemetryEvent,
  type TelemetrySeriesSnapshot,
} from './contracts';
import {
  DEFAULT_SAMPLE_WINDOW,
  MAX_SAMPLE_WINDOW,
  createRollingSampleWindow,
  summarizeNumericSamples,
} from './statistics';

interface SeriesState {
  key: string;
  metric: string;
  dimensions: TelemetryDimensions;
  window: ReturnType<typeof createRollingSampleWindow>;
}

export const normalizeTelemetryDimensions = (
  dimensions: unknown,
): TelemetryDimensions => {
  const input = isRecord(dimensions) ? dimensions : {};
  const output: Record<string, string> = {};

  for (const key of Object.keys(input).sort()) {
    const value = normalizeText(input[key]);
    if (value) output[key] = value;
  }
  return output;
};

export const createMetricSeriesKey = (
  metric: unknown,
  dimensions: unknown = {},
): string => {
  const normalizedMetric = normalizeText(metric);
  const normalizedDimensions = normalizeTelemetryDimensions(dimensions);
  const suffix = Object.entries(normalizedDimensions)
    .map(([key, value]) => `${key}=${value}`)
    .join('|');
  return suffix ? `${normalizedMetric}|${suffix}` : normalizedMetric;
};

export const normalizeTelemetryEvent = (
  event: unknown,
): TelemetryEvent | null => {
  if (!isRecord(event)) return null;
  const metric = normalizeText(event.metric);
  const value = normalizeFiniteNumber(event.value, null);
  if (!metric || value === null) return null;

  return {
    metric,
    value,
    dimensions: normalizeTelemetryDimensions(event.dimensions),
    timestamp: normalizeFiniteNumber(event.timestamp, null),
  };
};

export const createSearchTelemetryCollector = (
  options: SearchTelemetryCollectorOptions = {},
): SearchTelemetryCollector => {
  const maxSamples = normalizeInteger(options.maxSamples, {
    min: 1,
    max: MAX_SAMPLE_WINDOW,
    fallback: DEFAULT_SAMPLE_WINDOW,
  }) ?? DEFAULT_SAMPLE_WINDOW;
  const series = new Map<string, SeriesState>();
  let acceptedEvents = 0;
  let rejectedEvents = 0;

  const getSeries = (metric: unknown, dimensions: unknown): SeriesState => {
    const key = createMetricSeriesKey(metric, dimensions);
    const existing = series.get(key);
    if (existing) return existing;

    const state: SeriesState = {
      key,
      metric: normalizeText(metric),
      dimensions: normalizeTelemetryDimensions(dimensions),
      window: createRollingSampleWindow({ maxSamples }),
    };
    series.set(key, state);
    return state;
  };

  const collector: SearchTelemetryCollector = {
    record(event) {
      const normalized = normalizeTelemetryEvent(event);
      if (!normalized) {
        rejectedEvents += 1;
        return false;
      }
      getSeries(normalized.metric, normalized.dimensions)
        .window.add(normalized.value);
      acceptedEvents += 1;
      return true;
    },

    recordMetric(metric, value, dimensions = {}) {
      return collector.record({ metric, value, dimensions });
    },

    get(metric, dimensions = {}) {
      return getSeries(metric, dimensions).window.summary();
    },

    find(metric) {
      const normalized = normalizeText(metric);
      return Array.from(series.values())
        .filter(item => item.metric === normalized)
        .map<TelemetrySeriesSnapshot>(item => ({
          key: item.key,
          metric: item.metric,
          dimensions: { ...item.dimensions },
          summary: item.window.summary(),
        }));
    },

    snapshot(): SearchTelemetrySnapshot {
      return {
        acceptedEvents,
        rejectedEvents,
        seriesCount: series.size,
        series: Array.from(series.values()).map(item => ({
          key: item.key,
          metric: item.metric,
          dimensions: { ...item.dimensions },
          summary: item.window.summary(),
        })),
      };
    },

    clear() {
      const count = series.size;
      series.clear();
      acceptedEvents = 0;
      rejectedEvents = 0;
      return count;
    },
  };

  return collector;
};

export const aggregateMetric = (
  snapshot: SearchTelemetrySnapshot | null | undefined,
  metric: string,
): NumericSampleSummary => {
  const matching = (snapshot?.series ?? [])
    .filter(item => item.metric === metric);
  const values = matching.flatMap(item => {
    const summary = item.summary;
    if (!summary.count
      || summary.average === null
      || summary.min === null
      || summary.max === null
      || summary.p50 === null
      || summary.p90 === null
      || summary.p95 === null
      || summary.p99 === null) {
      return [];
    }
    return [{
      count: summary.count,
      average: summary.average,
      min: summary.min,
      max: summary.max,
      p50: summary.p50,
      p90: summary.p90,
      p95: summary.p95,
      p99: summary.p99,
      sum: summary.sum,
      latest: summary.latest,
    }];
  });

  if (!values.length) return summarizeNumericSamples([]);

  const count = values.reduce((total, item) => total + item.count, 0);
  const sum = values.reduce((total, item) => total + item.sum, 0);
  const weightedAverage = values.reduce(
    (total, item) => total + item.average * item.count,
    0,
  ) / count;

  return {
    count,
    min: Math.min(...values.map(item => item.min)),
    max: Math.max(...values.map(item => item.max)),
    sum,
    average: weightedAverage,
    p50: Math.max(...values.map(item => item.p50)),
    p90: Math.max(...values.map(item => item.p90)),
    p95: Math.max(...values.map(item => item.p95)),
    p99: Math.max(...values.map(item => item.p99)),
    latest: values.at(-1)?.latest ?? null,
  };
};
