export type SpatialStatisticCategory = string | number | boolean | null;

export type SpatialStatisticObservation = Readonly<{
  value: number | null | undefined;
  weight?: number;
  category?: SpatialStatisticCategory;
}>;

export type SpatialStatisticsBudget = Readonly<{
  maxObservations: number;
  maxCategories: number;
  maxHistogramBins: number;
  maxBreaks: number;
  maxPercentiles: number;
}>;

export type SpatialStatisticsOptions = Readonly<{
  histogramBins?: number;
  percentiles?: readonly number[];
  signal?: AbortSignal;
}>;

export type SpatialCategorySummary = Readonly<{
  key: string;
  count: number;
  weight: number;
}>;

export type SpatialHistogramBin = Readonly<{
  index: number;
  min: number;
  max: number;
  count: number;
  weight: number;
}>;

export type SpatialPercentile = Readonly<{
  percentile: number;
  value: number;
}>;

export type SpatialStatisticsSummary = Readonly<{
  inputCount: number;
  acceptedCount: number;
  rejectedCount: number;
  zeroWeightCount: number;
  min: number | null;
  max: number | null;
  sum: number;
  mean: number | null;
  weightedMean: number | null;
  variance: number | null;
  standardDeviation: number | null;
  median: number | null;
  percentiles: readonly SpatialPercentile[];
  categories: readonly SpatialCategorySummary[];
  histogram: readonly SpatialHistogramBin[];
  truncated: boolean;
  diagnostics: readonly string[];
}>;

export type NumericClassificationMethod = 'equal-interval' | 'quantile' | 'standard-deviation';

export type NumericClassificationResult = Readonly<{
  method: NumericClassificationMethod;
  breaks: readonly number[];
  classCount: number;
  min: number | null;
  max: number | null;
  truncated: boolean;
  diagnostics: readonly string[];
}>;

type AcceptedObservation = {
  value: number;
  weight: number;
  category: string | null;
};

type MutableCategory = {
  count: number;
  weight: number;
};

const positiveInteger = (value: number, name: string): number => {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive safe integer`);
  return value;
};

const finite = (value: number, name: string): number => {
  if (!Number.isFinite(value)) throw new TypeError(`${name} must be finite`);
  return value;
};

const throwIfAborted = (signal?: AbortSignal): void => {
  if (signal?.aborted) throw signal.reason ?? new DOMException('Spatial statistics analysis aborted', 'AbortError');
};

export const normalizeSpatialStatisticsBudget = (budget: SpatialStatisticsBudget): SpatialStatisticsBudget => ({
  maxObservations: positiveInteger(budget.maxObservations, 'maxObservations'),
  maxCategories: positiveInteger(budget.maxCategories, 'maxCategories'),
  maxHistogramBins: positiveInteger(budget.maxHistogramBins, 'maxHistogramBins'),
  maxBreaks: positiveInteger(budget.maxBreaks, 'maxBreaks'),
  maxPercentiles: positiveInteger(budget.maxPercentiles, 'maxPercentiles'),
});

const categoryKey = (value: SpatialStatisticCategory | undefined): string | null => {
  if (value === null || value === undefined) return null;
  return `${typeof value}:${String(value)}`;
};

const kahanSum = (values: readonly number[]): number => {
  let sum = 0;
  let correction = 0;
  for (const value of values) {
    const adjusted = value - correction;
    const next = sum + adjusted;
    correction = (next - sum) - adjusted;
    sum = next;
  }
  return sum;
};

const quantileSorted = (sorted: readonly number[], percentile: number): number | null => {
  if (sorted.length === 0) return null;
  if (sorted.length === 1) return sorted[0]!;
  const position = (sorted.length - 1) * percentile;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower]!;
  const fraction = position - lower;
  return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * fraction;
};

const collectObservations = (
  observations: readonly SpatialStatisticObservation[],
  budget: SpatialStatisticsBudget,
  signal?: AbortSignal,
): Readonly<{
  accepted: readonly AcceptedObservation[];
  rejected: number;
  zeroWeight: number;
  truncated: boolean;
  diagnostics: readonly string[];
}> => {
  const accepted: AcceptedObservation[] = [];
  const diagnostics: string[] = [];
  let rejected = 0;
  let zeroWeight = 0;
  const limit = Math.min(observations.length, budget.maxObservations);
  const truncated = observations.length > limit;
  if (truncated) diagnostics.push('observation-budget-exhausted');

  for (let index = 0; index < limit; index += 1) {
    if ((index & 127) === 0) throwIfAborted(signal);
    const observation = observations[index]!;
    if (!Number.isFinite(observation.value)) {
      rejected += 1;
      continue;
    }
    const weight = observation.weight ?? 1;
    if (!Number.isFinite(weight) || weight < 0) {
      rejected += 1;
      continue;
    }
    if (weight === 0) zeroWeight += 1;
    accepted.push({
      value: Number(observation.value),
      weight,
      category: categoryKey(observation.category),
    });
  }
  throwIfAborted(signal);
  return { accepted, rejected, zeroWeight, truncated, diagnostics };
};

const buildCategorySummary = (
  accepted: readonly AcceptedObservation[],
  maxCategories: number,
): Readonly<{ categories: readonly SpatialCategorySummary[]; truncated: boolean }> => {
  const categories = new Map<string, MutableCategory>();
  let truncated = false;
  for (const item of accepted) {
    if (item.category === null) continue;
    const existing = categories.get(item.category);
    if (existing) {
      existing.count += 1;
      existing.weight += item.weight;
      continue;
    }
    if (categories.size >= maxCategories) {
      truncated = true;
      continue;
    }
    categories.set(item.category, { count: 1, weight: item.weight });
  }
  return {
    categories: [...categories.entries()]
      .map(([key, value]) => ({ key, count: value.count, weight: value.weight }))
      .sort((left, right) => right.count - left.count || right.weight - left.weight || left.key.localeCompare(right.key)),
    truncated,
  };
};

const buildHistogram = (
  accepted: readonly AcceptedObservation[],
  binsInput: number,
  maxBins: number,
  min: number,
  max: number,
): readonly SpatialHistogramBin[] => {
  const bins = Math.min(positiveInteger(binsInput, 'histogramBins'), maxBins);
  if (accepted.length === 0) return [];
  if (min === max) {
    return [{ index: 0, min, max, count: accepted.length, weight: kahanSum(accepted.map((item) => item.weight)) }];
  }
  const width = (max - min) / bins;
  const mutable = Array.from({ length: bins }, (_, index) => ({
    index,
    min: min + width * index,
    max: index === bins - 1 ? max : min + width * (index + 1),
    count: 0,
    weight: 0,
  }));
  for (const item of accepted) {
    const index = Math.min(bins - 1, Math.max(0, Math.floor((item.value - min) / width)));
    const target = mutable[index]!;
    target.count += 1;
    target.weight += item.weight;
  }
  return mutable;
};

export const summarizeSpatialStatistics = (
  observations: readonly SpatialStatisticObservation[],
  budgetInput: SpatialStatisticsBudget,
  options: SpatialStatisticsOptions = {},
): SpatialStatisticsSummary => {
  const budget = normalizeSpatialStatisticsBudget(budgetInput);
  const collected = collectObservations(observations, budget, options.signal);
  const values = collected.accepted.map((item) => item.value);
  const sorted = [...values].sort((left, right) => left - right);
  const sum = kahanSum(values);
  const min = sorted.length ? sorted[0]! : null;
  const max = sorted.length ? sorted[sorted.length - 1]! : null;
  const mean = sorted.length ? sum / sorted.length : null;
  const weightSum = kahanSum(collected.accepted.map((item) => item.weight));
  const weightedSum = kahanSum(collected.accepted.map((item) => item.value * item.weight));
  const weightedMean = weightSum > 0 ? weightedSum / weightSum : null;
  const variance = mean === null
    ? null
    : kahanSum(values.map((value) => (value - mean) ** 2)) / values.length;
  const standardDeviation = variance === null ? null : Math.sqrt(variance);
  const median = quantileSorted(sorted, 0.5);

  const percentileInputs = options.percentiles ?? [0.25, 0.5, 0.75];
  if (percentileInputs.length > budget.maxPercentiles) {
    throw new RangeError('percentile budget exceeded');
  }
  const percentiles = percentileInputs.map((percentile, index) => {
    const normalized = finite(percentile, `percentiles[${index}]`);
    if (normalized < 0 || normalized > 1) throw new RangeError('percentiles must be between 0 and 1');
    return { percentile: normalized, value: quantileSorted(sorted, normalized) ?? 0 };
  });

  const categorySummary = buildCategorySummary(collected.accepted, budget.maxCategories);
  const diagnostics = [...collected.diagnostics];
  if (categorySummary.truncated) diagnostics.push('category-budget-exhausted');
  const histogram = min === null || max === null
    ? []
    : buildHistogram(collected.accepted, options.histogramBins ?? Math.min(10, budget.maxHistogramBins), budget.maxHistogramBins, min, max);

  return {
    inputCount: observations.length,
    acceptedCount: collected.accepted.length,
    rejectedCount: collected.rejected,
    zeroWeightCount: collected.zeroWeight,
    min,
    max,
    sum,
    mean,
    weightedMean,
    variance,
    standardDeviation,
    median,
    percentiles,
    categories: categorySummary.categories,
    histogram,
    truncated: collected.truncated || categorySummary.truncated,
    diagnostics,
  };
};

const clampClassCount = (classesInput: number, budget: SpatialStatisticsBudget): number => (
  Math.min(positiveInteger(classesInput, 'classes'), budget.maxBreaks + 1)
);

const uniqueSorted = (values: readonly number[]): number[] => [...new Set(values)].sort((left, right) => left - right);

export const createNumericClassification = (
  observations: readonly SpatialStatisticObservation[],
  method: NumericClassificationMethod,
  classesInput: number,
  budgetInput: SpatialStatisticsBudget,
  options: Readonly<{ signal?: AbortSignal }> = {},
): NumericClassificationResult => {
  const budget = normalizeSpatialStatisticsBudget(budgetInput);
  const collected = collectObservations(observations, budget, options.signal);
  const values = collected.accepted.map((item) => item.value).sort((left, right) => left - right);
  const diagnostics = [...collected.diagnostics];
  if (values.length === 0) {
    return { method, breaks: [], classCount: 0, min: null, max: null, truncated: collected.truncated, diagnostics };
  }

  const min = values[0]!;
  const max = values[values.length - 1]!;
  const requestedClasses = clampClassCount(classesInput, budget);
  if (requestedClasses < classesInput) diagnostics.push('break-budget-exhausted');
  if (min === max || requestedClasses === 1) {
    return { method, breaks: [max], classCount: 1, min, max, truncated: collected.truncated, diagnostics };
  }

  let breaks: number[];
  if (method === 'equal-interval') {
    const width = (max - min) / requestedClasses;
    breaks = Array.from({ length: requestedClasses }, (_, index) => (
      index === requestedClasses - 1 ? max : min + width * (index + 1)
    ));
  } else if (method === 'quantile') {
    breaks = Array.from({ length: requestedClasses }, (_, index) => (
      quantileSorted(values, (index + 1) / requestedClasses) ?? max
    ));
  } else {
    const mean = kahanSum(values) / values.length;
    const variance = kahanSum(values.map((value) => (value - mean) ** 2)) / values.length;
    const deviation = Math.sqrt(variance);
    if (deviation === 0) {
      breaks = [max];
    } else {
      const half = requestedClasses / 2;
      breaks = Array.from({ length: requestedClasses }, (_, index) => {
        const standardUnits = index + 1 - half;
        return Math.min(max, Math.max(min, mean + standardUnits * deviation));
      });
      breaks[breaks.length - 1] = max;
    }
  }

  const normalizedBreaks = uniqueSorted(breaks).slice(0, budget.maxBreaks + 1);
  return {
    method,
    breaks: normalizedBreaks,
    classCount: normalizedBreaks.length,
    min,
    max,
    truncated: collected.truncated || normalizedBreaks.length < Math.min(requestedClasses, uniqueSorted(breaks).length),
    diagnostics,
  };
};

export const classifyNumericValue = (
  valueInput: number,
  classification: NumericClassificationResult,
): number | null => {
  const value = finite(valueInput, 'value');
  if (classification.breaks.length === 0) return null;
  for (let index = 0; index < classification.breaks.length; index += 1) {
    if (value <= classification.breaks[index]!) return index;
  }
  return classification.breaks.length - 1;
};
