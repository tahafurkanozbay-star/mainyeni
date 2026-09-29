import { describe, expect, it } from 'vitest'
import { ArcGisIdentifyPolicy, type ArcGisIdentifyLayerFacts, type ArcGisIdentifyRequest } from './ArcGisIdentifyPolicy'

const policy = () => new ArcGisIdentifyPolicy({
  maxLayers: 2,
  maxEstimatedResponseBytes: 100,
  maxTolerancePx: 20,
  maxViewportPixels: 2_000_000,
  maxLayerTitleLength: 80,
  maxPriority: 100,
})

const request: ArcGisIdentifyRequest = {
  dimension: '2d', scale: 5_000, x: 32.85, y: 39.93, spatialReferenceWkid: 102100,
  tolerancePx: 8, viewportWidth: 1000, viewportHeight: 1000, geometryType: 'point',
}

const layer = (overrides: Partial<ArcGisIdentifyLayerFacts> = {}): ArcGisIdentifyLayerFacts => ({
  layerId: 1, title: 'Parseller', visible: true, queryable: true,
  supportedDimensions: ['2d', '3d'], estimatedFeatureBytes: 30, priority: 10, ...overrides,
})

describe('ArcGisIdentifyPolicy', () => {
  it('canonicalizes Web Mercator aliases', () => {
    expect(policy().plan(request, [layer()]).point.spatialReferenceWkid).toBe(3857)
  })

  it('orders admitted layers by priority then id', () => {
    const plan = policy().plan(request, [layer({ layerId: 3, priority: 5 }), layer({ layerId: 2, priority: 20 }), layer({ layerId: 1, priority: 20 })])
    expect(plan.layers.map((item) => item.layerId)).toEqual([1, 2])
  })

  it('enforces aggregate response-byte budget without starving later small layers', () => {
    const plan = policy().plan(request, [layer({ layerId: 1, estimatedFeatureBytes: 90, priority: 30 }), layer({ layerId: 2, estimatedFeatureBytes: 20, priority: 20 }), layer({ layerId: 3, estimatedFeatureBytes: 10, priority: 10 })])
    expect(plan.layers.map((item) => item.layerId)).toEqual([1, 3])
    expect(plan.estimatedResponseBytes).toBe(100)
  })

  it('excludes hidden and non-queryable layers', () => {
    const plan = policy().plan(request, [layer({ layerId: 1, visible: false }), layer({ layerId: 2, queryable: false })])
    expect(plan.layers).toEqual([])
  })

  it('excludes layers unsupported in the active dimension', () => {
    const plan = policy().plan({ ...request, dimension: '3d' }, [layer({ supportedDimensions: ['2d'] })])
    expect(plan.layers).toEqual([])
  })

  it('applies ArcGIS minScale semantics', () => {
    expect(policy().plan(request, [layer({ minScale: 4_000 })]).layers).toHaveLength(0)
    expect(policy().plan(request, [layer({ minScale: 6_000 })]).layers).toHaveLength(1)
  })

  it('applies ArcGIS maxScale semantics', () => {
    expect(policy().plan(request, [layer({ maxScale: 6_000 })]).layers).toHaveLength(0)
    expect(policy().plan(request, [layer({ maxScale: 4_000 })]).layers).toHaveLength(1)
  })

  it('treats zero scale bounds as unbounded', () => {
    expect(policy().plan(request, [layer({ minScale: 0, maxScale: 0 })]).layers).toHaveLength(1)
  })

  it('rejects inverted ArcGIS scale ranges', () => {
    expect(() => policy().plan(request, [layer({ minScale: 4_000, maxScale: 6_000 })])).toThrow('invalid-scale-range:1')
  })

  it('honors explicit layer selection', () => {
    const plan = policy().plan({ ...request, layerIds: [2] }, [layer({ layerId: 1 }), layer({ layerId: 2 })])
    expect(plan.layers.map((item) => item.layerId)).toEqual([2])
  })

  it('fails closed for unknown explicitly requested layers', () => {
    expect(() => policy().plan({ ...request, layerIds: [99] }, [layer()])).toThrow('unknown-requested-layer:99')
  })

  it('rejects duplicate explicit layer ids', () => {
    expect(() => policy().plan({ ...request, layerIds: [1, 1] }, [layer()])).toThrow('duplicate-requested-layer-id')
  })

  it('rejects duplicate service layer facts', () => {
    expect(() => policy().plan(request, [layer(), layer()])).toThrow('duplicate-layer-id:1')
  })

  it('rejects excessive identify tolerance', () => {
    expect(() => policy().plan({ ...request, tolerancePx: 21 }, [layer()])).toThrow('tolerancePx')
  })

  it('rejects viewport pixel budget overflow before planning', () => {
    expect(() => policy().plan({ ...request, viewportWidth: 2000, viewportHeight: 2000 }, [layer()])).toThrow('viewport-pixel-budget-exceeded')
  })

  it('rejects non-finite coordinates', () => {
    expect(() => policy().plan({ ...request, x: Number.NaN }, [layer()])).toThrow('x must be finite')
  })

  it('rejects non-positive scales', () => {
    expect(() => policy().plan({ ...request, scale: 0 }, [layer()])).toThrow('scale-out-of-range')
  })

  it('sanitizes titles deterministically', () => {
    expect(policy().plan(request, [layer({ title: '  Ada   Parsel  ' })]).layers[0]?.title).toBe('Ada Parsel')
  })

  it('rejects control characters in layer titles', () => {
    expect(() => policy().plan(request, [layer({ title: 'bad\ntitle' })])).toThrow('invalid-layer-title')
  })

  it('produces stable fingerprints independent of input layer ordering', () => {
    const a = policy().plan(request, [layer({ layerId: 1 }), layer({ layerId: 2 })])
    const b = policy().plan(request, [layer({ layerId: 2 }), layer({ layerId: 1 })])
    expect(a.fingerprint).toBe(b.fingerprint)
  })

  it('changes fingerprint when identify semantics change', () => {
    const a = policy().plan(request, [layer()])
    const b = policy().plan({ ...request, tolerancePx: 9 }, [layer()])
    expect(a.fingerprint).not.toBe(b.fingerprint)
  })

  it('returns deeply immutable plan boundaries', () => {
    const plan = policy().plan(request, [layer()])
    expect(Object.isFrozen(plan)).toBe(true)
    expect(Object.isFrozen(plan.point)).toBe(true)
    expect(Object.isFrozen(plan.layers)).toBe(true)
    expect(Object.isFrozen(plan.layers[0])).toBe(true)
  })

  it('rejects invalid budget relationships through request admission', () => {
    expect(() => new ArcGisIdentifyPolicy({ maxLayers: 0, maxEstimatedResponseBytes: 100, maxTolerancePx: 1, maxViewportPixels: 1, maxLayerTitleLength: 1, maxPriority: 1 })).toThrow('maxLayers')
  })
})
