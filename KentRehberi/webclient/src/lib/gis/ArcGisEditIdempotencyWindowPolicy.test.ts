import { describe, expect, it } from 'vitest'
import { ArcGisEditIdempotencyWindowPolicy } from './ArcGisEditIdempotencyWindowPolicy'

const budget = { maxLayers: 2, maxKeys: 3, maxKeysPerLayer: 2, ttlMs: 100 }
const make = () => new ArcGisEditIdempotencyWindowPolicy(budget)
const request = (key: string, digest = 'digest-a', layerId = 'roads', revision = 1, createdAt = 1) => ({ key, operationDigest: digest, layerId, revision, createdAt })

describe('ArcGisEditIdempotencyWindowPolicy', () => {
  it('rejects entries without revision authority', () => { const p = make(); expect(p.register(request('a'))).toBe('rejected') })
  it('accepts a first current-revision key', () => { const p = make(); p.setRevision('roads', 1); expect(p.register(request('a'))).toBe('accepted') })
  it('classifies identical replay as duplicate', () => { const p = make(); p.setRevision('roads', 1); p.register(request('a')); expect(p.register(request('a'))).toBe('duplicate') })
  it('classifies same key with different digest as conflict', () => { const p = make(); p.setRevision('roads', 1); p.register(request('a')); expect(p.register(request('a', 'digest-b'))).toBe('conflict') })
  it('classifies same key on another layer as conflict', () => { const p = make(); p.setRevision('roads', 1); p.setRevision('parks', 1); p.register(request('a')); expect(p.register(request('a', 'digest-a', 'parks'))).toBe('conflict') })
  it('invalidates keys when revision advances', () => { const p = make(); p.setRevision('roads', 1); p.register(request('a')); expect(p.setRevision('roads', 2)).toBe(1); expect(p.snapshot().keys).toBe(0) })
  it('rejects revision regression', () => { const p = make(); p.setRevision('roads', 2); expect(p.setRevision('roads', 1)).toBe(-1) })
  it('bounds layer authority', () => { const p = new ArcGisEditIdempotencyWindowPolicy({ ...budget, maxLayers: 1 }); p.setRevision('roads', 1); expect(p.setRevision('parks', 1)).toBe(-1) })
  it('bounds global keys', () => { const p = new ArcGisEditIdempotencyWindowPolicy({ ...budget, maxKeys: 1, maxKeysPerLayer: 1 }); p.setRevision('roads', 1); p.register(request('a')); expect(p.register(request('b'))).toBe('rejected') })
  it('bounds per-layer keys', () => { const p = new ArcGisEditIdempotencyWindowPolicy({ ...budget, maxKeysPerLayer: 1 }); p.setRevision('roads', 1); p.register(request('a')); expect(p.register(request('b'))).toBe('rejected') })
  it('reports membership only for current revision', () => { const p = make(); p.setRevision('roads', 1); p.register(request('a')); expect(p.has('a', 1, 2)).toBe(true); expect(p.has('a', 2, 2)).toBe(false) })
  it('expires keys at bounded TTL', () => { const p = make(); p.setRevision('roads', 1); p.register(request('a', 'd', 'roads', 1, 10)); expect(p.expire(109)).toBe(0); expect(p.expire(110)).toBe(1) })
  it('membership check expires stale keys', () => { const p = make(); p.setRevision('roads', 1); p.register(request('a')); expect(p.has('a', 1, 101)).toBe(false) })
  it('releaseLayer clears keys and revision authority', () => { const p = make(); p.setRevision('roads', 1); p.register(request('a')); expect(p.releaseLayer('roads')).toBe(1); expect(p.register(request('b'))).toBe('rejected') })
  it('normalizes scalar identifiers', () => { const p = make(); p.setRevision(' roads ', 1); expect(p.register(request(' a ', ' digest ', ' roads '))).toBe('accepted'); expect(p.fingerprint()).toContain('roads:a:1:digest') })
  it('does not retain excess caller payload', () => { const p = make(); p.setRevision('roads', 1); expect(p.register({ ...request('a'), ...({ geometry: { x: 1 }, attributes: { secret: 'x' } } as object) })).toBe('accepted'); expect(p.fingerprint()).not.toContain('secret') })
  it('produces deterministic scalar fingerprints', () => { const p = make(); p.setRevision('roads', 1); p.register(request('a')); p.register(request('b', 'digest-b')); expect(p.fingerprint()).toBe('roads:a:1:digest-a|roads:b:1:digest-b') })
  it('validates identifiers and times', () => { const p = make(); expect(() => p.setRevision('', 1)).toThrow(); p.setRevision('roads', 1); expect(() => p.register(request('', 'd'))).toThrow(); expect(() => p.register(request('a', 'd', 'roads', 1, -1))).toThrow() })
  it('validates budget hierarchy', () => { expect(() => new ArcGisEditIdempotencyWindowPolicy({ ...budget, maxKeys: 1, maxKeysPerLayer: 2 })).toThrow() })
  it('dispose is idempotent and terminal', () => { const p = make(); p.setRevision('roads', 1); p.register(request('a')); p.dispose(); p.dispose(); expect(() => p.snapshot()).toThrow('disposed'); expect(() => p.register(request('b'))).toThrow('disposed') })
})
