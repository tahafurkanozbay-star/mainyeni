import { describe, expect, it } from 'vitest'
import { ArcGisMeasurementPolicy, type ArcGisMeasurementRequest } from './ArcGisMeasurementPolicy'

const policy = () => new ArcGisMeasurementPolicy({
  allowedWkids: [3857, 102100], maxPoints: 8, maxRevisionLength: 32,
  maxCoordinateMagnitude: 10_000, maxSegmentLength: 1_000,
  maxTotalDistance: 2_000, maxArea: 10_000, maxHeight: 500,
})

const distance: ArcGisMeasurementRequest = {
  dimension: '2d', mode: 'distance', spatialReferenceWkid: 102100,
  revision: 'dataset-1', points: [{ x: 0, y: 0 }, { x: 3, y: 4 }, { x: 6, y: 8 }],
}

describe('ArcGisMeasurementPolicy', () => {
  it('canonicalizes Web Mercator and computes bounded segments', () => {
    const plan = policy().plan(distance)
    expect(plan.spatialReferenceWkid).toBe(3857)
    expect(plan.segmentLengths).toEqual([5, 5])
    expect(plan.totalDistance).toBe(10)
  })

  it('computes deterministic polygon area', () => {
    const plan = policy().plan({ ...distance, mode: 'area', points: [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 3 }] })
    expect(plan.area).toBe(6)
  })

  it('computes height only in 3d', () => {
    const plan = policy().plan({ ...distance, dimension: '3d', mode: 'height', points: [{ x: 0, y: 0, z: 20 }, { x: 0, y: 0, z: 70 }] })
    expect(plan.height).toBe(50)
  })

  it('rejects height mode in 2d', () => {
    expect(() => policy().plan({ ...distance, mode: 'height' })).toThrow('height-measurement-requires-3d')
  })

  it('requires z for height endpoints', () => {
    expect(() => policy().plan({ ...distance, dimension: '3d', mode: 'height' })).toThrow('height-measurement-requires-z')
  })

  it('rejects z retention in 2d', () => {
    expect(() => policy().plan({ ...distance, points: [{ x: 0, y: 0, z: 1 }, { x: 1, y: 1 }] })).toThrow('2d-measurement-cannot-retain-z')
  })

  it('enforces minimum area vertices', () => {
    expect(() => policy().plan({ ...distance, mode: 'area', points: distance.points.slice(0, 2) })).toThrow('measurement-point-budget-exceeded')
  })

  it('enforces point cardinality budget', () => {
    const points = Array.from({ length: 9 }, (_, index) => ({ x: index, y: index }))
    expect(() => policy().plan({ ...distance, points })).toThrow('measurement-point-budget-exceeded')
  })

  it('rejects unsupported spatial references', () => {
    expect(() => policy().plan({ ...distance, spatialReferenceWkid: 4326 })).toThrow('measurement-wkid-not-allowed')
  })

  it('rejects non-finite coordinates', () => {
    expect(() => policy().plan({ ...distance, points: [{ x: Number.NaN, y: 0 }, { x: 1, y: 1 }] })).toThrow('point-0-x-out-of-range')
  })

  it('rejects coordinate magnitude overflow', () => {
    expect(() => policy().plan({ ...distance, points: [{ x: 10_001, y: 0 }, { x: 1, y: 1 }] })).toThrow('point-0-x-out-of-range')
  })

  it('enforces per-segment distance budget', () => {
    expect(() => policy().plan({ ...distance, points: [{ x: 0, y: 0 }, { x: 1001, y: 0 }] })).toThrow('measurement-segment-budget-exceeded')
  })

  it('enforces aggregate distance budget', () => {
    const constrained = new ArcGisMeasurementPolicy({ allowedWkids: [3857], maxPoints: 4, maxRevisionLength: 8, maxCoordinateMagnitude: 10_000, maxSegmentLength: 1000, maxTotalDistance: 10, maxArea: 100, maxHeight: 100 })
    expect(() => constrained.plan({ ...distance, spatialReferenceWkid: 3857, revision: 'r1', points: [{ x: 0, y: 0 }, { x: 8, y: 0 }, { x: 16, y: 0 }] })).toThrow('measurement-distance-budget-exceeded')
  })

  it('enforces area budget', () => {
    expect(() => policy().plan({ ...distance, mode: 'area', points: [{ x: 0, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 200 }] })).toThrow('measurement-area-budget-exceeded')
  })

  it('enforces height budget', () => {
    expect(() => policy().plan({ ...distance, dimension: '3d', mode: 'height', points: [{ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 501 }] })).toThrow('measurement-height-budget-exceeded')
  })

  it('normalizes revision whitespace', () => {
    expect(policy().plan({ ...distance, revision: ' dataset   1 ' }).revision).toBe('dataset 1')
  })

  it('rejects control characters in revision', () => {
    expect(() => policy().plan({ ...distance, revision: 'bad\nrevision' })).toThrow('invalid-measurement-revision')
  })

  it('produces stable fingerprints for equivalent Web Mercator aliases', () => {
    const a = policy().plan(distance)
    const b = policy().plan({ ...distance, spatialReferenceWkid: 3857 })
    expect(a.fingerprint).toBe(b.fingerprint)
  })

  it('changes fingerprint when geometry changes', () => {
    const a = policy().plan(distance)
    const b = policy().plan({ ...distance, points: [{ x: 0, y: 0 }, { x: 4, y: 4 }] })
    expect(a.fingerprint).not.toBe(b.fingerprint)
  })

  it('returns deeply immutable plan collections', () => {
    const plan = policy().plan(distance)
    expect(Object.isFrozen(plan)).toBe(true)
    expect(Object.isFrozen(plan.points)).toBe(true)
    expect(Object.isFrozen(plan.points[0])).toBe(true)
    expect(Object.isFrozen(plan.segmentLengths)).toBe(true)
  })
})
