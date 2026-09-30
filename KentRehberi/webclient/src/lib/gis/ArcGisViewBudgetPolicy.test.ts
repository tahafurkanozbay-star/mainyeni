import { describe, expect, it } from 'vitest'
import { ArcGisViewBudgetPolicy, type ArcGisViewLayerDemand } from './ArcGisViewBudgetPolicy'

const budget = {
  maxLayers: 4,
  maxInteractiveLayers: 2,
  maxFeatures: 1_000,
  maxVertices: 10_000,
  maxCpuBytes: 1_000_000,
  maxGpuBytes: 500_000,
  maxViewportPixels: 10_000_000,
  maxPixelRatio: 3,
} as const

const layer = (overrides: Partial<ArcGisViewLayerDemand> = {}): ArcGisViewLayerDemand => ({
  layerId: 'roads',
  revision: 1,
  priority: 10,
  estimatedFeatures: 100,
  estimatedVertices: 500,
  estimatedCpuBytes: 10_000,
  estimatedGpuBytes: 20_000,
  interactive: true,
  ...overrides,
})

const request = (layers: readonly ArcGisViewLayerDemand[]) => ({
  mode: '2d' as const,
  scale: 10_000,
  width: 1000,
  height: 600,
  pixelRatio: 2,
  layers,
})

describe('ArcGisViewBudgetPolicy', () => {
  it('creates a deterministic immutable plan', () => {
    const policy = new ArcGisViewBudgetPolicy(budget)
    const first = policy.plan(request([
      layer({ layerId: 'buildings', priority: 1, interactive: false }),
      layer({ layerId: 'roads', priority: 20 }),
    ]))
    const second = policy.plan(request([
      layer({ layerId: 'roads', priority: 20 }),
      layer({ layerId: 'buildings', priority: 1, interactive: false }),
    ]))
    expect(first.layers.map((item) => item.layerId)).toEqual(['roads', 'buildings'])
    expect(first.fingerprint).toBe(second.fingerprint)
    expect(first.viewportPixels).toBe(2_400_000)
    expect(Object.isFrozen(first)).toBe(true)
    expect(Object.isFrozen(first.layers)).toBe(true)
    expect(Object.isFrozen(first.totals)).toBe(true)
  })

  it('applies ArcGIS minScale and maxScale semantics before budgeting', () => {
    const policy = new ArcGisViewBudgetPolicy(budget)
    const plan = policy.plan(request([
      layer({ layerId: 'city', minScale: 50_000, maxScale: 5_000 }),
      layer({ layerId: 'regional', minScale: 5_000, maxScale: 500, interactive: false }),
    ]))
    expect(plan.layers.map((item) => item.layerId)).toEqual(['city'])
  })

  it('rejects malformed scale ranges', () => {
    const policy = new ArcGisViewBudgetPolicy(budget)
    expect(() => policy.plan(request([layer({ minScale: 100, maxScale: 1000 })])))
      .toThrow('invalid-scale-range:roads')
  })

  it('rejects duplicate layer identities', () => {
    const policy = new ArcGisViewBudgetPolicy(budget)
    expect(() => policy.plan(request([layer(), layer()])))
      .toThrow('duplicate-layer:roads')
  })

  it('rejects malformed identifiers', () => {
    const policy = new ArcGisViewBudgetPolicy(budget)
    expect(() => policy.plan(request([layer({ layerId: '../roads' })])))
      .toThrow('invalid-layer-id')
  })

  it('enforces viewport pixel and pixel ratio budgets', () => {
    const policy = new ArcGisViewBudgetPolicy({ ...budget, maxViewportPixels: 1_000_000 })
    expect(() => policy.plan(request([layer()])))
      .toThrow('viewport-pixel-budget-exceeded')
    expect(() => policy.plan({ ...request([layer()]), pixelRatio: 4 }))
      .toThrow('pixel-ratio-budget-exceeded')
  })

  it('enforces visible layer cardinality', () => {
    const policy = new ArcGisViewBudgetPolicy({ ...budget, maxLayers: 1, maxInteractiveLayers: 1 })
    expect(() => policy.plan(request([
      layer({ layerId: 'a' }),
      layer({ layerId: 'b', interactive: false }),
    ]))).toThrow('visible-layer-budget-exceeded')
  })

  it('enforces interactive layer cardinality', () => {
    const policy = new ArcGisViewBudgetPolicy({ ...budget, maxInteractiveLayers: 1 })
    expect(() => policy.plan(request([
      layer({ layerId: 'a' }),
      layer({ layerId: 'b' }),
    ]))).toThrow('interactive-layer-budget-exceeded:b')
  })

  it('enforces aggregate feature budget in deterministic priority order', () => {
    const policy = new ArcGisViewBudgetPolicy({ ...budget, maxFeatures: 150 })
    expect(() => policy.plan(request([
      layer({ layerId: 'low', priority: 1, estimatedFeatures: 100, interactive: false }),
      layer({ layerId: 'high', priority: 10, estimatedFeatures: 100, interactive: false }),
    ]))).toThrow('feature-budget-exceeded:low')
  })

  it('enforces aggregate vertex budget', () => {
    const policy = new ArcGisViewBudgetPolicy({ ...budget, maxVertices: 400 })
    expect(() => policy.plan(request([layer()])))
      .toThrow('vertex-budget-exceeded:roads')
  })

  it('enforces aggregate CPU memory budget', () => {
    const policy = new ArcGisViewBudgetPolicy({ ...budget, maxCpuBytes: 9_999 })
    expect(() => policy.plan(request([layer()])))
      .toThrow('cpu-byte-budget-exceeded:roads')
  })

  it('enforces aggregate GPU memory budget', () => {
    const policy = new ArcGisViewBudgetPolicy({ ...budget, maxGpuBytes: 19_999 })
    expect(() => policy.plan(request([layer()])))
      .toThrow('gpu-byte-budget-exceeded:roads')
  })

  it('includes revisions in the stable fingerprint', () => {
    const policy = new ArcGisViewBudgetPolicy(budget)
    const first = policy.plan(request([layer({ revision: 1 })]))
    const second = policy.plan(request([layer({ revision: 2 })]))
    expect(first.fingerprint).not.toBe(second.fingerprint)
  })

  it('separates 2d and 3d fingerprints', () => {
    const policy = new ArcGisViewBudgetPolicy(budget)
    const twoD = policy.plan(request([layer()]))
    const threeD = policy.plan({ ...request([layer()]), mode: '3d' })
    expect(twoD.fingerprint).not.toBe(threeD.fingerprint)
  })

  it('rejects invalid constructor relationships', () => {
    expect(() => new ArcGisViewBudgetPolicy({ ...budget, maxLayers: 1, maxInteractiveLayers: 2 }))
      .toThrow('maxInteractiveLayers must be <= maxLayers')
  })
})
