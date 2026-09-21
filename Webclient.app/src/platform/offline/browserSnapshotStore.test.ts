import { describe, expect, it, vi } from 'vitest';
import { BrowserSnapshotStore, type KeyValueStoragePort } from './browserSnapshotStore';

const memoryStorage = (): KeyValueStoragePort & { data: Map<string, string> } => {
  const data = new Map<string, string>();
  return { data, getItem: key => data.get(key) ?? null, setItem: (key, value) => { data.set(key, value); }, removeItem: key => { data.delete(key); } };
};

describe('BrowserSnapshotStore', () => {
  it('uses a namespaced default key', () => {
    expect(new BrowserSnapshotStore().key).toBe('kent-rehberi:offline-mutations:v1');
  });

  it('normalizes a custom key', () => {
    expect(new BrowserSnapshotStore({ key: '  offline:v2  ' }).key).toBe('offline:v2');
  });

  it.each(['', '   ', 'x\u0000y', 'x\u001fy'])('rejects unsafe key %j', key => {
    expect(() => new BrowserSnapshotStore({ key })).toThrow(TypeError);
  });

  it('rejects excessively long keys', () => {
    expect(() => new BrowserSnapshotStore({ key: 'x'.repeat(161) })).toThrow(TypeError);
  });

  it.each([0, 1023, 8 * 1024 * 1024 + 1, 1.5])('rejects invalid byte budget %s', maxBytes => {
    expect(() => new BrowserSnapshotStore({ maxBytes })).toThrow(RangeError);
  });

  it('reports unavailable storage without touching browser globals', async () => {
    const store = new BrowserSnapshotStore();
    await expect(store.read()).resolves.toBeNull();
    expect(store.snapshot()).toEqual({ available: false, reads: 0, writes: 0, removes: 0, failures: 0 });
  });

  it('reads injected storage', async () => {
    const storage = memoryStorage();
    storage.data.set('key', 'value');
    const store = new BrowserSnapshotStore({ key: 'key', storage });
    await expect(store.read()).resolves.toBe('value');
    expect(store.snapshot().reads).toBe(1);
  });

  it('writes injected storage', async () => {
    const storage = memoryStorage();
    const store = new BrowserSnapshotStore({ key: 'key', storage });
    await store.write('value');
    expect(storage.data.get('key')).toBe('value');
    expect(store.snapshot().writes).toBe(1);
  });

  it('removes injected storage', async () => {
    const storage = memoryStorage();
    storage.data.set('key', 'value');
    const store = new BrowserSnapshotStore({ key: 'key', storage });
    await store.remove();
    expect(storage.data.has('key')).toBe(false);
    expect(store.snapshot().removes).toBe(1);
  });

  it('fails closed on oversized reads', async () => {
    const storage = memoryStorage();
    storage.data.set('key', 'x'.repeat(1025));
    const store = new BrowserSnapshotStore({ key: 'key', maxBytes: 1024, storage });
    await expect(store.read()).resolves.toBeNull();
    expect(store.snapshot()).toMatchObject({ reads: 1, failures: 1, lastFailure: 'budget' });
  });

  it('rejects oversized writes before touching storage', async () => {
    const storage = memoryStorage();
    const setItem = vi.spyOn(storage, 'setItem');
    const store = new BrowserSnapshotStore({ key: 'key', maxBytes: 1024, storage });
    await expect(store.write('x'.repeat(1025))).rejects.toThrow(RangeError);
    expect(setItem).not.toHaveBeenCalled();
    expect(store.snapshot()).toMatchObject({ failures: 1, lastFailure: 'budget' });
  });

  it('counts UTF-8 bytes rather than UTF-16 code units', async () => {
    const storage = memoryStorage();
    const store = new BrowserSnapshotStore({ key: 'key', maxBytes: 1024, storage });
    await expect(store.write('😀'.repeat(257))).rejects.toThrow(RangeError);
  });

  it('maps read exceptions to null without leaking details', async () => {
    const storage: KeyValueStoragePort = { getItem: () => { throw new Error('private detail'); }, setItem: () => undefined, removeItem: () => undefined };
    const store = new BrowserSnapshotStore({ storage });
    await expect(store.read()).resolves.toBeNull();
    expect(store.snapshot()).toMatchObject({ failures: 1, lastFailure: 'read' });
  });

  it('wraps write failures', async () => {
    const storage: KeyValueStoragePort = { getItem: () => null, setItem: () => { throw new Error('quota'); }, removeItem: () => undefined };
    const store = new BrowserSnapshotStore({ storage });
    await expect(store.write('value')).rejects.toThrow('snapshot storage write failed');
    expect(store.snapshot()).toMatchObject({ failures: 1, lastFailure: 'write' });
  });

  it('wraps remove failures', async () => {
    const storage: KeyValueStoragePort = { getItem: () => null, setItem: () => undefined, removeItem: () => { throw new Error('blocked'); } };
    const store = new BrowserSnapshotStore({ storage });
    await expect(store.remove()).rejects.toThrow('snapshot storage remove failed');
    expect(store.snapshot()).toMatchObject({ failures: 1, lastFailure: 'remove' });
  });

  it('rejects write when storage is unavailable', async () => {
    await expect(new BrowserSnapshotStore().write('value')).rejects.toThrow(/unavailable/);
  });

  it('treats remove without storage as an idempotent no-op', async () => {
    const store = new BrowserSnapshotStore();
    await expect(store.remove()).resolves.toBeUndefined();
    expect(store.snapshot().removes).toBe(0);
  });

  it('honors cancellation before read', async () => {
    const controller = new AbortController();
    controller.abort('cancelled');
    await expect(new BrowserSnapshotStore({ storage: memoryStorage() }).read(controller.signal)).rejects.toBe('cancelled');
  });

  it('honors cancellation before write', async () => {
    const controller = new AbortController();
    controller.abort('cancelled');
    await expect(new BrowserSnapshotStore({ storage: memoryStorage() }).write('value', controller.signal)).rejects.toBe('cancelled');
  });

  it('honors cancellation before remove', async () => {
    const controller = new AbortController();
    controller.abort('cancelled');
    await expect(new BrowserSnapshotStore({ storage: memoryStorage() }).remove(controller.signal)).rejects.toBe('cancelled');
  });

  it('returns frozen diagnostics', () => {
    expect(Object.isFrozen(new BrowserSnapshotStore().snapshot())).toBe(true);
  });
});
