import { describe, expect, it } from 'vitest';
import { OFFLINE_SNAPSHOT_VERSION, OfflineSnapshotCodec, type OfflineSnapshotMutation } from './offlineSnapshot';

const now = 10_000;
const mutation = (overrides: Partial<OfflineSnapshotMutation> = {}): OfflineSnapshotMutation => ({
  id: 'm-1', owner: 'address', operation: 'save', payload: { value: 1 }, priority: 'interactive', createdAt: 9_000, expiresAt: 11_000, maxAttempts: 3, ...overrides,
});

describe('OfflineSnapshotCodec', () => {
  it('round trips valid plain-data mutations', () => {
    const codec = new OfflineSnapshotCodec({ clock: () => now });
    const encoded = codec.encode([mutation()], now);
    const decoded = codec.decode(encoded, now);
    expect(decoded.snapshot.version).toBe(OFFLINE_SNAPSHOT_VERSION);
    expect(decoded.snapshot.mutations).toEqual([mutation()]);
  });

  it('normalizes text identifiers', () => {
    const codec = new OfflineSnapshotCodec({ clock: () => now });
    const decoded = codec.decode(codec.encode([mutation({ id: '  m-1  ', owner: '  owner ', operation: ' save ' })], now), now);
    expect(decoded.snapshot.mutations[0]).toMatchObject({ id: 'm-1', owner: 'owner', operation: 'save' });
  });

  it('preserves optional dedupe and metadata', () => {
    const codec = new OfflineSnapshotCodec({ clock: () => now });
    const item = mutation({ dedupeKey: 'address:1', metadata: { source: 'form' } });
    expect(codec.decode(codec.encode([item], now), now).snapshot.mutations[0]).toMatchObject({ dedupeKey: 'address:1', metadata: { source: 'form' } });
  });

  it('drops expired entries during decode', () => {
    const codec = new OfflineSnapshotCodec({ clock: () => now });
    const raw = codec.encode([mutation({ expiresAt: now }), mutation({ id: 'live', expiresAt: now + 1 })], now);
    const decoded = codec.decode(raw, now);
    expect(decoded.droppedExpired).toBe(1);
    expect(decoded.snapshot.mutations.map(item => item.id)).toEqual(['live']);
  });

  it('drops duplicate ids preserving first entry', () => {
    const codec = new OfflineSnapshotCodec({ clock: () => now });
    const raw = codec.encode([mutation({ payload: { order: 1 } }), mutation({ payload: { order: 2 } })], now);
    const decoded = codec.decode(raw, now);
    expect(decoded.droppedDuplicate).toBe(1);
    expect(decoded.snapshot.mutations[0]?.payload).toEqual({ order: 1 });
  });

  it('drops duplicate dedupe keys preserving first entry', () => {
    const codec = new OfflineSnapshotCodec({ clock: () => now });
    const raw = codec.encode([mutation({ id: 'a', dedupeKey: 'same' }), mutation({ id: 'b', dedupeKey: 'same' })], now);
    const decoded = codec.decode(raw, now);
    expect(decoded.droppedDuplicate).toBe(1);
    expect(decoded.snapshot.mutations.map(item => item.id)).toEqual(['a']);
  });

  it.each([0, 2, -1, '1', null])('rejects unsupported snapshot version %j', version => {
    const codec = new OfflineSnapshotCodec({ clock: () => now });
    expect(() => codec.decode(JSON.stringify({ version, writtenAt: now, mutations: [] }), now)).toThrow();
  });

  it('rejects future snapshots', () => {
    const codec = new OfflineSnapshotCodec({ clock: () => now });
    expect(() => codec.decode(JSON.stringify({ version: 1, writtenAt: now + 1, mutations: [] }), now)).toThrow(/future/);
  });

  it('rejects stale snapshots', () => {
    const codec = new OfflineSnapshotCodec({ clock: () => now, maxAgeMs: 1000 });
    expect(() => codec.decode(JSON.stringify({ version: 1, writtenAt: now - 1001, mutations: [] }), now)).toThrow(/stale/);
  });

  it('rejects malformed JSON', () => {
    expect(() => new OfflineSnapshotCodec().decode('{', now)).toThrow(/valid JSON/);
  });

  it.each(['null', '[]', '1', '"x"'])('rejects non-object root %s', raw => {
    expect(() => new OfflineSnapshotCodec().decode(raw, now)).toThrow(/root/);
  });

  it('rejects non-array mutations', () => {
    expect(() => new OfflineSnapshotCodec().decode(JSON.stringify({ version: 1, writtenAt: now, mutations: {} }), now)).toThrow(/array/);
  });

  it('enforces entry count on encode and decode', () => {
    const codec = new OfflineSnapshotCodec({ maxEntries: 1, clock: () => now });
    expect(() => codec.encode([mutation({ id: 'a' }), mutation({ id: 'b' })], now)).toThrow(/entry budget/);
    expect(() => codec.decode(JSON.stringify({ version: 1, writtenAt: now, mutations: [mutation({ id: 'a' }), mutation({ id: 'b' })] }), now)).toThrow(/entry budget/);
  });

  it('enforces snapshot byte budget before JSON parsing', () => {
    const codec = new OfflineSnapshotCodec({ maxSnapshotBytes: 1024, maxPayloadBytes: 512 });
    expect(() => codec.decode(' '.repeat(1025), now)).toThrow(/byte budget/);
  });

  it('enforces payload byte budget', () => {
    const codec = new OfflineSnapshotCodec({ maxPayloadBytes: 16, clock: () => now });
    expect(() => codec.encode([mutation({ payload: { text: 'x'.repeat(100) } })], now)).toThrow(/payload byte budget/);
  });

  it('rejects cyclic payloads', () => {
    const payload: Record<string, unknown> = {};
    payload.self = payload;
    expect(() => new OfflineSnapshotCodec({ clock: () => now }).encode([mutation({ payload })], now)).toThrow(/cycles/);
  });

  it('rejects unsupported payload objects', () => {
    expect(() => new OfflineSnapshotCodec({ clock: () => now }).encode([mutation({ payload: new Date() })], now)).toThrow(/plain data/);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])('rejects non-finite payload number %s', value => {
    expect(() => new OfflineSnapshotCodec({ clock: () => now }).encode([mutation({ payload: { value } })], now)).toThrow(/finite/);
  });

  it('rejects prototype pollution keys in payloads', () => {
    const payload = JSON.parse('{"constructor":{"prototype":{"polluted":true}}}') as Record<string, unknown>;
    expect(() => new OfflineSnapshotCodec({ clock: () => now }).encode([mutation({ payload })], now)).toThrow(/unsafe payload key/);
  });

  it('rejects excessively nested payloads', () => {
    let payload: unknown = 'leaf';
    for (let index = 0; index < 26; index += 1) payload = { child: payload };
    expect(() => new OfflineSnapshotCodec({ clock: () => now }).encode([mutation({ payload })], now)).toThrow(/nesting/);
  });

  it.each(['critical', 'interactive', 'background'] as const)('accepts priority %s', priority => {
    const codec = new OfflineSnapshotCodec({ clock: () => now });
    expect(codec.decode(codec.encode([mutation({ priority })], now), now).snapshot.mutations[0]?.priority).toBe(priority);
  });

  it('rejects invalid priority', () => {
    const raw = JSON.stringify({ version: 1, writtenAt: now, mutations: [{ ...mutation(), priority: 'urgent' }] });
    expect(() => new OfflineSnapshotCodec().decode(raw, now)).toThrow(/priority/);
  });

  it('rejects createdAt after snapshot write time', () => {
    expect(() => new OfflineSnapshotCodec({ clock: () => now }).encode([mutation({ createdAt: now + 1, expiresAt: now + 2 })], now)).toThrow(/lifetime/);
  });

  it('rejects expiration before creation', () => {
    expect(() => new OfflineSnapshotCodec({ clock: () => now }).encode([mutation({ createdAt: 9000, expiresAt: 9000 })], now)).toThrow(/lifetime/);
  });

  it('rejects lifetimes exceeding max age', () => {
    const codec = new OfflineSnapshotCodec({ maxAgeMs: 1000, clock: () => now });
    expect(() => codec.encode([mutation({ createdAt: 9000, expiresAt: 10001 })], now)).toThrow(/lifetime/);
  });

  it.each([0, 11])('rejects maxAttempts %s', maxAttempts => {
    expect(() => new OfflineSnapshotCodec({ clock: () => now }).encode([mutation({ maxAttempts })], now)).toThrow(/maxAttempts/);
  });

  it('enforces metadata entry budget', () => {
    const codec = new OfflineSnapshotCodec({ maxMetadataEntries: 1, clock: () => now });
    expect(() => codec.encode([mutation({ metadata: { a: '1', b: '2' } })], now)).toThrow(/metadata entry budget/);
  });

  it('enforces metadata value length', () => {
    const codec = new OfflineSnapshotCodec({ maxMetadataValueLength: 2, clock: () => now });
    expect(() => codec.encode([mutation({ metadata: { a: '123' } })], now)).toThrow(/metadata value/);
  });

  it('rejects control characters in metadata', () => {
    expect(() => new OfflineSnapshotCodec({ clock: () => now }).encode([mutation({ metadata: { a: 'x\u0000y' } })], now)).toThrow(/metadata value/);
  });

  it('rejects control characters in identifiers', () => {
    expect(() => new OfflineSnapshotCodec({ clock: () => now }).encode([mutation({ id: 'x\u0000y' })], now)).toThrow(/printable/);
  });

  it('enforces text length', () => {
    const codec = new OfflineSnapshotCodec({ maxTextLength: 16, clock: () => now });
    expect(() => codec.encode([mutation({ id: 'x'.repeat(17) })], now)).toThrow(/printable/);
  });

  it('returns immutable top-level decoded structures', () => {
    const codec = new OfflineSnapshotCodec({ clock: () => now });
    const result = codec.decode(codec.encode([mutation()], now), now);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.snapshot)).toBe(true);
    expect(Object.isFrozen(result.snapshot.mutations)).toBe(true);
    expect(Object.isFrozen(result.snapshot.mutations[0])).toBe(true);
  });

  it('clones payload data rather than retaining caller object identity', () => {
    const codec = new OfflineSnapshotCodec({ clock: () => now });
    const payload = { nested: { value: 1 } };
    const raw = codec.encode([mutation({ payload })], now);
    payload.nested.value = 2;
    expect(codec.decode(raw, now).snapshot.mutations[0]?.payload).toEqual({ nested: { value: 1 } });
  });
});
