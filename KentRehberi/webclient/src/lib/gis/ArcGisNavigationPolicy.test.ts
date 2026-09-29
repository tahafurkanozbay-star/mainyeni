import { describe, expect, it } from 'vitest'
import { ArcGisNavigationPolicy } from './ArcGisNavigationPolicy'

const policy = () => new ArcGisNavigationPolicy({
  allowedWkids: [3857, 4326], minScale: 100, maxScale: 10_000_000,
  maxCoordinateMagnitude: 30_000_000, maxAltitude: 100_000, maxTilt: 85,
  maxDurationMs: 10_000, maxRevisionLength: 32,
})

const base = { dimension: '2d' as const, spatialReferenceWkid: 3857, reason: 'user' as const, revision: 'r1',
  pose: { centerX: 1, centerY: 2, scale: 1000, heading: 0, tilt: 0 } }

describe('ArcGisNavigationPolicy', () => {
  it('admits a bounded 2d pose', () => expect(policy().plan(base)).toMatchObject({ dimension: '2d', spatialReferenceWkid: 3857, durationMs: 0 }))
  it('canonicalizes Web Mercator aliases', () => expect(policy().plan({ ...base, spatialReferenceWkid: 102100 }).spatialReferenceWkid).toBe(3857))
  it('normalizes headings deterministically', () => expect(policy().plan({ ...base, pose: { ...base.pose, heading: -90 } }).pose.heading).toBe(270))
  it('rejects unknown wkids', () => expect(() => policy().plan({ ...base, spatialReferenceWkid: 26910 })).toThrow('navigation-wkid-not-allowed'))
  it('rejects non-finite centers', () => expect(() => policy().plan({ ...base, pose: { ...base.pose, centerX: NaN } })).toThrow('centerX-out-of-range'))
  it('rejects coordinates outside the budget', () => expect(() => policy().plan({ ...base, pose: { ...base.pose, centerY: 40_000_000 } })).toThrow('centerY-out-of-range'))
  it('rejects scale below the admitted range', () => expect(() => policy().plan({ ...base, pose: { ...base.pose, scale: 99 } })).toThrow('scale-out-of-range'))
  it('rejects scale above the admitted range', () => expect(() => policy().plan({ ...base, pose: { ...base.pose, scale: 10_000_001 } })).toThrow('scale-out-of-range'))
  it('rejects altitude in 2d', () => expect(() => policy().plan({ ...base, pose: { ...base.pose, centerZ: 4 } })).toThrow('2d-navigation-cannot-retain-altitude'))
  it('rejects tilt in 2d', () => expect(() => policy().plan({ ...base, pose: { ...base.pose, tilt: 1 } })).toThrow('2d-navigation-requires-zero-tilt'))
  it('admits bounded 3d altitude and tilt', () => expect(policy().plan({ ...base, dimension: '3d', pose: { ...base.pose, centerZ: 250, tilt: 60 } }).pose).toMatchObject({ centerZ: 250, tilt: 60 }))
  it('rejects excessive 3d altitude', () => expect(() => policy().plan({ ...base, dimension: '3d', pose: { ...base.pose, centerZ: 100_001 } })).toThrow('centerZ-out-of-range'))
  it('rejects excessive tilt', () => expect(() => policy().plan({ ...base, dimension: '3d', pose: { ...base.pose, tilt: 86 } })).toThrow('tilt-out-of-range'))
  it('rejects excessive transition duration', () => expect(() => policy().plan({ ...base, durationMs: 10_001 })).toThrow('durationMs-out-of-range'))
  it('normalizes revision whitespace', () => expect(policy().plan({ ...base, revision: '  data   r1 ' }).revision).toBe('data r1'))
  it('rejects control characters in revisions', () => expect(() => policy().plan({ ...base, revision: 'r\u0000x' })).toThrow('invalid-navigation-revision'))
  it('produces stable fingerprints', () => expect(policy().plan(base).fingerprint).toBe(policy().plan({ ...base }).fingerprint))
  it('fingerprints revision changes', () => expect(policy().plan(base).fingerprint).not.toBe(policy().plan({ ...base, revision: 'r2' }).fingerprint))
  it('fingerprints reason changes', () => expect(policy().plan(base).fingerprint).not.toBe(policy().plan({ ...base, reason: 'search' }).fingerprint))
  it('returns immutable plans and poses', () => { const plan = policy().plan(base); expect(Object.isFrozen(plan)).toBe(true); expect(Object.isFrozen(plan.pose)).toBe(true) })
})
