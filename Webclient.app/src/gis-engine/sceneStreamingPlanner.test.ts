import {
  createSceneStreamingPlanner,
  planSceneStreaming,
  scoreSceneStreamingCandidates,
} from './sceneStreamingPlanner';

const budget = (overrides = {}) => ({
  tier: 'balanced', maxVisibleFeatures: 6500, maxPointSymbols: 4800, maxLabels: 700, maxSceneNodes: 1900,
  maxResidentBytes: 1000, maxConcurrentRequests: 3, maxConcurrentLayerLoads: 3, sceneQuality: 0.72,
  labelDensity: 0.62, enableShadows: false, enableExtrusion: true, allowPrefetch: true, geometryDetail: 0.7,
  framePressure: 'none', memoryPressure: 'low', ...overrides,
});

const candidate = (id, overrides = {}) => ({
  id,
  layerId: 'buildings',
  serviceId: 'scene',
  resourceUrl: 'https://example.test/arcgis/rest/services/Buildings/SceneServer',
  resourceKind: 'scene-service',
  estimatedBytes: 100,
  distance: 100,
  screenArea: 0.5,
  importance: 50,
  visible: true,
  loaded: false,
  loading: false,
  ...overrides,
});

describe('sceneStreamingPlanner', () => {
  test('loads visible candidates by deterministic priority', () => {
    const decision = planSceneStreaming({
      candidates: [candidate('far', { distance: 100000, importance: 20 }), candidate('near', { distance: 10, importance: 90 })],
      view: { kind: '3d', stationary: true }, budget: budget(),
    });
    expect(decision.load[0]).toBe('near');
    expect(decision.load).toContain('far');
  });
  test('prefetches non-visible candidates only while stationary', () => {
    const decision = planSceneStreaming({ candidates: [candidate('background', { visible: false })], view: { kind: '3d', stationary: true }, budget: budget() });
    expect(decision.prefetch).toEqual(['background']);
  });
  test('does not prefetch while the camera is moving', () => {
    const decision = planSceneStreaming({ candidates: [candidate('background', { visible: false })], view: { kind: '3d', stationary: false }, budget: budget() });
    expect(decision.prefetch).toHaveLength(0);
    expect(decision.skipped[0].reason).toBe('prefetch-disabled');
  });
  test('respects render-budget prefetch disablement', () => {
    const decision = planSceneStreaming({ candidates: [candidate('background', { visible: false })], view: { kind: '3d', stationary: true }, budget: budget({ allowPrefetch: false }) });
    expect(decision.prefetch).toHaveLength(0);
  });
  test('enforces resident memory budgets for normal loads', () => {
    const decision = planSceneStreaming({ candidates: [candidate('huge', { estimatedBytes: 900 })], residentBytes: 500, view: { kind: '3d', stationary: true }, budget: budget({ maxResidentBytes: 1000 }) });
    expect(decision.load).toHaveLength(0);
    expect(decision.skipped.some((item) => item.reason === 'resident-memory-budget')).toBe(true);
  });
  test('forceLoad can exceed a temporary resident estimate deliberately', () => {
    const decision = planSceneStreaming({ candidates: [candidate('selected', { estimatedBytes: 900 })], residentBytes: 500, forceLoadIds: ['selected'], view: { kind: '3d', stationary: true }, budget: budget({ maxResidentBytes: 1000 }) });
    expect(decision.load).toEqual(['selected']);
  });
  test('skips an oversized single resource unless it is explicitly forced', () => {
    const decision = planSceneStreaming({ candidates: [candidate('oversized', { estimatedBytes: 500 })], view: { kind: '3d', stationary: true }, budget: budget({ maxResidentBytes: 2000 }) }, { maxSingleResourceBytes: 200 });
    expect(decision.load).toHaveLength(0);
    expect(decision.skipped[0].reason).toBe('resource-exceeds-single-resource-budget');
  });
  test('retains loaded visible resources', () => {
    const decision = planSceneStreaming({ candidates: [candidate('loaded', { loaded: true, visible: true })], residentIds: ['loaded'], residentBytes: 100, view: { kind: '3d', stationary: true }, budget: budget() });
    expect(decision.retain).toContain('loaded');
    expect(decision.evict).not.toContain('loaded');
  });
  test('evicts stale non-visible resources under memory pressure', () => {
    const decision = planSceneStreaming({
      candidates: [candidate('stale', { loaded: true, visible: false, estimatedBytes: 600, lastUsedAt: 0 })],
      residentIds: ['stale'], residentBytes: 1200, now: 500000, view: { kind: '3d', stationary: true }, budget: budget({ maxResidentBytes: 1000 }),
    }, { minResidentAgeMs: 10, staleResidentAgeMs: 100 });
    expect(decision.evict).toEqual(['stale']);
    expect(decision.estimatedResidentBytes).toBeLessThanOrEqual(1000);
  });
  test('forceRetain prevents eviction', () => {
    const decision = planSceneStreaming({
      candidates: [candidate('pinned', { loaded: true, visible: false, estimatedBytes: 600, lastUsedAt: 0 })],
      residentIds: ['pinned'], residentBytes: 1200, forceRetainIds: ['pinned'], now: 500000,
      view: { kind: '3d', stationary: true }, budget: budget({ maxResidentBytes: 1000 }),
    });
    expect(decision.retain).toContain('pinned');
    expect(decision.evict).not.toContain('pinned');
  });
  test('does not schedule resources already in flight', () => {
    const decision = planSceneStreaming({ candidates: [candidate('loading', { loading: true })], inFlightIds: ['loading'], view: { kind: '3d', stationary: true }, budget: budget() });
    expect(decision.load).toHaveLength(0);
    expect(decision.retain).toContain('loading');
  });
  test('scores forceLoad above ordinary visible content', () => {
    const scores = scoreSceneStreamingCandidates({ candidates: [candidate('normal'), candidate('forced', { visible: false })], forceLoadIds: ['forced'], view: { kind: '3d', stationary: true }, budget: budget() });
    expect(scores[0].id).toBe('forced');
    expect(scores[0].reason).toBe('force-load');
  });
  test('rejects forced ids that are absent from the candidate set', () => {
    expect(() => planSceneStreaming({ candidates: [candidate('known')], forceLoadIds: ['missing'], view: { kind: '3d', stationary: true }, budget: budget() })).toThrow(/not present/i);
  });
  test('rejects WMS candidate URLs through the shared service policy', () => {
    expect(() => planSceneStreaming({ candidates: [candidate('bad', { resourceUrl: 'https://example.test/geoserver/wms?service=WMS' })], view: { kind: '3d', stationary: true }, budget: budget() })).toThrow();
  });
  test('runtime accumulates useful streaming metrics', () => {
    const planner = createSceneStreamingPlanner({ now: () => 1000 });
    planner.plan({ candidates: [candidate('visible'), candidate('background', { visible: false })], view: { kind: '3d', stationary: true }, budget: budget() });
    const metrics = planner.getMetrics();
    expect(metrics.plans).toBe(1);
    expect(metrics.loadDecisions).toBeGreaterThanOrEqual(1);
    expect(metrics.estimatedLoadBytes).toBeGreaterThan(0);
  });
  test('runtime settings can be reconfigured safely', () => {
    const planner = createSceneStreamingPlanner();
    const settings = planner.configure({ maxLoadsPerPlan: 1, maxPrefetchPerPlan: 1 });
    expect(settings.maxLoadsPerPlan).toBe(1);
    const decision = planner.plan({ candidates: [candidate('a'), candidate('b')], view: { kind: '3d', stationary: true }, budget: budget({ maxConcurrentRequests: 10 }) });
    expect(decision.load).toHaveLength(1);
  });
  test('destroyed runtime fails closed for planning', () => {
    const planner = createSceneStreamingPlanner();
    planner.destroy();
    expect(planner.isDestroyed()).toBe(true);
    expect(() => planner.plan({ candidates: [], view: { kind: '3d', stationary: true }, budget: budget() })).toThrow(/destroyed/i);
  });
});
