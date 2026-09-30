import { describe, expect, it } from 'vitest'
import { ArcGisFeatureReductionPolicy, type ArcGisFeatureReductionLayer } from './ArcGisFeatureReductionPolicy'

const budget = {
  maxLayers: 8,
  maxFeatures: 100_000,
  maxVertices: 1_000_000,
  maxGpuBytes: 64_000_000,
  maxViewportPixels: 20_000_000,
  maxPixelRatio: 4,
  minClusterRadius: 16,
  maxClusterRadius: 128,
  maxEstimatedClusters: 50_000,
} as const

const layer = (overrides: Partial<ArcGisFeatureReductionLayer> = {}): ArcGisFeatureReductionLayer => ({
  id: 'roads', revision: 7, visible: true, clusterable: true,
  minScale: 0, maxScale: 0, estimatedFeatureCount: 10_000,
  estimatedVertexCount: 100_000, estimatedGpuBytes: 4_000_000, ...overrides,
})

const request = (layers: readonly ArcGisFeatureReductionLayer[]) => ({
  expectedRevision: 7, scale: 25_000, viewMode: '2d' as const,
  viewportWidth: 1000, viewportHeight: 800, pixelRatio: 1,
  preferredRadius: 48, layers,
})

describe('ArcGisFeatureReductionPolicy', () => {
  it('builds deterministic plans independent of input layer ordering', () => {
    const policy = new ArcGisFeatureReductionPolicy(budget)
    const a = layer({ id: 'a', estimatedFeatureCount: 20_000 })
    const b = layer({ id: 'b', estimatedFeatureCount: 12_000 })
    const first = policy.plan(request([b, a]))
    const second = policy.plan(request([a, b]))
    expect(first.layers.map((item) => item.id)).toEqual(['a', 'b'])
    expect(first.fingerprint).toBe(second.fingerprint)
  })

  it('clusters sufficiently dense clusterable layers', () => {
    const plan = new ArcGisFeatureReductionPolicy(budget).plan(request([layer({ estimatedFeatureCount: 80_000 })]))
    expect(plan.layers[0]?.mode).toBe('cluster')
    expect(plan.layers[0]?.clusterRadius).toBe(48)
    expect(plan.layers[0]?.estimatedClusters).toBeLessThan(80_000)
  })

  it('does not cluster layers that opt out', () => {
    const plan = new ArcGisFeatureReductionPolicy(budget).plan(request([layer({ clusterable: false, estimatedFeatureCount: 100 })]))
    expect(plan.layers[0]?.mode).toBe('none')
    expect(plan.layers[0]?.clusterRadius).toBe(0)
  })

  it('filters invisible and out-of-scale layers', () => {
    const policy = new ArcGisFeatureReductionPolicy(budget)
    const plan = policy.plan(request([
      layer({ id: 'hidden', visible: false }),
      layer({ id: 'too-far', minScale: 10_000, maxScale: 1_000 }),
      layer({ id: 'visible', minScale: 50_000, maxScale: 10_000 }),
    ]))
    expect(plan.layers.map((item) => item.id)).toEqual(['visible'])
  })

  it('rejects stale revisions before planning', () => {
    const policy = new ArcGisFeatureReductionPolicy(budget)
    expect(() => policy.plan(request([layer({ revision: 6 })]))).toThrow(/stale feature-reduction layer/)
  })

  it('rejects duplicate normalized identities', () => {
    const policy = new ArcGisFeatureReductionPolicy(budget)
    expect(() => policy.plan(request([layer({ id: 'roads' }), layer({ id: ' roads ' })]))).toThrow(/duplicate/)
  })

  it('rejects invalid ArcGIS scale ranges', () => {
    const policy = new ArcGisFeatureReductionPolicy(budget)
    expect(() => policy.plan(request([layer({ minScale: 1_000, maxScale: 10_000 })]))).toThrow(/invalid ArcGIS scale range/)
  })

  it('enforces aggregate feature budgets', () => {
    const policy = new ArcGisFeatureReductionPolicy({ ...budget, maxFeatures: 100 })
    expect(() => policy.plan(request([
      layer({ id: 'a', estimatedFeatureCount: 60 }),
      layer({ id: 'b', estimatedFeatureCount: 60 }),
    ]))).toThrow(/feature budget exceeded/)
  })

  it('enforces aggregate vertex budgets', () => {
    const policy = new ArcGisFeatureReductionPolicy({ ...budget, maxVertices: 100 })
    expect(() => policy.plan(request([layer({ estimatedVertexCount: 101 })]))).toThrow(/vertices:roads/)
  })

  it('enforces aggregate GPU budgets', () => {
    const policy = new ArcGisFeatureReductionPolicy({ ...budget, maxGpuBytes: 100 })
    expect(() => policy.plan(request([layer({ estimatedGpuBytes: 101 })]))).toThrow(/gpuBytes:roads/)
  })

  it('enforces viewport pixel budgets including pixel ratio', () => {
    const policy = new ArcGisFeatureReductionPolicy({ ...budget, maxViewportPixels: 1_000_000 })
    expect(() => policy.plan({ ...request([layer()]), viewportWidth: 1000, viewportHeight: 1000, pixelRatio: 2 })).toThrow(/viewport pixel budget/)
  })

  it('enforces layer cardinality budgets', () => {
    const policy = new ArcGisFeatureReductionPolicy({ ...budget, maxLayers: 1 })
    expect(() => policy.plan(request([layer({ id: 'a' }), layer({ id: 'b' })]))).toThrow(/layer budget/)
  })

  it('enforces cluster estimate budgets', () => {
    const policy = new ArcGisFeatureReductionPolicy({ ...budget, maxEstimatedClusters: 1 })
    expect(() => policy.plan(request([layer({ estimatedFeatureCount: 10 })]))).toThrow(/cluster budget/)
  })

  it('rejects malformed identifiers', () => {
    const policy = new ArcGisFeatureReductionPolicy(budget)
    expect(() => policy.plan(request([layer({ id: '   ' })]))).toThrow(/invalid feature-reduction layer id/)
    expect(() => policy.plan(request([layer({ id: 'bad\u0000id' })]))).toThrow(/invalid feature-reduction layer id/)
  })

  it('rejects unsupported view modes at runtime', () => {
    const policy = new ArcGisFeatureReductionPolicy(budget)
    expect(() => policy.plan({ ...request([layer()]), viewMode: '4d' as '2d' })).toThrow(/invalid feature-reduction view mode/)
  })

  it('returns deeply immutable planning surfaces', () => {
    const policy = new ArcGisFeatureReductionPolicy(budget)
    const plan = policy.plan(request([layer()]))
    expect(Object.isFrozen(plan)).toBe(true)
    expect(Object.isFrozen(plan.layers)).toBe(true)
    expect(Object.isFrozen(plan.layers[0])).toBe(true)
    expect(Object.isFrozen(plan.totals)).toBe(true)
    expect(Object.isFrozen(policy.snapshotBudget())).toBe(true)
  })

  it('does not expose caller layer objects through the plan', () => {
    const input = layer()
    const plan = new ArcGisFeatureReductionPolicy(budget).plan(request([input]))
    expect(plan.layers[0]).not.toBe(input)
  })

  it('keeps fingerprint stable for equivalent plans', () => {
    const policy = new ArcGisFeatureReductionPolicy(budget)
    const first = policy.plan(request([layer()]))
    const second = policy.plan(request([layer()]))
    expect(first.fingerprint).toBe(second.fingerprint)
  })
})
