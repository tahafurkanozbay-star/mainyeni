import {
  DataSearchRuntime,
  SearchObservability,
  compareQueryPlans,
  compileQueryPlan,
  datasetMetricBucket,
  queryLengthBucket,
  summarizeQueryPlan,
} from './index';

const makeRecords = count => Array.from({ length: count }, (_, index) => ({
  id: String(index + 1),
  title: index % 10 === 0 ? `Park ${index}` : `Kayıt ${index}`,
  category: index % 10 === 0 ? 'Park' : 'Diğer',
  district: index % 2 === 0 ? 'Çankaya' : 'Mamak',
  neighborhood: index % 2 === 0 ? 'Ayrancı' : 'Akdere',
  street: index % 10 === 0 ? 'Hoşdere Caddesi' : `Sokak ${index}`,
  latitude: 39.9 + (index % 20) * 0.0001,
  longitude: 32.85 + (index % 20) * 0.0001,
}));

describe('query plan runtime', () => {
  const runtime = new DataSearchRuntime({
    candidatePlanner: { fallbackScanThreshold: 50 },
  });
  const dataset = runtime.register('places', makeRecords(200));

  test('compiles indexed plan with explicit stages and deterministic fingerprint', () => {
    const first = compileQueryPlan(dataset, {
      query: 'park',
      district: 'Çankaya',
      facetFields: ['category'],
      limit: 10,
    });
    const second = compileQueryPlan(dataset, {
      query: 'park',
      district: 'Çankaya',
      facetFields: ['category'],
      limit: 10,
    });

    expect(first.fingerprint).toBe(second.fingerprint);
    expect(first.fullScan).toBe(false);
    expect(first.estimatedCandidateCount).toBeLessThan(dataset.records.length);
    expect(first.stages.map(stage => stage.kind)).toEqual(expect.arrayContaining([
      'candidate-index',
      'hierarchy-filter',
      'scoring',
      'facet',
      'pagination',
    ]));
  });

  test('adds spatial intersection stage for radius query', () => {
    const plan = compileQueryPlan(dataset, {
      query: 'park',
      center: [32.85, 39.9],
      radiusMeters: 500,
      sort: 'distance',
    });

    expect(plan.spatialCandidatePositions).not.toBeNull();
    expect(plan.stages.some(stage => stage.kind === 'spatial-index')).toBe(true);
    expect(plan.candidatePlan.candidatePositions.length).toBeLessThanOrEqual(plan.estimatedCandidateCount);
  });

  test('marks unbounded empty query as a scan risk instead of hiding it', () => {
    const plan = compileQueryPlan(dataset, { query: '', limit: 50 });

    expect(plan.fullScan).toBe(true);
    expect(['medium', 'high']).toContain(plan.risk);
    expect(plan.estimatedCandidateCount).toBe(dataset.records.length);
  });

  test('respects candidate budget and emits warning for truncated planning', () => {
    const plan = compileQueryPlan(dataset, { query: '' }, { maxCandidates: 100 });

    expect(plan.estimatedCandidateCount).toBe(100);
    expect(plan.warnings).toContain('candidate-budget-reached');
    expect(plan.stages.find(stage => stage.kind === 'candidate-index').bounded).toBe(true);
  });

  test('compares plan regression by work and risk', () => {
    const selective = compileQueryPlan(dataset, { query: 'park' });
    const scan = compileQueryPlan(dataset, { query: '' });
    const comparison = compareQueryPlans(selective, scan);

    expect(comparison.workDelta).toBeGreaterThan(0);
    expect(comparison.candidateDelta).toBeGreaterThan(0);
    expect(comparison.regressed).toBe(true);
  });

  test('summary omits raw records and raw query text', () => {
    const plan = compileQueryPlan(dataset, { query: 'Kuğulu Park', district: 'Çankaya' });
    const summary = summarizeQueryPlan(plan);
    const serialized = JSON.stringify(summary);

    expect(serialized).not.toContain('Kuğulu Park');
    expect(serialized).not.toContain('source');
    expect(summary).toEqual(expect.objectContaining({
      datasetKey: 'places',
      candidateCount: expect.any(Number),
      workUnits: expect.any(Number),
      risk: expect.any(String),
    }));
  });
});

describe('privacy-safe bounded observability', () => {
  test('buckets query length without retaining query value', () => {
    expect(queryLengthBucket(0)).toBe('empty');
    expect(queryLengthBucket(2)).toBe('1-2');
    expect(queryLengthBucket(8)).toBe('6-10');
    expect(queryLengthBucket(100)).toBe('41+');
  });

  test('hashes dataset labels into stable operational buckets', () => {
    expect(datasetMetricBucket('places')).toBe(datasetMetricBucket('PLACES'));
    expect(datasetMetricBucket('places')).not.toBe('places');
    expect(datasetMetricBucket('addresses')).not.toBe(datasetMetricBucket('places'));
  });

  test('retains only bounded recent metric samples', () => {
    const observability = new SearchObservability({ maxSamples: 10 });
    for (let index = 0; index < 25; index += 1) {
      observability.record({
        operation: 'search',
        durationMs: index,
        datasetBucket: datasetMetricBucket('places'),
        queryLengthBucket: queryLengthBucket(index),
        candidateCount: index,
        resultCount: 1,
        cacheHit: false,
        aborted: false,
        failed: false,
        planRisk: 'low',
        quarantinedCount: 0,
        rejectedCount: 0,
      });
    }

    expect(observability.snapshot().sampleCount).toBe(10);
    expect(observability.recent(100)).toHaveLength(10);
  });

  test('calculates deterministic latency percentiles', () => {
    const observability = new SearchObservability({ maxSamples: 100 });
    [10, 20, 30, 40, 50, 60, 70, 80, 90, 100].forEach(durationMs => {
      observability.record({
        operation: 'search',
        durationMs,
        datasetBucket: 'dataset-a',
        queryLengthBucket: '3-5',
        candidateCount: 10,
        resultCount: 2,
        cacheHit: false,
        aborted: false,
        failed: false,
        planRisk: 'low',
        quarantinedCount: 0,
        rejectedCount: 0,
      });
    });
    const snapshot = observability.snapshot();

    expect(snapshot.p50SearchMs).toBe(50);
    expect(snapshot.p95SearchMs).toBe(100);
    expect(snapshot.p99SearchMs).toBe(100);
    expect(snapshot.averageCandidateCount).toBe(10);
  });

  test('release evaluation surfaces latency and failure budget violations', () => {
    const observability = new SearchObservability({
      budget: {
        p95SearchMs: 50,
        p99SearchMs: 80,
        maxFailureRatio: 0.05,
        maxHighRiskPlanRatio: 0.05,
      },
    });
    for (let index = 0; index < 20; index += 1) {
      observability.record({
        operation: 'search',
        durationMs: 100,
        datasetBucket: 'dataset-a',
        queryLengthBucket: '3-5',
        candidateCount: 10_000,
        resultCount: 10,
        cacheHit: false,
        aborted: false,
        failed: index === 0,
        planRisk: index === 0 ? 'high' : 'low',
        quarantinedCount: 0,
        rejectedCount: 0,
      });
    }
    const evaluation = observability.evaluate();

    expect(evaluation.withinBudget).toBe(false);
    expect(evaluation.violations).toEqual(expect.arrayContaining([
      'p95-search-latency',
      'p99-search-latency',
    ]));
  });

  test('reset clears operational history', () => {
    const observability = new SearchObservability();
    observability.recordFailure('search', 'places', 10, { queryLength: 4 });
    expect(observability.snapshot().sampleCount).toBe(1);
    observability.reset();
    expect(observability.snapshot().sampleCount).toBe(0);
  });
});
