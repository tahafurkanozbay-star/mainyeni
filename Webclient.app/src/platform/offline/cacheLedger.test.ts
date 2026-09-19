import { createOfflineCacheLedger } from './cacheLedger';
import type { OfflineCacheLimits } from './contracts';

const limits: OfflineCacheLimits = Object.freeze({
  maxEntries: 3,
  maxBytes: 300,
  maxEntryBytes: 200,
  maxAgeMs: 1000,
});

describe('offline cache ledger', () => {
  test('records immutable bounded metadata', () => {
    let now = 10;
    const ledger = createOfflineCacheLedger({ limits, now: () => now });
    const record = ledger.record('https://example/a', {
      kind: 'static',
      bytes: 50,
    });
    expect(record).toEqual({
      key: 'https://example/a',
      kind: 'static',
      bytes: 50,
      measured: true,
      createdAt: 10,
      accessedAt: 10,
      expiresAt: 1010,
      hits: 0,
    });
    expect(Object.isFrozen(record)).toBe(true);
    expect(ledger.size()).toBe(1);
    now += 1;
    expect(ledger.get('https://example/a')?.createdAt).toBe(10);
  });

  test('preserves createdAt across replacement writes', () => {
    let now = 100;
    const ledger = createOfflineCacheLedger({ limits, now: () => now });
    ledger.record('a', { kind: 'static', bytes: 10 });
    now = 200;
    const next = ledger.record('a', { kind: 'static', bytes: 20 });
    expect(next.createdAt).toBe(100);
    expect(next.accessedAt).toBe(200);
    expect(next.bytes).toBe(20);
    expect(ledger.snapshot().writes).toBe(2);
  });

  test('tracks hits and LRU access time', () => {
    let now = 1;
    const ledger = createOfflineCacheLedger({ limits, now: () => now });
    ledger.record('a', { kind: 'static', bytes: 10 });
    now = 5;
    const touched = ledger.touch('a');
    expect(touched?.hits).toBe(1);
    expect(touched?.accessedAt).toBe(5);
    expect(ledger.snapshot().hits).toBe(1);
  });

  test('expired records disappear on get', () => {
    let now = 0;
    const ledger = createOfflineCacheLedger({ limits, now: () => now });
    ledger.record('a', { kind: 'static', bytes: 10, ttlMs: 1000 });
    now = 1001;
    expect(ledger.get('a')).toBeNull();
    expect(ledger.size()).toBe(0);
    expect(ledger.snapshot().evictions).toBe(1);
  });

  test('ttl is clamped to max age', () => {
    const ledger = createOfflineCacheLedger({ limits, now: () => 10 });
    const record = ledger.record('a', {
      kind: 'static',
      bytes: 10,
      ttlMs: 99_999,
    });
    expect(record.expiresAt).toBe(1010);
  });

  test('rejects entries larger than maxEntryBytes', () => {
    const ledger = createOfflineCacheLedger({ limits });
    expect(() => ledger.record('huge', {
      kind: 'static',
      bytes: 201,
    })).toThrow(RangeError);
    expect(ledger.snapshot().rejections).toBe(1);
  });

  test('prunes least recently used record when max entries is exceeded', () => {
    let now = 0;
    const ledger = createOfflineCacheLedger({ limits, now: () => ++now });
    ledger.record('a', { kind: 'static', bytes: 10 });
    ledger.record('b', { kind: 'static', bytes: 10 });
    ledger.record('c', { kind: 'static', bytes: 10 });
    ledger.touch('a');
    ledger.record('d', { kind: 'static', bytes: 10 });
    expect(ledger.prune()).toEqual(['b']);
    expect(ledger.get('a')).not.toBeNull();
    expect(ledger.get('b')).toBeNull();
    expect(ledger.get('d')).not.toBeNull();
  });

  test('prunes by aggregate byte budget', () => {
    let now = 0;
    const ledger = createOfflineCacheLedger({ limits, now: () => ++now });
    ledger.record('a', { kind: 'static', bytes: 150 });
    ledger.record('b', { kind: 'static', bytes: 100 });
    ledger.record('c', { kind: 'static', bytes: 100 });
    expect(ledger.prune()).toEqual(['a']);
    expect(ledger.snapshot().bytes).toBe(200);
  });

  test('prunes expired records before LRU pressure', () => {
    let now = 0;
    const ledger = createOfflineCacheLedger({ limits, now: () => now });
    ledger.record('expired', { kind: 'static', bytes: 150, ttlMs: 1000 });
    now = 10;
    ledger.record('fresh-a', { kind: 'static', bytes: 100 });
    ledger.record('fresh-b', { kind: 'static', bytes: 100 });
    now = 1001;
    expect(ledger.prune()).toEqual(['expired']);
    expect(ledger.snapshot().entries).toBe(2);
  });

  test('remove is idempotent', () => {
    const ledger = createOfflineCacheLedger({ limits });
    ledger.record('a', { kind: 'static', bytes: 10 });
    expect(ledger.remove('a')).toBe(true);
    expect(ledger.remove('a')).toBe(false);
  });

  test('clear returns previous cardinality', () => {
    const ledger = createOfflineCacheLedger({ limits });
    ledger.record('a', { kind: 'static', bytes: 10 });
    ledger.record('b', { kind: 'api-read', bytes: 20 });
    expect(ledger.clear()).toBe(2);
    expect(ledger.clear()).toBe(0);
    expect(ledger.size()).toBe(0);
  });

  test('snapshot distinguishes measured and unmeasured entries', () => {
    const ledger = createOfflineCacheLedger({ limits });
    ledger.record('a', { kind: 'static', bytes: 10, measured: true });
    ledger.record('b', { kind: 'static', bytes: 0, measured: false });
    const snapshot = ledger.snapshot();
    expect(snapshot.measuredEntries).toBe(1);
    expect(snapshot.unmeasuredEntries).toBe(1);
    expect(snapshot.records).toHaveLength(2);
    expect(Object.isFrozen(snapshot.records)).toBe(true);
  });

  test('snapshot ordering is most recently accessed first', () => {
    let now = 0;
    const ledger = createOfflineCacheLedger({ limits, now: () => ++now });
    ledger.record('a', { kind: 'static', bytes: 10 });
    ledger.record('b', { kind: 'static', bytes: 10 });
    ledger.touch('a');
    expect(ledger.snapshot().records.map((item) => item.key)).toEqual(['a', 'b']);
  });

  test('empty and excessively long keys are rejected', () => {
    const ledger = createOfflineCacheLedger({ limits });
    expect(() => ledger.record('', { kind: 'static', bytes: 1 })).toThrow(TypeError);
    expect(() => ledger.record('x'.repeat(5000), { kind: 'static', bytes: 1 })).toThrow(TypeError);
  });

  test('negative or non-finite bytes normalize to zero', () => {
    const ledger = createOfflineCacheLedger({ limits });
    expect(ledger.record('a', { kind: 'static', bytes: -5 }).bytes).toBe(0);
    expect(ledger.record('b', { kind: 'static', bytes: Number.NaN }).bytes).toBe(0);
  });
});
