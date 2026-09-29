import { describe, expect, it } from 'vitest'
import { ArcGisCachePolicy } from './ArcGisCachePolicy'

const budget = { maxEntries: 2, maxBytes: 10, maxEntryBytes: 8, maxTtlMs: 1000, maxKeyLength: 40, maxRevisionLength: 20, maxFingerprintLength: 40 }
const put = (cache: ArcGisCachePolicy<string>, key: string, value: string, byteSize: number, nowMs = 1) => cache.put({ key, value, byteSize, ttlMs: 100, nowMs, datasetRevision: 'r1', fingerprint: `fp-${key}` })

describe('ArcGisCachePolicy', () => {
  it('returns entries only for matching revision and fingerprint', () => { const c = new ArcGisCachePolicy<string>(budget); put(c, 'a', 'A', 2); expect(c.get('a', 'r1', 'fp-a', 2)).toBe('A') })
  it('fails closed on revision drift and removes stale entry', () => { const c = new ArcGisCachePolicy<string>(budget); put(c, 'a', 'A', 2); expect(c.get('a', 'r2', 'fp-a', 2)).toBeUndefined(); expect(c.snapshot().entries).toBe(0) })
  it('fails closed on fingerprint drift', () => { const c = new ArcGisCachePolicy<string>(budget); put(c, 'a', 'A', 2); expect(c.get('a', 'r1', 'different', 2)).toBeUndefined() })
  it('expires entries at the TTL boundary', () => { const c = new ArcGisCachePolicy<string>(budget); put(c, 'a', 'A', 2, 10); expect(c.get('a', 'r1', 'fp-a', 110)).toBeUndefined() })
  it('prunes all expired entries deterministically', () => { const c = new ArcGisCachePolicy<string>(budget); put(c, 'a', 'A', 2, 1); put(c, 'b', 'B', 2, 50); expect(c.prune(120)).toBe(1); expect(c.snapshot().keys).toEqual(['b']) })
  it('evicts least recently used entries when cardinality is exceeded', () => { const c = new ArcGisCachePolicy<string>(budget); put(c, 'a', 'A', 2, 1); put(c, 'b', 'B', 2, 2); c.get('a', 'r1', 'fp-a', 3); put(c, 'c', 'C', 2, 4); expect(c.snapshot().keys).toEqual(['a', 'c']) })
  it('evicts to aggregate byte budget', () => { const c = new ArcGisCachePolicy<string>(budget); put(c, 'a', 'A', 6, 1); put(c, 'b', 'B', 6, 2); expect(c.snapshot()).toMatchObject({ entries: 1, bytes: 6, keys: ['b'] }) })
  it('replacement preserves byte accounting', () => { const c = new ArcGisCachePolicy<string>(budget); put(c, 'a', 'A', 6); put(c, 'a', 'AA', 2, 2); expect(c.snapshot()).toMatchObject({ entries: 1, bytes: 2 }) })
  it('invalidates a dataset revision without touching others', () => { const c = new ArcGisCachePolicy<string>(budget); put(c, 'a', 'A', 2); c.put({ key: 'b', value: 'B', byteSize: 2, ttlMs: 100, nowMs: 1, datasetRevision: 'r2', fingerprint: 'fp-b' }); expect(c.invalidateRevision('r1')).toBe(1); expect(c.snapshot().keys).toEqual(['b']) })
  it('rejects oversized entries', () => { const c = new ArcGisCachePolicy<string>(budget); expect(() => put(c, 'a', 'A', 9)).toThrow('byteSize') })
  it('rejects TTLs beyond the configured ceiling', () => { const c = new ArcGisCachePolicy<string>(budget); expect(() => c.put({ key: 'a', value: 'A', byteSize: 1, ttlMs: 1001, nowMs: 1, datasetRevision: 'r1', fingerprint: 'fp' })).toThrow('ttlMs') })
  it('rejects control characters in identity material', () => { const c = new ArcGisCachePolicy<string>(budget); expect(() => c.get('bad\nkey', 'r1', 'fp', 1)).toThrow('invalid-cache-key') })
  it('rejects expiry arithmetic overflow', () => { const c = new ArcGisCachePolicy<string>(budget); expect(() => c.put({ key: 'a', value: 'A', byteSize: 1, ttlMs: 100, nowMs: Number.MAX_SAFE_INTEGER, datasetRevision: 'r1', fingerprint: 'fp' })).toThrow('cache-expiry-overflow') })
  it('returns immutable deterministic snapshots', () => { const c = new ArcGisCachePolicy<string>(budget); put(c, 'b', 'B', 2); put(c, 'a', 'A', 2); const s = c.snapshot(); expect(s.keys).toEqual(['a', 'b']); expect(Object.isFrozen(s.keys)).toBe(true); expect(Object.isFrozen(s)).toBe(true) })
  it('dispose is idempotent and rejects future mutation', () => { const c = new ArcGisCachePolicy<string>(budget); put(c, 'a', 'A', 2); c.dispose(); c.dispose(); expect(c.snapshot()).toMatchObject({ entries: 0, bytes: 0 }); expect(() => put(c, 'b', 'B', 2)).toThrow('arcgis-cache-disposed') })
  it('rejects a max entry budget larger than aggregate bytes', () => { expect(() => new ArcGisCachePolicy<string>({ ...budget, maxBytes: 4, maxEntryBytes: 5 })).toThrow('maxEntryBytes must be <= maxBytes') })
})
