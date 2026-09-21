import { describe, expect, it, vi } from 'vitest';
import { OfflineMutationQueue, OfflineMutationRejectedError } from './offlineMutationQueue';

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

const mutation = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  owner: 'map-edit',
  operation: 'save-feature',
  payload: { id, name: `feature-${id}` },
  ...overrides,
});

describe('OfflineMutationQueue', () => {
  it('keeps work queued while offline and replays when online', async () => {
    const queue = new OfflineMutationQueue();
    const executor = vi.fn(async (payload: unknown) => payload);
    queue.setExecutor(executor);
    const result = queue.enqueue(mutation('a'));
    expect(queue.snapshot()).toMatchObject({ queued: 1, running: 0 });
    expect(executor).not.toHaveBeenCalled();
    queue.setOnline(true);
    await expect(result).resolves.toMatchObject({ id: 'a', state: 'succeeded', attempts: 1 });
    expect(executor).toHaveBeenCalledTimes(1);
  });

  it('bounds concurrent replay', async () => {
    const first = deferred<void>();
    const second = deferred<void>();
    const starts: string[] = [];
    const queue = new OfflineMutationQueue({ maxConcurrent: 2 });
    queue.setExecutor(async (_payload, context) => {
      starts.push(context.id);
      if (context.id === 'a') await first.promise;
      if (context.id === 'b') await second.promise;
      return context.id;
    });
    queue.setOnline(true);
    const a = queue.enqueue(mutation('a'));
    const b = queue.enqueue(mutation('b'));
    const c = queue.enqueue(mutation('c'));
    await Promise.resolve();
    expect(starts).toEqual(['a', 'b']);
    expect(queue.snapshot()).toMatchObject({ running: 2, queued: 1 });
    first.resolve();
    await a;
    await Promise.resolve();
    expect(starts).toEqual(['a', 'b', 'c']);
    second.resolve();
    await Promise.all([b, c]);
  });

  it('prioritizes critical work before interactive and background work', async () => {
    const starts: string[] = [];
    const queue = new OfflineMutationQueue({ maxConcurrent: 1 });
    queue.setExecutor(async (_payload, context) => { starts.push(context.id); return context.id; });
    const background = queue.enqueue(mutation('background', { priority: 'background' }));
    const interactive = queue.enqueue(mutation('interactive', { priority: 'interactive' }));
    const critical = queue.enqueue(mutation('critical', { priority: 'critical' }));
    queue.setOnline(true);
    await Promise.all([background, interactive, critical]);
    expect(starts).toEqual(['critical', 'interactive', 'background']);
  });

  it('deduplicates identical ids', async () => {
    const queue = new OfflineMutationQueue();
    const first = queue.enqueue(mutation('same'));
    const second = queue.enqueue(mutation('same'));
    expect(second).toBe(first);
    expect(queue.snapshot().totalAccepted).toBe(1);
  });

  it('deduplicates explicit dedupe keys across ids', async () => {
    const queue = new OfflineMutationQueue();
    const first = queue.enqueue(mutation('a', { dedupeKey: 'feature:42' }));
    const second = queue.enqueue(mutation('b', { dedupeKey: 'feature:42' }));
    expect(second).toBe(first);
    expect(queue.pending()).toHaveLength(1);
    expect(queue.history().at(-1)).toMatchObject({ state: 'deduplicated' });
  });

  it('rejects beyond global queue capacity', async () => {
    const queue = new OfflineMutationQueue({ maxEntries: 1, maxEntriesPerOwner: 1 });
    void queue.enqueue(mutation('a'));
    await expect(queue.enqueue(mutation('b'))).rejects.toEqual(new OfflineMutationRejectedError('queue-capacity'));
    expect(queue.snapshot().totalRejected).toBe(1);
  });

  it('isolates noisy owners', async () => {
    const queue = new OfflineMutationQueue({ maxEntries: 4, maxEntriesPerOwner: 1 });
    void queue.enqueue(mutation('a'));
    await expect(queue.enqueue(mutation('b'))).rejects.toMatchObject({ reason: 'owner-capacity' });
    const other = queue.enqueue(mutation('c', { owner: 'search-edit' }));
    expect(queue.pending()).toHaveLength(2);
    queue.setExecutor(async () => true);
    queue.setOnline(true);
    await other;
  });

  it('rejects payloads above the byte budget', async () => {
    const queue = new OfflineMutationQueue({ maxPayloadBytes: 32 });
    await expect(queue.enqueue(mutation('large', { payload: { text: 'x'.repeat(100) } }))).rejects.toMatchObject({ reason: 'payload-budget' });
  });

  it('rejects cyclic payloads fail closed', async () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const queue = new OfflineMutationQueue();
    await expect(queue.enqueue(mutation('cyclic', { payload: cyclic }))).rejects.toMatchObject({ reason: 'invalid-descriptor' });
  });

  it('rejects class instances from persisted payload contracts', async () => {
    class SecretBox { value = 'secret'; }
    const queue = new OfflineMutationQueue();
    await expect(queue.enqueue(mutation('class', { payload: new SecretBox() }))).rejects.toMatchObject({ reason: 'invalid-descriptor' });
  });

  it('accepts typed arrays and accounts their bytes', async () => {
    const queue = new OfflineMutationQueue({ maxPayloadBytes: 64 });
    const pending = queue.enqueue(mutation('typed', { payload: new Uint8Array(32) }));
    queue.setExecutor(async () => 'ok');
    queue.setOnline(true);
    await expect(pending).resolves.toMatchObject({ state: 'succeeded' });
  });

  it('bounds metadata cardinality', async () => {
    const queue = new OfflineMutationQueue({ maxMetadataEntries: 1 });
    await expect(queue.enqueue(mutation('meta', { metadata: { a: '1', b: '2' } }))).rejects.toMatchObject({ reason: 'invalid-descriptor' });
  });

  it('bounds metadata value length', async () => {
    const queue = new OfflineMutationQueue({ maxMetadataValueLength: 4 });
    await expect(queue.enqueue(mutation('meta', { metadata: { a: '12345' } }))).rejects.toMatchObject({ reason: 'invalid-descriptor' });
  });

  it('rejects metadata control characters', async () => {
    const queue = new OfflineMutationQueue();
    await expect(queue.enqueue(mutation('meta', { metadata: { a: 'bad\nvalue' } }))).rejects.toMatchObject({ reason: 'invalid-descriptor' });
  });

  it('rejects invalid identifiers', async () => {
    const queue = new OfflineMutationQueue();
    await expect(queue.enqueue(mutation('   '))).rejects.toMatchObject({ reason: 'invalid-descriptor' });
    await expect(queue.enqueue(mutation('x', { owner: '\u0000' }))).rejects.toMatchObject({ reason: 'invalid-descriptor' });
  });

  it('rejects descriptors already expired', async () => {
    let now = 100;
    const queue = new OfflineMutationQueue({ clock: () => now, maxAgeMs: 1_000 });
    await expect(queue.enqueue(mutation('old', { createdAt: 1, expiresAt: 10 }))).rejects.toMatchObject({ reason: 'expired' });
  });

  it('prunes expired queued work', async () => {
    let now = 0;
    const queue = new OfflineMutationQueue({ clock: () => now, maxAgeMs: 1_000 });
    const pending = queue.enqueue(mutation('a', { createdAt: 0, expiresAt: 10 }));
    now = 11;
    expect(queue.pruneExpired()).toBe(1);
    await expect(pending).resolves.toMatchObject({ state: 'expired', attempts: 0 });
    expect(queue.snapshot().totalExpired).toBe(1);
  });

  it('retries failures only up to the descriptor attempt ceiling', async () => {
    const queue = new OfflineMutationQueue({ maxAttempts: 5 });
    const executor = vi.fn(async () => { throw new Error('temporary'); });
    queue.setExecutor(executor);
    queue.setOnline(true);
    const result = await queue.enqueue(mutation('a', { maxAttempts: 3 }));
    expect(result).toMatchObject({ state: 'failed', attempts: 3 });
    expect(executor).toHaveBeenCalledTimes(3);
  });

  it('succeeds after a bounded retry', async () => {
    const queue = new OfflineMutationQueue({ maxAttempts: 3 });
    let attempts = 0;
    queue.setExecutor(async () => {
      attempts += 1;
      if (attempts < 2) throw new Error('retry');
      return 'saved';
    });
    queue.setOnline(true);
    await expect(queue.enqueue(mutation('a'))).resolves.toMatchObject({ state: 'succeeded', attempts: 2, value: 'saved' });
  });

  it('cancels queued work', async () => {
    const queue = new OfflineMutationQueue();
    const pending = queue.enqueue(mutation('a'));
    expect(queue.cancel('a')).toBe(true);
    await expect(pending).resolves.toMatchObject({ state: 'cancelled', attempts: 0 });
    expect(queue.cancel('missing')).toBe(false);
  });

  it('aborts running work and reports cancellation', async () => {
    const queue = new OfflineMutationQueue();
    queue.setExecutor(async (_payload, context) => new Promise((_resolve, reject) => {
      context.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }));
    queue.setOnline(true);
    const pending = queue.enqueue(mutation('a'));
    await Promise.resolve();
    expect(queue.cancel('a', 'navigation')).toBe(true);
    await expect(pending).resolves.toMatchObject({ state: 'cancelled' });
  });

  it('cancels all work owned by a feature boundary', async () => {
    const queue = new OfflineMutationQueue();
    const a = queue.enqueue(mutation('a'));
    const b = queue.enqueue(mutation('b'));
    const c = queue.enqueue(mutation('c', { owner: 'other' }));
    expect(queue.cancelOwner('map-edit')).toBe(2);
    await expect(a).resolves.toMatchObject({ state: 'cancelled' });
    await expect(b).resolves.toMatchObject({ state: 'cancelled' });
    expect(queue.pending()).toHaveLength(1);
    queue.setExecutor(async () => true);
    queue.setOnline(true);
    await c;
  });

  it('does not expose mutable pending metadata', () => {
    const queue = new OfflineMutationQueue();
    void queue.enqueue(mutation('a', { metadata: { source: 'editor' } }));
    const pending = queue.pending();
    expect(Object.isFrozen(pending)).toBe(true);
    expect(Object.isFrozen(pending[0])).toBe(true);
    expect(Object.isFrozen(pending[0]?.metadata)).toBe(true);
  });

  it('returns pending work in deterministic replay order', () => {
    let now = 0;
    const queue = new OfflineMutationQueue({ clock: () => now });
    void queue.enqueue(mutation('b', { priority: 'interactive', createdAt: ++now }));
    void queue.enqueue(mutation('c', { priority: 'background', createdAt: ++now }));
    void queue.enqueue(mutation('a', { priority: 'critical', createdAt: ++now }));
    expect(queue.pending().map(item => item.id)).toEqual(['a', 'b', 'c']);
  });

  it('bounds immutable diagnostic history', async () => {
    let now = 0;
    const queue = new OfflineMutationQueue({ historyLimit: 2, clock: () => ++now });
    const pending = queue.enqueue(mutation('a'));
    queue.cancel('a');
    await pending;
    const history = queue.history();
    expect(history).toHaveLength(2);
    expect(Object.isFrozen(history)).toBe(true);
    expect(Object.isFrozen(history[0])).toBe(true);
  });

  it('can disable diagnostic history', () => {
    const queue = new OfflineMutationQueue({ historyLimit: 0 });
    void queue.enqueue(mutation('a'));
    expect(queue.history()).toEqual([]);
  });

  it('dispose cancels queued work and rejects future admission', async () => {
    const queue = new OfflineMutationQueue();
    const pending = queue.enqueue(mutation('a'));
    queue.dispose('shutdown');
    await expect(pending).resolves.toMatchObject({ state: 'cancelled' });
    await expect(queue.enqueue(mutation('b'))).rejects.toMatchObject({ reason: 'disposed' });
    expect(queue.snapshot().disposed).toBe(true);
  });

  it('dispose aborts running work', async () => {
    const queue = new OfflineMutationQueue();
    queue.setExecutor(async (_payload, context) => new Promise((_resolve, reject) => {
      context.signal.addEventListener('abort', () => reject(new Error('shutdown')), { once: true });
    }));
    queue.setOnline(true);
    const pending = queue.enqueue(mutation('a'));
    await Promise.resolve();
    queue.dispose();
    await expect(pending).resolves.toMatchObject({ state: 'cancelled' });
  });

  it('validates queue configuration', () => {
    expect(() => new OfflineMutationQueue({ maxEntries: 0 })).toThrow(RangeError);
    expect(() => new OfflineMutationQueue({ maxEntries: 2, maxEntriesPerOwner: 3 })).toThrow(RangeError);
    expect(() => new OfflineMutationQueue({ maxConcurrent: 0 })).toThrow(RangeError);
    expect(() => new OfflineMutationQueue({ maxAttempts: 11 })).toThrow(RangeError);
    expect(() => new OfflineMutationQueue({ maxAgeMs: 999 })).toThrow(RangeError);
  });

  it('uses a custom byte estimator when supplied', async () => {
    const estimateBytes = vi.fn(() => 100);
    const queue = new OfflineMutationQueue({ maxPayloadBytes: 50, estimateBytes });
    await expect(queue.enqueue(mutation('a'))).rejects.toMatchObject({ reason: 'payload-budget' });
    expect(estimateBytes).toHaveBeenCalledOnce();
  });

  it('preserves executor result values', async () => {
    const queue = new OfflineMutationQueue();
    queue.setExecutor(async () => ({ objectId: 42, version: 3 }));
    queue.setOnline(true);
    await expect(queue.enqueue(mutation('a'))).resolves.toMatchObject({ value: { objectId: 42, version: 3 } });
  });

  it('passes stable replay context to executor', async () => {
    const queue = new OfflineMutationQueue();
    const contexts: unknown[] = [];
    queue.setExecutor(async (_payload, context) => { contexts.push(context); return true; });
    queue.setOnline(true);
    await queue.enqueue(mutation('a', { owner: 'owner-a', operation: 'op-a' }));
    expect(contexts).toHaveLength(1);
    expect(contexts[0]).toMatchObject({ id: 'a', owner: 'owner-a', operation: 'op-a', attempt: 1 });
  });

  it('does not start work without an executor even when online', () => {
    const queue = new OfflineMutationQueue();
    queue.setOnline(true);
    void queue.enqueue(mutation('a'));
    expect(queue.snapshot()).toMatchObject({ queued: 1, running: 0 });
  });

  it('can replace executor before replay', async () => {
    const queue = new OfflineMutationQueue();
    const first = vi.fn(async () => 'first');
    const second = vi.fn(async () => 'second');
    queue.setExecutor(first);
    const pending = queue.enqueue(mutation('a'));
    queue.setExecutor(second);
    queue.setOnline(true);
    await expect(pending).resolves.toMatchObject({ value: 'second' });
    expect(first).not.toHaveBeenCalled();
  });

  it('does not retry after expiration', async () => {
    let now = 0;
    const queue = new OfflineMutationQueue({ clock: () => now, maxAgeMs: 1_000, maxAttempts: 3 });
    queue.setExecutor(async () => { now = 20; throw new Error('fail'); });
    queue.setOnline(true);
    const result = await queue.enqueue(mutation('a', { createdAt: 0, expiresAt: 10 }));
    expect(result).toMatchObject({ state: 'expired', attempts: 1 });
  });

  it('tracks accepted, succeeded and failed counters separately', async () => {
    const queue = new OfflineMutationQueue({ maxAttempts: 1 });
    queue.setExecutor(async (_payload, context) => {
      if (context.id === 'bad') throw new Error('bad');
      return true;
    });
    queue.setOnline(true);
    await Promise.all([queue.enqueue(mutation('good')), queue.enqueue(mutation('bad'))]);
    expect(queue.snapshot()).toMatchObject({ totalAccepted: 2, totalSucceeded: 1, totalFailed: 1 });
  });

  it('removes completed work from pending state', async () => {
    const queue = new OfflineMutationQueue();
    queue.setExecutor(async () => true);
    queue.setOnline(true);
    await queue.enqueue(mutation('a'));
    expect(queue.pending()).toEqual([]);
    expect(queue.snapshot()).toMatchObject({ queued: 0, running: 0 });
  });

  it('records bounded reasons without serializing payloads', async () => {
    const queue = new OfflineMutationQueue({ maxAttempts: 1 });
    queue.setExecutor(async () => { throw new Error('server unavailable'); });
    queue.setOnline(true);
    await queue.enqueue(mutation('a', { payload: { token: 'do-not-log' } }));
    const serialized = JSON.stringify(queue.history());
    expect(serialized).toContain('"reason":"Error"');
    expect(serialized).not.toContain('server unavailable');
    expect(serialized).not.toContain('do-not-log');
  });

  it('keeps id zero-like strings valid', async () => {
    const queue = new OfflineMutationQueue();
    const pending = queue.enqueue(mutation('0'));
    queue.setExecutor(async () => true);
    queue.setOnline(true);
    await expect(pending).resolves.toMatchObject({ id: '0', state: 'succeeded' });
  });

  it('fails closed when custom byte estimator returns invalid values', async () => {
    const queue = new OfflineMutationQueue({ estimateBytes: () => Number.NaN });
    await expect(queue.enqueue(mutation('a'))).rejects.toMatchObject({ reason: 'payload-budget' });
  });
});
