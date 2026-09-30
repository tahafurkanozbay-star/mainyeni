import { describe, expect, it } from 'vitest'
import { ArcGisSpatialReferencePolicy } from './ArcGisSpatialReferencePolicy'

const policy = () => new ArcGisSpatialReferencePolicy({ maxKnownReferences: 8, maxCoordinateMagnitude: 100_000_000, maxProjectedMetersPerUnit: 100_000 })

describe('ArcGisSpatialReferencePolicy', () => {
  it('registers and snapshots references deterministically', () => {
    const value = policy()
    value.register({ wkid: 4326, kind: 'geographic', metersPerUnit: 111_319.49, wrapAround: true })
    value.register({ wkid: 3857, kind: 'web-mercator', metersPerUnit: 1, wrapAround: true })
    expect(value.snapshot().map((item) => item.wkid)).toEqual([3857, 4326])
    expect(Object.isFrozen(value.snapshot())).toBe(true)
  })

  it('canonicalizes geographic wraparound', () => {
    const value = policy()
    value.register({ wkid: 4326, kind: 'geographic', metersPerUnit: 1, wrapAround: true })
    expect(value.planCoordinate({ x: 190, y: 40, wkid: 4326 }).x).toBe(-170)
    expect(value.planCoordinate({ x: -190, y: 40, wkid: 4326 }).x).toBe(170)
  })

  it('rejects invalid latitude', () => {
    const value = policy()
    value.register({ wkid: 4326, kind: 'geographic', metersPerUnit: 1, wrapAround: true })
    expect(() => value.planCoordinate({ x: 0, y: 91, wkid: 4326 })).toThrow(/latitude/)
  })

  it('resolves latest wkid aliases without duplicating authority', () => {
    const value = policy()
    value.register({ wkid: 102100, latestWkid: 3857, kind: 'web-mercator', metersPerUnit: 1, wrapAround: true })
    const plan = value.planCoordinate({ x: 1, y: 2, wkid: 3857 })
    expect(plan.canonicalWkid).toBe(3857)
    expect(plan.wkid).toBe(3857)
  })

  it('rejects unknown references', () => expect(() => policy().planCoordinate({ x: 1, y: 2, wkid: 4326 })).toThrow(/unknown/))

  it('rejects conflicting registration', () => {
    const value = policy()
    value.register({ wkid: 3857, kind: 'web-mercator', metersPerUnit: 1, wrapAround: true })
    expect(() => value.register({ wkid: 3857, kind: 'projected', metersPerUnit: 1, wrapAround: false })).toThrow(/conflicting/)
  })

  it('rejects false web mercator declarations', () => expect(() => policy().register({ wkid: 4326, kind: 'web-mercator', metersPerUnit: 1, wrapAround: true })).toThrow(/web-mercator/))
  it('requires geographic wraparound', () => expect(() => policy().register({ wkid: 4326, kind: 'geographic', metersPerUnit: 1, wrapAround: false })).toThrow(/must-wrap/))
  it('rejects nonpositive unit scales', () => expect(() => policy().register({ wkid: 3857, kind: 'web-mercator', metersPerUnit: 0, wrapAround: true })).toThrow(/positive/))

  it('enforces reference cardinality', () => {
    const value = new ArcGisSpatialReferencePolicy({ maxKnownReferences: 1, maxCoordinateMagnitude: 100, maxProjectedMetersPerUnit: 100 })
    value.register({ wkid: 3857, kind: 'web-mercator', metersPerUnit: 1, wrapAround: true })
    expect(() => value.register({ wkid: 4326, kind: 'geographic', metersPerUnit: 1, wrapAround: true })).toThrow(/cardinality/)
  })

  it('enforces coordinate magnitude budgets', () => {
    const value = new ArcGisSpatialReferencePolicy({ maxKnownReferences: 2, maxCoordinateMagnitude: 10, maxProjectedMetersPerUnit: 100 })
    value.register({ wkid: 3857, kind: 'web-mercator', metersPerUnit: 1, wrapAround: true })
    expect(() => value.planCoordinate({ x: 11, y: 0, wkid: 3857 })).toThrow(/coordinate budget/)
  })

  it('normalizes negative zero and retains finite z', () => {
    const value = policy()
    value.register({ wkid: 3857, kind: 'web-mercator', metersPerUnit: 1, wrapAround: true })
    const plan = value.planCoordinate({ x: -0, y: -0, z: 25, wkid: 3857 })
    expect(Object.is(plan.x, -0)).toBe(false)
    expect(plan.z).toBe(25)
    expect(Object.isFrozen(plan)).toBe(true)
  })

  it('produces stable fingerprints for equivalent coordinates', () => {
    const value = policy()
    value.register({ wkid: 4326, kind: 'geographic', metersPerUnit: 1, wrapAround: true })
    expect(value.planCoordinate({ x: 190, y: 40, wkid: 4326 }).fingerprint).toBe(value.planCoordinate({ x: -170, y: 40, wkid: 4326 }).fingerprint)
  })
})
