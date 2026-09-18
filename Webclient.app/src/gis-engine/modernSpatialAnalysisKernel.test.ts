import { describe, expect, it, vi } from 'vitest';
import {
  createModernSpatialAnalysisKernel,
  type ModernSpatialAnalysisKernelConfiguration,
} from './modernSpatialAnalysisKernel';

const configuration: ModernSpatialAnalysisKernelConfiguration = {
  geometry: { maxVertices: 10_000, maxSegments: 10_000, maxRings: 32 },
  selection: { maxCandidates: 10_000, maxSelected: 1_000, maxPolygonVertices: 1_000 },
  aggregation: { maxPoints: 10_000, maxCells: 1_000, maxCategoriesPerCell: 16 },
  join: {
    maxFeatures: 10_000,
    maxPolygons: 1_000,
    maxRingVertices: 10_000,
    maxCandidatePairs: 100_000,
    maxMatches: 10_000,
  },
  topology: {
    maxRings: 32,
    maxVertices: 10_000,
    maxSegments: 10_000,
    maxSegmentPairs: 100_000,
    maxIntersections: 256,
    maxIssues: 512,
  },
  statistics: {
    maxObservations: 10_000,
    maxCategories: 64,
    maxHistogramBins: 64,
    maxBreaks: 16,
    maxPercentiles: 16,
  },
  jobs: {
    maxConcurrent: 2,
    maxQueued: 8,
    maxHistory: 16,
    defaultTimeoutMs: 0,
  },
};

describe('modernSpatialAnalysisKernel', () => {
  it('combines topology validation with polygon measurement', () => {
    const kernel = createModernSpatialAnalysisKernel(configuration);
    const result = kernel.analyzePolygon([[
      { x: 0, y: 0 },
      { x: 4, y: 0 },
      { x: 4, y: 4 },
      { x: 0, y: 4 },
      { x: 0, y: 0 },
    ]]);
    expect(result.trustworthyMeasurement).toBe(true);
    expect(result.measurement.area).toBe(16);
    expect(result.topology.valid).toBe(true);
  });

  it('marks a self-intersecting polygon measurement as untrustworthy', () => {
    const kernel = createModernSpatialAnalysisKernel(configuration);
    const result = kernel.analyzePolygon([[
      { x: 0, y: 0 },
      { x: 4, y: 4 },
      { x: 0, y: 4 },
      { x: 4, y: 0 },
      { x: 0, y: 0 },
    ]]);
    expect(result.trustworthyMeasurement).toBe(false);
    expect(result.topology.issues.some((issue) => issue.code === 'self-intersection')).toBe(true);
  });

  it('composes selection, buffer, aggregation and join without network behavior', () => {
    const kernel = createModernSpatialAnalysisKernel(configuration);
    const features = [
      { id: 1, point: { x: 1, y: 1 }, data: 'inside' },
      { id: 2, point: { x: 20, y: 20 }, data: 'outside' },
    ];
    const selection = kernel.selectExtent(features, { xmin: 0, ymin: 0, xmax: 5, ymax: 5 });
    expect(selection.features.map((feature) => feature.id)).toEqual([1]);

    const buffer = kernel.bufferPoint({ x: 1, y: 1 }, {
      distance: 2,
      segmentsPerQuarter: 2,
      maxInputVertices: 8,
      maxOutputVertices: 16,
      join: 'round',
    });
    expect(buffer.ring.length).toBeGreaterThan(4);

    const aggregation = kernel.aggregate([
      { x: 1, y: 1, category: 'park' },
      { x: 1.5, y: 1.5, category: 'park' },
    ], 10);
    expect(aggregation.cells[0]?.count).toBe(2);

    const joined = kernel.join(
      [{ id: 'a', point: { x: 1, y: 1 } }],
      [{ id: 'zone', rings: [[
        { x: 0, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 2 }, { x: 0, y: 2 }, { x: 0, y: 0 },
      ]] }],
    );
    expect(joined.matches).toEqual([{ featureId: 'a', polygonId: 'zone' }]);
  });

  it('provides bounded statistics and reusable numeric classification', () => {
    const kernel = createModernSpatialAnalysisKernel(configuration);
    const observations = [1, 2, 3, 4, 5].map((value) => ({ value }));
    const summary = kernel.statistics(observations, { histogramBins: 5 });
    const classification = kernel.classify(observations, 'equal-interval', 5);
    expect(summary.mean).toBe(3);
    expect(classification.breaks[classification.breaks.length - 1]).toBe(5);
    expect(kernel.classifyValue(3.1, classification)).toBe(3);
  });

  it('exposes categorical classification through the unified kernel contract', () => {
    const kernel = createModernSpatialAnalysisKernel(configuration);
    const classification = kernel.classifyCategories([
      { value: null, category: 'parks' },
      { value: null, category: 'parks' },
      { value: null, category: 'roads' },
      { value: null, category: 'schools' },
    ], 2);
    expect(classification.entries.map((entry) => entry.key)).toEqual(['string:parks', 'string:roads']);
    expect(classification.otherCount).toBe(1);
    expect(kernel.classifyCategory('parks', classification)).toBe(0);
    expect(kernel.classifyCategory('schools', classification)).toBeNull();
  });

  it('deduplicates submitted analysis jobs behind one kernel task', async () => {
    const kernel = createModernSpatialAnalysisKernel(configuration);
    let resolve!: (value: number) => void;
    const gate = new Promise<number>((resolvePromise) => { resolve = resolvePromise; });
    const work = vi.fn(async () => gate);
    const first = kernel.submit('layer:population:stats', work);
    const second = kernel.submit('layer:population:stats', work);
    await Promise.resolve();
    expect(work).toHaveBeenCalledTimes(1);
    resolve(7);
    await expect(first).resolves.toBe(7);
    await expect(second).resolves.toBe(7);
    expect(kernel.snapshot().jobs.deduped).toBe(1);
  });

  it('propagates cancellation through scheduled analysis', async () => {
    const kernel = createModernSpatialAnalysisKernel(configuration);
    const controller = new AbortController();
    let sharedSignal: AbortSignal | undefined;
    const result = kernel.submit('cancel-me', async (_kernel, signal) => {
      sharedSignal = signal;
      return new Promise<number>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    }, { signal: controller.signal });
    await Promise.resolve();
    controller.abort(new Error('user cancelled'));
    await expect(result).rejects.toThrow('user cancelled');
    expect(sharedSignal?.aborted).toBe(true);
  });

  it('disposes the scheduler and rejects future operations', async () => {
    const kernel = createModernSpatialAnalysisKernel(configuration);
    kernel.dispose();
    expect(kernel.snapshot().disposed).toBe(true);
    expect(() => kernel.measureLine([{ x: 0, y: 0 }, { x: 1, y: 1 }])).toThrow(/disposed/);
    expect(() => kernel.submit('later', () => 1)).toThrow(/disposed/);
  });
});
