import { describe, expect, it, vi } from 'vitest';
import { OfflinePersistenceCoordinator, OfflinePersistenceError, type OfflinePersistenceStore } from './offlinePersistence';
import { OfflineSnapshotCodec, type OfflineSnapshotMutation } from './offlineSnapshot';

const now = 10_000;
const item = (id = 'm-1'): OfflineSnapshotMutation => ({ id, owner: 'owner', operation: 'save', payload: { id }, priority: 'interactive', createdAt: 9000, expiresAt: 11000, maxAttempts: 2 });

const memoryStore = (initial: string | null = null) => {
  let value = initial;
  const store: OfflinePersistenceStore = {
    read: vi.fn(async signal => { if (signal.aborted) throw signal.reason; return value; }),
    write: vi.fn(async (next, signal) => { if (signal.aborted) throw signal.reason; value = next; }),
    remove: vi.fn(async signal => { if (signal.aborted) throw signal.reason; value = null; }),
  };
  return { store, read: () => value };
};

const coordinator = (store: OfflinePersistenceStore, options: Partial<ConstructorParameters<typeof OfflinePersistenceCoordinator>[0]> = {}) =>
  new OfflinePersistenceCoordinator({ store, codec: new OfflineSnapshotCodec({ clock: () => now }), clock: () => now, saveDebounceMs: 0, ...options });

describe('OfflinePersistenceCoordinator', () => {
  it('loads an empty store into ready state', async () => {
    const memory = memoryStore();
    const persistence = coordinator(memory.store);
    await expect(persistence.load()).resolves.toEqual([]);
    expect(persistence.snapshot()).toMatchObject({ state: 'ready', revision: 1, persistedRevision: 1, pendingSave: false, lastLoadedAt: now });
  });

  it('loads and clones a valid snapshot', async () => {
    const codec = new OfflineSnapshotCodec({ clock: () => now });
    const memory = memoryStore(codec.encode([item()], now));
    const persistence = coordinator(memory.store);
    await expect(persistence.load()).resolves.toEqual([item()]);
    expect(Object.isFrozen(persistence.mutations())).toBe(true);
    expect(Object.isFrozen(persistence.mutations()[0])).toBe(true);
  });

  it('replaces mutations through codec validation', () => {
    const persistence = coordinator(memoryStore().store, { saveDebounceMs: 1000 });
    expect(persistence.replace([item()])).toBe(1);
    expect(persistence.mutations()).toEqual([item()]);
    expect(persistence.snapshot()).toMatchObject({ state: 'ready', revision: 1, pendingSave: true });
    persistence.dispose();
  });

  it('flushes pending state to the store', async () => {
    const memory = memoryStore();
    const persistence = coordinator(memory.store, { saveDebounceMs: 1000 });
    persistence.replace([item()]);
    await persistence.flush();
    expect(memory.store.write).toHaveBeenCalledTimes(1);
    expect(new OfflineSnapshotCodec().decode(memory.read()!, now).snapshot.mutations).toEqual([item()]);
    expect(persistence.snapshot()).toMatchObject({ persistedRevision: 1, pendingSave: false, lastSavedAt: now });
  });

  it('does not rewrite an already persisted revision', async () => {
    const memory = memoryStore();
    const persistence = coordinator(memory.store, { saveDebounceMs: 1000 });
    persistence.replace([item()]);
    await persistence.flush();
    await persistence.flush();
    expect(memory.store.write).toHaveBeenCalledTimes(1);
  });

  it('clear removes durable and in-memory state', async () => {
    const memory = memoryStore();
    const persistence = coordinator(memory.store, { saveDebounceMs: 1000 });
    persistence.replace([item()]);
    await persistence.clear();
    expect(persistence.mutations()).toEqual([]);
    expect(memory.store.remove).toHaveBeenCalledTimes(1);
    expect(persistence.snapshot().pendingSave).toBe(false);
  });

  it('drain persists a pending debounced revision', async () => {
    const memory = memoryStore();
    const persistence = coordinator(memory.store, { saveDebounceMs: 60_000 });
    persistence.replace([item()]);
    await persistence.drain();
    expect(memory.store.write).toHaveBeenCalledTimes(1);
    expect(persistence.snapshot().pendingSave).toBe(false);
  });

  it('serializes concurrent flushes', async () => {
    const releases: Array<() => void> = [];
    const writes: string[] = [];
    const store: OfflinePersistenceStore = {
      read: async () => null,
      write: vi.fn(async value => { writes.push(value); await new Promise<void>(resolve => releases.push(resolve)); }),
      remove: async () => undefined,
    };
    const persistence = coordinator(store, { saveDebounceMs: 60_000 });
    persistence.replace([item('a')]);
    const first = persistence.flush();
    await Promise.resolve();
    persistence.replace([item('b')]);
    const second = persistence.flush();
    await Promise.resolve();
    expect(store.write).toHaveBeenCalledTimes(1);
    releases.shift()?.();
    await first;
    await Promise.resolve();
    expect(store.write).toHaveBeenCalledTimes(2);
    releases.shift()?.();
    await second;
    expect(writes).toHaveLength(2);
  });

  it('preserves newer in-memory revision when an older load completes', async () => {
    let release!: (value: string | null) => void;
    const store: OfflinePersistenceStore = {
      read: () => new Promise(resolve => { release = resolve; }), write: async () => undefined, remove: async () => undefined,
    };
    const persistence = coordinator(store, { saveDebounceMs: 60_000 });
    const loading = persistence.load();
    await Promise.resolve();
    persistence.replace([item('newer')]);
    release(new OfflineSnapshotCodec().encode([item('older')], now));
    await loading;
    expect(persistence.mutations().map(value => value.id)).toEqual(['newer']);
    persistence.dispose();
  });

  it('maps read failures to typed errors', async () => {
    const store: OfflinePersistenceStore = { read: async () => { throw new Error('secret detail'); }, write: async () => undefined, remove: async () => undefined };
    const persistence = coordinator(store);
    await expect(persistence.load()).rejects.toMatchObject({ name: 'OfflinePersistenceError', kind: 'read' });
    expect(persistence.snapshot()).toMatchObject({ state: 'failed', consecutiveFailures: 1, lastFailureAt: now });
  });

  it('maps write failures to typed errors', async () => {
    const store: OfflinePersistenceStore = { read: async () => null, write: async () => { throw new Error('disk'); }, remove: async () => undefined };
    const persistence = coordinator(store, { saveDebounceMs: 60_000 });
    persistence.replace([item()]);
    await expect(persistence.flush()).rejects.toMatchObject({ kind: 'write' });
  });

  it('maps remove failures to typed errors', async () => {
    const store: OfflinePersistenceStore = { read: async () => null, write: async () => undefined, remove: async () => { throw new Error('disk'); } };
    await expect(coordinator(store).clear()).rejects.toMatchObject({ kind: 'remove' });
  });

  it('resets failure count after a successful operation', async () => {
    let fail = true;
    const store: OfflinePersistenceStore = { read: async () => { if (fail) throw new Error('once'); return null; }, write: async () => undefined, remove: async () => undefined };
    const persistence = coordinator(store);
    await expect(persistence.load()).rejects.toBeInstanceOf(OfflinePersistenceError);
    fail = false;
    await persistence.load();
    expect(persistence.snapshot().consecutiveFailures).toBe(0);
  });

  it('disposes deterministically and aborts lifetime signal', async () => {
    let signal: AbortSignal | undefined;
    const store: OfflinePersistenceStore = { read: async current => { signal = current; return null; }, write: async () => undefined, remove: async () => undefined };
    const persistence = coordinator(store);
    await persistence.load();
    persistence.dispose();
    expect(signal?.aborted).toBe(true);
    expect(persistence.snapshot().state).toBe('disposed');
  });

  it.each(['load', 'replace', 'flush', 'clear'] as const)('rejects %s after dispose', async operation => {
    const persistence = coordinator(memoryStore().store);
    persistence.dispose();
    if (operation === 'load') await expect(persistence.load()).rejects.toMatchObject({ kind: 'disposed' });
    if (operation === 'replace') expect(() => persistence.replace([item()])).toThrow(OfflinePersistenceError);
    if (operation === 'flush') await expect(persistence.flush()).rejects.toMatchObject({ kind: 'disposed' });
    if (operation === 'clear') await expect(persistence.clear()).rejects.toMatchObject({ kind: 'disposed' });
  });

  it('allows drain after dispose as a no-op', async () => {
    const persistence = coordinator(memoryStore().store);
    persistence.dispose();
    await expect(persistence.drain()).resolves.toBeUndefined();
  });

  it('bounds event history', async () => {
    const persistence = coordinator(memoryStore().store, { historyLimit: 2 });
    await persistence.load();
    persistence.replace([item()]);
    await persistence.flush();
    expect(persistence.history()).toHaveLength(2);
  });

  it('supports disabled history', async () => {
    const persistence = coordinator(memoryStore().store, { historyLimit: 0 });
    await persistence.load();
    expect(persistence.history()).toEqual([]);
  });

  it('records save lifecycle without persisted payload data', async () => {
    const persistence = coordinator(memoryStore().store, { saveDebounceMs: 60_000 });
    persistence.replace([item()]);
    await persistence.flush();
    expect(persistence.history().map(event => event.type)).toEqual(['save-scheduled', 'save-started', 'save-completed']);
    expect(JSON.stringify(persistence.history())).not.toContain('owner');
  });

  it('validates constructor budgets', () => {
    const store = memoryStore().store;
    expect(() => coordinator(store, { historyLimit: -1 })).toThrow(RangeError);
    expect(() => coordinator(store, { saveDebounceMs: -1 })).toThrow(RangeError);
    expect(() => coordinator(store, { maxConsecutiveFailures: 0 })).toThrow(RangeError);
  });

  it('requires store and codec dependencies', () => {
    expect(() => new OfflinePersistenceCoordinator({ store: undefined as never, codec: new OfflineSnapshotCodec() })).toThrow(TypeError);
  });
});
