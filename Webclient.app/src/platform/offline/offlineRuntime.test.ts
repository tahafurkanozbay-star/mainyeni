import { describe, expect, it, vi } from 'vitest';
import { ConnectivityPolicy } from './connectivityPolicy';
import { OfflineMutationQueue } from './offlineMutationQueue';
import { OfflinePersistenceCoordinator, type OfflinePersistenceStore } from './offlinePersistence';
import { OfflineRuntime } from './offlineRuntime';
import { OfflineSnapshotCodec, type OfflineSnapshotMutation } from './offlineSnapshot';

const now = 10_000;
const mutation = (id = 'm-1'): OfflineSnapshotMutation => ({ id, owner: 'owner', operation: 'save', payload: { id }, priority: 'interactive', createdAt: 9000, expiresAt: 11000, maxAttempts: 2 });

const createStore = (initial: string | null = null) => {
  let value = initial;
  const store: OfflinePersistenceStore = {
    read: vi.fn(async () => value),
    write: vi.fn(async next => { value = next; }),
    remove: vi.fn(async () => { value = null; }),
  };
  return { store, value: () => value };
};

const fixture = (initial: readonly OfflineSnapshotMutation[] = []) => {
  const codec = new OfflineSnapshotCodec({ clock: () => now });
  const memory = createStore(initial.length ? codec.encode(initial, now) : null);
  const persistence = new OfflinePersistenceCoordinator({ store: memory.store, codec, clock: () => now, saveDebounceMs: 60_000 });
  const queue = new OfflineMutationQueue({ clock: () => now, maxAgeMs: 10_000 });
  const connectivity = new ConnectivityPolicy({ clock: () => now, recoverySuccessThreshold: 1, offlineFailureThreshold: 1 });
  const executor = vi.fn(async (payload: unknown) => payload);
  const runtime = new OfflineRuntime({ queue, persistence, connectivity, executor, clock: () => now, persistDebounceMs: 0 });
  return { runtime, queue, persistence, connectivity, executor, memory, codec };
};

describe('OfflineRuntime', () => {
  it('starts from idle and becomes ready', async () => {
    const { runtime } = fixture();
    expect(runtime.snapshot().state).toBe('idle');
    await runtime.start();
    expect(runtime.snapshot()).toMatchObject({ state: 'ready', restored: 0, pending: 0 });
  });

  it('coalesces concurrent starts', async () => {
    const { runtime, memory } = fixture();
    await Promise.all([runtime.start(), runtime.start(), runtime.start()]);
    expect(memory.store.read).toHaveBeenCalledTimes(1);
  });

  it('restores durable pending mutations while keeping replay offline initially', async () => {
    const { runtime, queue, executor } = fixture([mutation()]);
    await runtime.start();
    expect(runtime.snapshot()).toMatchObject({ restored: 1, pending: 1, running: 0 });
    expect(queue.pending().map(value => value.id)).toEqual(['m-1']);
    expect(executor).not.toHaveBeenCalled();
  });

  it('replays restored work after positive connectivity evidence', async () => {
    const { runtime, executor } = fixture([mutation()]);
    await runtime.start();
    runtime.observeConnectivity({ kind: 'probe-success', at: now, latencyMs: 20 });
    await vi.waitFor(() => expect(executor).toHaveBeenCalledTimes(1));
  });

  it('executes newly enqueued work when online', async () => {
    const { runtime, executor } = fixture();
    await runtime.start();
    runtime.observeConnectivity({ kind: 'probe-success', at: now, latencyMs: 10 });
    await expect(runtime.enqueue(mutation())).resolves.toMatchObject({ state: 'succeeded' });
    expect(executor).toHaveBeenCalledTimes(1);
    expect(runtime.snapshot()).toMatchObject({ accepted: 1, completed: 1 });
  });

  it('keeps newly enqueued work pending while offline', async () => {
    const { runtime, executor } = fixture();
    await runtime.start();
    runtime.observeConnectivity({ kind: 'probe-failure', at: now, reason: 'network' });
    const pending = runtime.enqueue(mutation());
    expect(runtime.snapshot().pending).toBe(1);
    expect(executor).not.toHaveBeenCalled();
    await runtime.stop();
    await expect(pending).resolves.toMatchObject({ state: 'cancelled' });
  });

  it('persists queue capture after enqueue', async () => {
    const { runtime, persistence } = fixture();
    await runtime.start();
    runtime.enqueue(mutation());
    expect(persistence.mutations().map(value => value.id)).toEqual(['m-1']);
    await runtime.stop();
  });

  it('flush persists pending queue state', async () => {
    const { runtime, memory, codec } = fixture();
    await runtime.start();
    runtime.enqueue(mutation());
    await runtime.flush();
    expect(memory.store.write).toHaveBeenCalled();
    expect(codec.decode(memory.value()!, now).snapshot.mutations.map(value => value.id)).toEqual(['m-1']);
    await runtime.stop();
  });

  it('records connectivity transitions without signal payloads', async () => {
    const { runtime } = fixture();
    await runtime.start();
    runtime.observeConnectivity({ kind: 'probe-failure', at: now, reason: 'private upstream detail' });
    const event = runtime.history().find(value => value.type === 'connectivity');
    expect(event?.detail).toBe('offline');
    expect(JSON.stringify(runtime.history())).not.toContain('private upstream detail');
  });

  it('rejects enqueue before start', () => {
    expect(() => fixture().runtime.enqueue(mutation())).toThrow(/not ready/);
  });

  it('rejects connectivity observation after stop', async () => {
    const { runtime } = fixture();
    await runtime.start();
    await runtime.stop();
    expect(() => runtime.observeConnectivity({ kind: 'probe-success' })).toThrow(/stopped/);
  });

  it('cannot restart after stop', async () => {
    const { runtime } = fixture();
    await runtime.start();
    await runtime.stop();
    await expect(runtime.start()).rejects.toThrow(/cannot restart/);
  });

  it('stop is idempotent', async () => {
    const { runtime } = fixture();
    await runtime.start();
    await runtime.stop();
    await expect(runtime.stop()).resolves.toBeUndefined();
    expect(runtime.snapshot().state).toBe('stopped');
  });

  it('stop disposes queue and persistence ownership', async () => {
    const { runtime, queue, persistence } = fixture();
    await runtime.start();
    await runtime.stop();
    expect(queue.snapshot().disposed).toBe(true);
    expect(persistence.snapshot().state).toBe('disposed');
  });

  it('stop with flush writes pending state before disposal', async () => {
    const { runtime, memory } = fixture();
    await runtime.start();
    runtime.enqueue(mutation());
    await runtime.stop({ flush: true });
    expect(memory.store.write).toHaveBeenCalledTimes(1);
  });

  it('records bounded stop reason', async () => {
    const { runtime } = fixture();
    await runtime.start();
    await runtime.stop({ reason: 'x'.repeat(200) });
    expect(runtime.history().find(value => value.type === 'stop')?.detail).toHaveLength(96);
  });

  it('bounds runtime event history', async () => {
    const base = fixture();
    const runtime = new OfflineRuntime({ queue: base.queue, persistence: base.persistence, connectivity: base.connectivity, executor: base.executor, clock: () => now, historyLimit: 2, persistDebounceMs: 0 });
    await runtime.start();
    runtime.observeConnectivity({ kind: 'probe-success', at: now });
    await runtime.stop();
    expect(runtime.history()).toHaveLength(2);
  });

  it('supports disabled runtime history', async () => {
    const base = fixture();
    const runtime = new OfflineRuntime({ queue: base.queue, persistence: base.persistence, connectivity: base.connectivity, executor: base.executor, clock: () => now, historyLimit: 0 });
    await runtime.start();
    expect(runtime.history()).toEqual([]);
    await runtime.stop();
  });

  it('returns immutable snapshots and history entries', async () => {
    const { runtime } = fixture();
    await runtime.start();
    expect(Object.isFrozen(runtime.snapshot())).toBe(true);
    expect(runtime.history().every(Object.isFrozen)).toBe(true);
    await runtime.stop();
  });

  it('surfaces persistence load failure as failed runtime state', async () => {
    const base = fixture();
    const store: OfflinePersistenceStore = { read: async () => { throw new Error('disk'); }, write: async () => undefined, remove: async () => undefined };
    const persistence = new OfflinePersistenceCoordinator({ store, codec: base.codec, clock: () => now });
    const runtime = new OfflineRuntime({ queue: base.queue, persistence, connectivity: base.connectivity, executor: base.executor, clock: () => now });
    await expect(runtime.start()).rejects.toThrow();
    expect(runtime.snapshot().state).toBe('failed');
  });

  it('requires all lifecycle dependencies', () => {
    const base = fixture();
    expect(() => new OfflineRuntime({ queue: undefined as never, persistence: base.persistence, connectivity: base.connectivity, executor: base.executor })).toThrow(TypeError);
  });

  it('validates runtime budgets', () => {
    const base = fixture();
    expect(() => new OfflineRuntime({ queue: base.queue, persistence: base.persistence, connectivity: base.connectivity, executor: base.executor, historyLimit: -1 })).toThrow(RangeError);
    expect(() => new OfflineRuntime({ queue: base.queue, persistence: base.persistence, connectivity: base.connectivity, executor: base.executor, persistDebounceMs: -1 })).toThrow(RangeError);
  });
});
