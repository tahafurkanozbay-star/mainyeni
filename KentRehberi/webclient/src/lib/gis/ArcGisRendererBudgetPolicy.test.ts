import { describe, expect, it } from 'vitest'
import { ArcGisRendererBudgetPolicy, type ArcGisRendererBudget, type ArcGisRendererCandidate } from './ArcGisRendererBudgetPolicy'

const budget: ArcGisRendererBudget = {
  maxFeatures2d: 1000,
  maxFeatures3d: 500,
  maxVertices2d: 5000,
  maxVertices3d: 2500,
  maxSymbols: 1500,
  maxTextureBytes: 10_000,
  maxBufferBytes: 20_000,
  maxLabels: 200,
  maxPopupFields: 20,
  maxClusterRadius: 120,
  maxLayers: 8,
}

const candidate = (extra: Partial<ArcGisRendererCandidate> = {}): ArcGisRendererCandidate => ({
  layerId: 'roads',
  view: '2d',
  geometry: 'polyline',
  renderer: 'simple',
  featureCount: 100,
  vertexCount: 1000,
  symbolCount: 1,
  textureBytes: 100,
  bufferBytes: 1000,
  labelCount: 10,
  popupFieldCount: 5,
  scale: 10_000,
  ...extra,
})

describe('ArcGisRendererBudgetPolicy', () => {
  it('admits a bounded renderer plan', () => {
    const result = new ArcGisRendererBudgetPolicy(budget).plan([candidate()])
    expect(result).toMatchObject({ accepted: true, totalTextureBytes: 100, totalBufferBytes: 1000, totalSymbols: 1, totalLabels: 10 })
    expect(result.decisions[0]).toMatchObject({ accepted: true, labelsEnabled: true, popupFieldCount: 5 })
  })

  it('normalizes layer ids deterministically', () => {
    const result = new ArcGisRendererBudgetPolicy(budget).plan([candidate({ layerId: '  roads  ' })])
    expect(result.decisions[0].layerId).toBe('roads')
  })

  it('rejects duplicate normalized layer ids', () => {
    const result = new ArcGisRendererBudgetPolicy(budget).plan([candidate(), candidate({ layerId: ' roads ' })])
    expect(result).toMatchObject({ accepted: false, reason: 'duplicate-layer:roads' })
  })

  it('rejects unsafe layer ids', () => {
    const result = new ArcGisRendererBudgetPolicy(budget).plan([candidate({ layerId: 'bad\nlayer' })])
    expect(result.accepted).toBe(false)
    expect(result.reason).toContain('safe characters')
  })

  it('rejects excessive 2d features without clustering', () => {
    const result = new ArcGisRendererBudgetPolicy(budget).plan([candidate({ featureCount: 1001 })])
    expect(result).toMatchObject({ accepted: false, reason: 'feature-budget-exceeded:roads' })
  })

  it('uses the stricter 3d feature budget', () => {
    const result = new ArcGisRendererBudgetPolicy(budget).plan([candidate({ view: '3d', featureCount: 501 })])
    expect(result).toMatchObject({ accepted: false, reason: 'feature-budget-exceeded:roads' })
  })

  it('allows high-cardinality point input only through bounded clustering', () => {
    const result = new ArcGisRendererBudgetPolicy(budget).plan([candidate({ geometry: 'point', renderer: 'cluster', featureCount: 5000, clusterRadius: 80 })])
    expect(result.accepted).toBe(true)
  })

  it('rejects cluster radius over budget', () => {
    const result = new ArcGisRendererBudgetPolicy(budget).plan([candidate({ geometry: 'point', renderer: 'cluster', featureCount: 5000, clusterRadius: 121 })])
    expect(result).toMatchObject({ accepted: false, reason: 'cluster-radius-budget-exceeded:roads' })
  })

  it('requires cluster radius for over-budget clustered input', () => {
    const result = new ArcGisRendererBudgetPolicy(budget).plan([candidate({ geometry: 'point', renderer: 'cluster', featureCount: 5000 })])
    expect(result).toMatchObject({ accepted: false, reason: 'cluster-radius-budget-exceeded:roads' })
  })

  it('rejects clustering non-point geometry', () => {
    const result = new ArcGisRendererBudgetPolicy(budget).plan([candidate({ renderer: 'cluster' })])
    expect(result).toMatchObject({ accepted: false, reason: 'cluster renderer requires point geometry' })
  })

  it('rejects heatmap non-point geometry', () => {
    const result = new ArcGisRendererBudgetPolicy(budget).plan([candidate({ renderer: 'heatmap' })])
    expect(result).toMatchObject({ accepted: false, reason: 'heatmap renderer requires point geometry' })
  })

  it('rejects heatmap in 3d', () => {
    const result = new ArcGisRendererBudgetPolicy(budget).plan([candidate({ view: '3d', geometry: 'point', renderer: 'heatmap' })])
    expect(result).toMatchObject({ accepted: false, reason: 'heatmap renderer is not admitted in 3d' })
  })

  it('rejects excessive 2d vertices', () => {
    const result = new ArcGisRendererBudgetPolicy(budget).plan([candidate({ vertexCount: 5001 })])
    expect(result).toMatchObject({ accepted: false, reason: 'vertex-budget-exceeded:roads' })
  })

  it('uses the stricter 3d vertex budget', () => {
    const result = new ArcGisRendererBudgetPolicy(budget).plan([candidate({ view: '3d', vertexCount: 2501 })])
    expect(result).toMatchObject({ accepted: false, reason: 'vertex-budget-exceeded:roads' })
  })

  it('rejects per-layer symbol overflow', () => {
    const result = new ArcGisRendererBudgetPolicy(budget).plan([candidate({ symbolCount: 1501 })])
    expect(result).toMatchObject({ accepted: false, reason: 'symbol-budget-exceeded:roads' })
  })

  it('rejects aggregate symbol overflow', () => {
    const result = new ArcGisRendererBudgetPolicy(budget).plan([
      candidate({ layerId: 'a', symbolCount: 800 }),
      candidate({ layerId: 'b', symbolCount: 800 }),
    ])
    expect(result).toMatchObject({ accepted: false, reason: 'aggregate-symbol-budget-exceeded:b' })
  })

  it('rejects aggregate texture overflow', () => {
    const result = new ArcGisRendererBudgetPolicy(budget).plan([
      candidate({ layerId: 'a', textureBytes: 6000 }),
      candidate({ layerId: 'b', textureBytes: 5000 }),
    ])
    expect(result).toMatchObject({ accepted: false, reason: 'texture-budget-exceeded:b' })
  })

  it('rejects aggregate buffer overflow', () => {
    const result = new ArcGisRendererBudgetPolicy(budget).plan([
      candidate({ layerId: 'a', bufferBytes: 11_000 }),
      candidate({ layerId: 'b', bufferBytes: 10_000 }),
    ])
    expect(result).toMatchObject({ accepted: false, reason: 'buffer-budget-exceeded:b' })
  })

  it('degrades labels instead of rejecting an otherwise safe layer', () => {
    const result = new ArcGisRendererBudgetPolicy(budget).plan([
      candidate({ layerId: 'a', labelCount: 150 }),
      candidate({ layerId: 'b', labelCount: 100 }),
    ])
    expect(result.accepted).toBe(true)
    expect(result.totalLabels).toBe(150)
    expect(result.decisions.map(value => value.labelsEnabled)).toEqual([true, false])
  })

  it('rejects excessive popup fields', () => {
    const result = new ArcGisRendererBudgetPolicy(budget).plan([candidate({ popupFieldCount: 21 })])
    expect(result).toMatchObject({ accepted: false, reason: 'popup-field-budget-exceeded:roads' })
  })

  it('marks layers outside their min scale as hidden decisions', () => {
    const result = new ArcGisRendererBudgetPolicy(budget).plan([candidate({ scale: 100_000, minScale: 50_000 })])
    expect(result.accepted).toBe(true)
    expect(result.decisions[0]).toMatchObject({ accepted: false, reason: 'outside-scale-range', effectiveFeatureCount: 0 })
  })

  it('marks layers outside their max scale as hidden decisions', () => {
    const result = new ArcGisRendererBudgetPolicy(budget).plan([candidate({ scale: 100, maxScale: 500 })])
    expect(result.accepted).toBe(true)
    expect(result.decisions[0]).toMatchObject({ accepted: false, reason: 'outside-scale-range' })
  })

  it('admits boundary scales', () => {
    const policy = new ArcGisRendererBudgetPolicy(budget)
    expect(policy.plan([candidate({ scale: 50_000, minScale: 50_000 })]).decisions[0].accepted).toBe(true)
    expect(policy.plan([candidate({ scale: 500, maxScale: 500 })]).decisions[0].accepted).toBe(true)
  })

  it('rejects inverted ArcGIS scale semantics', () => {
    const result = new ArcGisRendererBudgetPolicy(budget).plan([candidate({ minScale: 1000, maxScale: 5000 })])
    expect(result).toMatchObject({ accepted: false, reason: 'minScale must be >= maxScale' })
  })

  it('accepts zero as an unbounded ArcGIS scale sentinel', () => {
    const result = new ArcGisRendererBudgetPolicy(budget).plan([candidate({ minScale: 0, maxScale: 0 })])
    expect(result.accepted).toBe(true)
    expect(result.decisions[0].accepted).toBe(true)
  })

  it('rejects non-finite scales', () => {
    const result = new ArcGisRendererBudgetPolicy(budget).plan([candidate({ scale: Number.POSITIVE_INFINITY })])
    expect(result.accepted).toBe(false)
    expect(result.reason).toContain('scale must be finite')
  })

  it('rejects negative counts', () => {
    const result = new ArcGisRendererBudgetPolicy(budget).plan([candidate({ featureCount: -1 })])
    expect(result.accepted).toBe(false)
    expect(result.reason).toContain('featureCount')
  })

  it('rejects fractional counts', () => {
    const result = new ArcGisRendererBudgetPolicy(budget).plan([candidate({ vertexCount: 1.5 })])
    expect(result.accepted).toBe(false)
    expect(result.reason).toContain('vertexCount')
  })

  it('rejects layer cardinality overflow before planning', () => {
    const input = Array.from({ length: 9 }, (_, index) => candidate({ layerId: `layer-${index}` }))
    const result = new ArcGisRendererBudgetPolicy(budget).plan(input)
    expect(result).toMatchObject({ accepted: false, reason: 'layer-budget-exceeded' })
    expect(result.decisions).toHaveLength(0)
  })

  it('returns immutable plan collections', () => {
    const result = new ArcGisRendererBudgetPolicy(budget).plan([candidate()])
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.decisions)).toBe(true)
    expect(Object.isFrozen(result.decisions[0])).toBe(true)
  })

  it('clears aggregate accounting on fail-closed rejection', () => {
    const result = new ArcGisRendererBudgetPolicy(budget).plan([
      candidate({ layerId: 'a', textureBytes: 1000, bufferBytes: 2000, symbolCount: 10, labelCount: 20 }),
      candidate({ layerId: 'b', vertexCount: 5001 }),
    ])
    expect(result).toMatchObject({ accepted: false, totalTextureBytes: 0, totalBufferBytes: 0, totalSymbols: 0, totalLabels: 0 })
    expect(result.decisions).toHaveLength(1)
  })

  it('rejects invalid constructor budgets', () => {
    expect(() => new ArcGisRendererBudgetPolicy({ ...budget, maxLayers: 0 })).toThrow('maxLayers')
    expect(() => new ArcGisRendererBudgetPolicy({ ...budget, maxTextureBytes: Number.NaN })).toThrow('maxTextureBytes')
  })
})
