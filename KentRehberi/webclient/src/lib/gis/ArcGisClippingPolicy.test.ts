import { describe, expect, it } from 'vitest'
import { ArcGisClippingPolicy, type ArcGisClipInput } from './ArcGisClippingPolicy'

const policy = () => new ArcGisClippingPolicy({
  maxVertices: 8,
  maxLayers: 3,
  maxAbsoluteCoordinate: 10_000,
  maxAbsoluteElevation: 2_000,
  maxEnvelopeArea: 1_000_000,
})

const clip = (patch: Partial<ArcGisClipInput> = {}): ArcGisClipInput => ({
  id: 'district-section',
  wkid: 102100,
  mode: 'inside',
  ring: [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 100, y: 100 },
    { x: 0, y: 0 },
  ],
  layerIds: ['buildings', 'parcels'],
  revision: 4,
  ...patch,
})

describe('ArcGisClippingPolicy', () => {
  it('canonicalizes Web Mercator aliases and freezes the plan graph', () => {
    const plan = policy().plan(clip())
    expect(plan.wkid).toBe(3857)
    expect(Object.isFrozen(plan)).toBe(true)
    expect(Object.isFrozen(plan.ring)).toBe(true)
    expect(Object.isFrozen(plan.ring[0])).toBe(true)
    expect(Object.isFrozen(plan.layerIds)).toBe(true)
    expect(Object.isFrozen(plan.envelope)).toBe(true)
  })

  it('orders target layers deterministically before fingerprinting', () => {
    const first = policy().plan(clip({ layerIds: ['parcels', 'buildings'] }))
    const second = policy().plan(clip({ layerIds: ['buildings', 'parcels'] }))
    expect(first.layerIds).toEqual(['buildings', 'parcels'])
    expect(first.fingerprint).toBe(second.fingerprint)
  })

  it('pins revisions in the fingerprint', () => {
    expect(policy().plan(clip()).fingerprint).not.toBe(policy().plan(clip({ revision: 5 })).fingerprint)
  })

  it('pins clip mode in the fingerprint', () => {
    expect(policy().plan(clip()).fingerprint).not.toBe(policy().plan(clip({ mode: 'outside' })).fingerprint)
  })

  it('computes a deterministic planar envelope', () => {
    expect(policy().plan(clip()).envelope).toEqual({ xmin: 0, ymin: 0, xmax: 100, ymax: 100 })
  })

  it('accepts bounded elevation coordinates', () => {
    const plan = policy().plan(clip({ ring: [
      { x: 0, y: 0, z: 10 },
      { x: 100, y: 0, z: 20 },
      { x: 100, y: 100, z: 30 },
      { x: 0, y: 0, z: 10 },
    ] }))
    expect(plan.ring[2].z).toBe(30)
  })

  it('rejects a ring that is not closed', () => {
    expect(() => policy().plan(clip({ ring: [
      { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 1 },
    ] }))).toThrow(/closed/)
  })

  it('rejects a ring with too few coordinates', () => {
    expect(() => policy().plan(clip({ ring: [
      { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 0 },
    ] }))).toThrow(/at least four/)
  })

  it('rejects degenerate rings with fewer than three unique planar vertices', () => {
    expect(() => policy().plan(clip({ ring: [
      { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 },
    ] }))).toThrow(/three unique/)
  })

  it('rejects collinear rings with zero area', () => {
    expect(() => policy().plan(clip({ ring: [
      { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 }, { x: 0, y: 0 },
    ] }))).toThrow(/non-zero area/)
  })

  it('enforces vertex cardinality budget', () => {
    const ring = Array.from({ length: 9 }, (_, index) => ({ x: index, y: index % 2 }))
    ring.push({ ...ring[0] })
    expect(() => policy().plan(clip({ ring }))).toThrow(/vertex budget/)
  })

  it('rejects non-finite planar coordinates', () => {
    expect(() => policy().plan(clip({ ring: [
      { x: 0, y: 0 }, { x: Number.NaN, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 0 },
    ] }))).toThrow(/finite/)
  })

  it('enforces absolute planar coordinate budget', () => {
    expect(() => policy().plan(clip({ ring: [
      { x: 0, y: 0 }, { x: 20_000, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 0 },
    ] }))).toThrow(/coordinate budget/)
  })

  it('enforces elevation budget', () => {
    expect(() => policy().plan(clip({ ring: [
      { x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 3_000 }, { x: 10, y: 10, z: 0 }, { x: 0, y: 0, z: 0 },
    ] }))).toThrow(/elevation budget/)
  })

  it('enforces envelope-area budget', () => {
    expect(() => policy().plan(clip({ ring: [
      { x: 0, y: 0 }, { x: 2_000, y: 0 }, { x: 2_000, y: 2_000 }, { x: 0, y: 0 },
    ] }))).toThrow(/envelope area budget/)
  })

  it('requires at least one target layer', () => {
    expect(() => policy().plan(clip({ layerIds: [] }))).toThrow(/at least one layer/)
  })

  it('enforces target-layer cardinality budget', () => {
    expect(() => policy().plan(clip({ layerIds: ['a', 'b', 'c', 'd'] }))).toThrow(/layer budget/)
  })

  it('rejects duplicate target layers', () => {
    expect(() => policy().plan(clip({ layerIds: ['parcels', 'parcels'] }))).toThrow(/duplicate/)
  })

  it('rejects malformed target-layer ids', () => {
    expect(() => policy().plan(clip({ layerIds: [' parcels'] }))).toThrow(/invalid clip layer/)
  })

  it('rejects malformed clip ids', () => {
    expect(() => policy().plan(clip({ id: 'bad clip id' }))).toThrow(/invalid clip id/)
  })

  it('rejects negative revisions', () => {
    expect(() => policy().plan(clip({ revision: -1 }))).toThrow(/revision/)
  })

  it('rejects stale plans through the explicit revision guard', () => {
    const plan = policy().plan(clip())
    expect(() => policy().assertCurrent(plan, 5)).toThrow(/stale/)
    expect(() => policy().assertCurrent(plan, 4)).not.toThrow()
  })

  it('rejects invalid constructor cardinality budgets', () => {
    expect(() => new ArcGisClippingPolicy({
      maxVertices: 0, maxLayers: 1, maxAbsoluteCoordinate: 1, maxAbsoluteElevation: 1, maxEnvelopeArea: 1,
    })).toThrow(/positive/)
  })

  it('rejects invalid constructor geometry budgets', () => {
    expect(() => new ArcGisClippingPolicy({
      maxVertices: 3, maxLayers: 1, maxAbsoluteCoordinate: -1, maxAbsoluteElevation: 1, maxEnvelopeArea: 1,
    })).toThrow(/invalid clipping budgets/)
  })
})
