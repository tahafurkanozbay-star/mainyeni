import { describe, expect, it } from 'vitest';
import {
  classifyCategoryValue,
  classifyNumericValue,
  createCategoryClassification,
  createNumericClassification,
  summarizeSpatialStatistics,
  type SpatialStatisticsBudget,
} from './spatialStatisticsRuntime';

const budget: SpatialStatisticsBudget = {
  maxObservations: 1_000,
  maxCategories: 8,
  maxHistogramBins: 16,
  maxBreaks: 8,
  maxPercentiles: 8,
};

describe('spatialStatisticsRuntime', () => {
  it('summarizes finite values, weights, percentiles and categories deterministically', () => {
    const summary = summarizeSpatialStatistics([
      { value: 1, weight: 1, category: 'a' },
      { value: 2, weight: 2, category: 'a' },
      { value: 3, weight: 1, category: 'b' },
      { value: 4, weight: 0, category: 'b' },
    ], budget, { histogramBins: 2, percentiles: [0, 0.5, 1] });

    expect(summary).toMatchObject({
      inputCount: 4,
      acceptedCount: 4,
      rejectedCount: 0,
      zeroWeightCount: 1,
      min: 1,
      max: 4,
      mean: 2.5,
      median: 2.5,
      weightedMean: 2,
      truncated: false,
    });
    expect(summary.percentiles.map((item) => item.value)).toEqual([1, 2.5, 4]);
    expect(summary.histogram.map((bin) => bin.count)).toEqual([2, 2]);
    expect(summary.categories.map((item) => item.key)).toEqual(['string:a', 'string:b']);
  });

  it('rejects malformed values and negative weights without poisoning the summary', () => {
    const summary = summarizeSpatialStatistics([
      { value: Number.NaN },
      { value: 5, weight: -1 },
      { value: 9, weight: 2 },
    ], budget);
    expect(summary.acceptedCount).toBe(1);
    expect(summary.rejectedCount).toBe(2);
    expect(summary.mean).toBe(9);
    expect(summary.weightedMean).toBe(9);
  });

  it('fails closed when observation and category budgets are exhausted', () => {
    const summary = summarizeSpatialStatistics([
      { value: 1, category: 'a' },
      { value: 2, category: 'b' },
      { value: 3, category: 'c' },
    ], { ...budget, maxObservations: 2, maxCategories: 1 });
    expect(summary.truncated).toBe(true);
    expect(summary.diagnostics).toContain('observation-budget-exhausted');
    expect(summary.diagnostics).toContain('category-budget-exhausted');
    expect(summary.acceptedCount).toBe(2);
    expect(summary.categories).toHaveLength(1);
  });

  it('builds equal-interval breaks and classifies boundary values', () => {
    const classification = createNumericClassification(
      [0, 10, 20, 30, 40].map((value) => ({ value })),
      'equal-interval',
      4,
      budget,
    );
    expect(classification.breaks).toEqual([10, 20, 30, 40]);
    expect(classifyNumericValue(0, classification)).toBe(0);
    expect(classifyNumericValue(10, classification)).toBe(0);
    expect(classifyNumericValue(10.1, classification)).toBe(1);
    expect(classifyNumericValue(100, classification)).toBe(3);
  });

  it('builds monotonic quantile breaks even with duplicate values', () => {
    const classification = createNumericClassification(
      [1, 1, 1, 2, 3, 4, 5, 5].map((value) => ({ value })),
      'quantile',
      4,
      budget,
    );
    expect(classification.breaks).toEqual([...classification.breaks].sort((a, b) => a - b));
    expect(classification.breaks[classification.breaks.length - 1]).toBe(5);
    expect(new Set(classification.breaks).size).toBe(classification.breaks.length);
  });

  it('supports standard-deviation classification while clamping breaks to the observed range', () => {
    const classification = createNumericClassification(
      [1, 2, 3, 4, 5, 6, 7].map((value) => ({ value })),
      'standard-deviation',
      5,
      budget,
    );
    expect(classification.breaks.length).toBeGreaterThan(1);
    expect(classification.breaks.every((value) => value >= 1 && value <= 7)).toBe(true);
    expect(classification.breaks[classification.breaks.length - 1]).toBe(7);
  });

  it('enforces percentile and break budgets', () => {
    expect(() => summarizeSpatialStatistics(
      [{ value: 1 }],
      { ...budget, maxPercentiles: 1 },
      { percentiles: [0.25, 0.75] },
    )).toThrow(/percentile budget/);

    const classification = createNumericClassification(
      [0, 10, 20, 30].map((value) => ({ value })),
      'equal-interval',
      10,
      { ...budget, maxBreaks: 2 },
    );
    expect(classification.breaks.length).toBeLessThanOrEqual(3);
    expect(classification.diagnostics).toContain('break-budget-exhausted');
  });

  it('honors AbortSignal during collection', () => {
    const controller = new AbortController();
    controller.abort(new Error('cancel statistics'));
    expect(() => summarizeSpatialStatistics([{ value: 1 }], budget, { signal: controller.signal }))
      .toThrow('cancel statistics');
  });

  it('builds bounded categorical classes with deterministic other accounting', () => {
    const classification = createCategoryClassification([
      { value: null, category: 'parks', weight: 2 },
      { value: null, category: 'parks', weight: 1 },
      { value: null, category: 'roads', weight: 4 },
      { value: null, category: 'schools', weight: 3 },
      { value: null, category: 'hospitals', weight: 5 },
    ], 2, budget);

    expect(classification.entries).toEqual([
      { key: 'string:parks', classIndex: 0, count: 2, weight: 3 },
      { key: 'string:hospitals', classIndex: 1, count: 1, weight: 5 },
    ]);
    expect(classification.otherCount).toBe(2);
    expect(classification.otherWeight).toBe(7);
    expect(classification.truncated).toBe(true);
    expect(classification.diagnostics).toContain('class-budget-exhausted');
    expect(classifyCategoryValue('parks', classification)).toBe(0);
    expect(classifyCategoryValue('roads', classification)).toBeNull();
  });

  it('keeps string and numeric category identities distinct and bounds cardinality', () => {
    const classification = createCategoryClassification([
      { value: 1, category: 7 },
      { value: 1, category: '7' },
      { value: 1, category: 8 },
    ], 3, { ...budget, maxCategories: 2 });

    expect(classification.entries.map((entry) => entry.key)).toEqual(['number:7', 'string:7']);
    expect(classification.otherCount).toBe(1);
    expect(classification.diagnostics).toContain('category-budget-exhausted');
    expect(classifyCategoryValue(7, classification)).toBe(0);
    expect(classifyCategoryValue('7', classification)).toBe(1);
  });

  it('rejects missing categories and invalid weights in categorical classification', () => {
    const classification = createCategoryClassification([
      { value: null, category: null },
      { value: null, category: 'bad', weight: -1 },
      { value: null, category: 'good', weight: 0 },
    ], 2, budget);
    expect(classification.acceptedCount).toBe(1);
    expect(classification.rejectedCount).toBe(2);
    expect(classification.entries).toEqual([
      { key: 'string:good', classIndex: 0, count: 1, weight: 0 },
    ]);
  });

});
