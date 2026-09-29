import { describe, expect, it } from 'vitest'
import { ArcGisLayerVisibilityPolicy, type ArcGisLayerVisibilityDescriptor } from './ArcGisLayerVisibilityPolicy'

const budget = { maxLayers: 8, maxVisibleLayers: 3, maxFeatures: 100, maxGpuBytes: 1000, maxCpuBytes: 2000 }
const layer = (id: string, patch: Partial<ArcGisLayerVisibilityDescriptor> = {}): ArcGisLayerVisibilityDescriptor => ({
  id, visible: true, dimensions: ['2d', '3d'], estimatedFeatures: 10, estimatedGpuBytes: 100, estimatedCpuBytes: 200, priority: 0, ...patch,
})
const context = { dimension: '2d' as const, scale: 10_000, extent: { xmin: 0, ymin: 0, xmax: 10, ymax: 10 } }

describe('ArcGisLayerVisibilityPolicy', () => {
  it('admits visible intersecting layers within all budgets', () => {
    const plan = new ArcGisLayerVisibilityPolicy(budget).plan([layer('a'), layer('b')], context)
    expect(plan).toMatchObject({ admittedIds: ['a', 'b'], visibleLayers: 2, estimatedFeatures: 20, estimatedGpuBytes: 200, estimatedCpuBytes: 400 })
  })

  it('excludes explicitly hidden layers without consuming resources', () => {
    const plan = new ArcGisLayerVisibilityPolicy(budget).plan([layer('a', { visible: false }), layer('b')], context)
    expect(plan.admittedIds).toEqual(['b'])
    expect(plan.decisions.find(item => item.id === 'a')?.reason).toBe('hidden')
    expect(plan.estimatedFeatures).toBe(10)
  })

  it('applies ArcGIS minScale semantics', () => {
    const policy = new ArcGisLayerVisibilityPolicy(budget)
    expect(policy.plan([layer('a', { minScale: 5000 })], context).decisions[0].reason).toBe('outside-scale')
    expect(policy.plan([layer('a', { minScale: 20_000 })], context).admittedIds).toEqual(['a'])
  })

  it('applies ArcGIS maxScale semantics', () => {
    const policy = new ArcGisLayerVisibilityPolicy(budget)
    expect(policy.plan([layer('a', { maxScale: 20_000 })], context).decisions[0].reason).toBe('outside-scale')
    expect(policy.plan([layer('a', { maxScale: 5000 })], context).admittedIds).toEqual(['a'])
  })

  it('treats zero scales as unbounded ArcGIS scale values', () => {
    const plan = new ArcGisLayerVisibilityPolicy(budget).plan([layer('a', { minScale: 0, maxScale: 0 })], context)
    expect(plan.admittedIds).toEqual(['a'])
  })

  it('rejects reversed positive ArcGIS scale ranges', () => {
    expect(() => new ArcGisLayerVisibilityPolicy(budget).plan([layer('a', { minScale: 5000, maxScale: 20_000 })], context)).toThrow('invalid-arcgis-scale-range')
  })

  it('filters by 2D/3D support', () => {
    const plan = new ArcGisLayerVisibilityPolicy(budget).plan([layer('scene', { dimensions: ['3d'] })], context)
    expect(plan.decisions[0]).toMatchObject({ admitted: false, reason: 'unsupported-dimension' })
  })

  it('admits a 3D-only layer in 3D context', () => {
    const plan = new ArcGisLayerVisibilityPolicy(budget).plan([layer('scene', { dimensions: ['3d'] })], { ...context, dimension: '3d' })
    expect(plan.admittedIds).toEqual(['scene'])
  })

  it('rejects layers outside the current extent', () => {
    const plan = new ArcGisLayerVisibilityPolicy(budget).plan([layer('far', { extent: { xmin: 20, ymin: 20, xmax: 30, ymax: 30 } })], context)
    expect(plan.decisions[0].reason).toBe('outside-extent')
  })

  it('accepts extent boundary contact as intersection', () => {
    const plan = new ArcGisLayerVisibilityPolicy(budget).plan([layer('edge', { extent: { xmin: 10, ymin: 10, xmax: 20, ymax: 20 } })], context)
    expect(plan.admittedIds).toEqual(['edge'])
  })

  it('does not require an extent when one side is unknown', () => {
    const plan = new ArcGisLayerVisibilityPolicy(budget).plan([layer('a', { extent: undefined })], { dimension: '2d', scale: 100 })
    expect(plan.admittedIds).toEqual(['a'])
  })

  it('uses priority before id when scarce budget forces selection', () => {
    const policy = new ArcGisLayerVisibilityPolicy({ ...budget, maxVisibleLayers: 1 })
    const plan = policy.plan([layer('a', { priority: 1 }), layer('z', { priority: 5 })], context)
    expect(plan.admittedIds).toEqual(['z'])
    expect(plan.decisions.find(item => item.id === 'a')?.admitted).toBe(false)
  })

  it('uses id as deterministic tie-breaker for equal priority', () => {
    const policy = new ArcGisLayerVisibilityPolicy({ ...budget, maxVisibleLayers: 1 })
    expect(policy.plan([layer('z'), layer('a')], context).admittedIds).toEqual(['a'])
  })

  it('enforces aggregate feature budget', () => {
    const policy = new ArcGisLayerVisibilityPolicy({ ...budget, maxFeatures: 15 })
    const plan = policy.plan([layer('a'), layer('b')], context)
    expect(plan.admittedIds).toEqual(['a'])
    expect(plan.decisions.find(item => item.id === 'b')?.reason).toBe('feature-budget')
  })

  it('enforces aggregate GPU budget', () => {
    const policy = new ArcGisLayerVisibilityPolicy({ ...budget, maxGpuBytes: 150 })
    const plan = policy.plan([layer('a'), layer('b')], context)
    expect(plan.decisions.find(item => item.id === 'b')?.reason).toBe('gpu-budget')
  })

  it('enforces aggregate CPU budget', () => {
    const policy = new ArcGisLayerVisibilityPolicy({ ...budget, maxCpuBytes: 300 })
    const plan = policy.plan([layer('a'), layer('b')], context)
    expect(plan.decisions.find(item => item.id === 'b')?.reason).toBe('cpu-budget')
  })

  it('skips an oversized high-priority layer and can admit a later cheap layer', () => {
    const policy = new ArcGisLayerVisibilityPolicy({ ...budget, maxGpuBytes: 150 })
    const plan = policy.plan([layer('heavy', { priority: 10, estimatedGpuBytes: 200 }), layer('cheap', { priority: 1, estimatedGpuBytes: 50 })], context)
    expect(plan.admittedIds).toEqual(['cheap'])
    expect(plan.decisions.find(item => item.id === 'heavy')?.reason).toBe('gpu-budget')
  })

  it('returns decisions in stable id order independent of input order', () => {
    const policy = new ArcGisLayerVisibilityPolicy(budget)
    const first = policy.plan([layer('b'), layer('a')], context)
    const second = policy.plan([layer('a'), layer('b')], context)
    expect(first.decisions).toEqual(second.decisions)
    expect(first.fingerprint).toBe(second.fingerprint)
  })

  it('changes fingerprint when admission changes', () => {
    const policy = new ArcGisLayerVisibilityPolicy(budget)
    const visible = policy.plan([layer('a')], context)
    const hidden = policy.plan([layer('a', { visible: false })], context)
    expect(visible.fingerprint).not.toBe(hidden.fingerprint)
  })

  it('freezes plan collections and decisions', () => {
    const plan = new ArcGisLayerVisibilityPolicy(budget).plan([layer('a')], context)
    expect(Object.isFrozen(plan)).toBe(true)
    expect(Object.isFrozen(plan.decisions)).toBe(true)
    expect(Object.isFrozen(plan.admittedIds)).toBe(true)
    expect(Object.isFrozen(plan.decisions[0])).toBe(true)
  })

  it('rejects duplicate layer ids after normalization', () => {
    expect(() => new ArcGisLayerVisibilityPolicy(budget).plan([layer('a'), layer(' a ')], context)).toThrow('duplicate-layer-id:a')
  })

  it('rejects control characters in layer ids', () => {
    expect(() => new ArcGisLayerVisibilityPolicy(budget).plan([layer('bad\nid')], context)).toThrow('invalid-layer-id')
  })

  it('rejects invalid extents', () => {
    expect(() => new ArcGisLayerVisibilityPolicy(budget).plan([layer('a', { extent: { xmin: 2, ymin: 0, xmax: 1, ymax: 1 } })], context)).toThrow('layer-extent-order-invalid')
  })

  it('rejects non-finite view coordinates', () => {
    expect(() => new ArcGisLayerVisibilityPolicy(budget).plan([layer('a')], { ...context, extent: { xmin: 0, ymin: 0, xmax: Infinity, ymax: 1 } })).toThrow('view-extent.xmax')
  })

  it('rejects invalid dimensions and empty dimension lists', () => {
    expect(() => new ArcGisLayerVisibilityPolicy(budget).plan([layer('a', { dimensions: [] })], context)).toThrow('invalid-layer-dimensions')
  })

  it('rejects unsafe resource estimates', () => {
    expect(() => new ArcGisLayerVisibilityPolicy(budget).plan([layer('a', { estimatedFeatures: -1 })], context)).toThrow('estimatedFeatures')
  })

  it('rejects input cardinality beyond configured layer budget', () => {
    const policy = new ArcGisLayerVisibilityPolicy({ ...budget, maxLayers: 2, maxVisibleLayers: 2 })
    expect(() => policy.plan([layer('a'), layer('b'), layer('c')], context)).toThrow('layer-visibility-input-budget-exceeded')
  })

  it('rejects inconsistent configured visible-layer budget', () => {
    expect(() => new ArcGisLayerVisibilityPolicy({ ...budget, maxLayers: 2, maxVisibleLayers: 3 })).toThrow('maxVisibleLayers must be <= maxLayers')
  })

  it('does not mutate caller descriptors or dimension arrays', () => {
    const dimensions: ('2d' | '3d')[] = ['3d', '2d']
    const source = layer('a', { dimensions })
    new ArcGisLayerVisibilityPolicy(budget).plan([source], context)
    expect(dimensions).toEqual(['3d', '2d'])
    expect(source.id).toBe('a')
  })
})
