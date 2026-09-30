import { describe, expect, it, vi } from 'vitest';
import { EXPERIENCE_STORAGE_KEY, type StorageLike } from '../../experience/experienceRuntime';
import { createMapModePreferenceModel } from './mapModePreferenceModel';

const createStorage = (initial: string | null = null): StorageLike & { values: Map<string, string> } => {
  const values = new Map<string, string>();
  if (initial !== null) values.set(EXPERIENCE_STORAGE_KEY, initial);
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
  };
};

describe('MapModePreferenceModel', () => {
  it('starts with a deterministic 2B preference', () => {
    const model = createMapModePreferenceModel();
    expect(model.getSnapshot()).toMatchObject({
      revision: 0,
      phase: 'idle',
      preferredMode: '2d',
      runtimeMode: null,
      restoreTarget: null,
      restoreAttempted: false,
    });
  });

  it('hydrates a persisted 3B preference', () => {
    const storage = createStorage(JSON.stringify({ lastMapMode: '3d' }));
    const model = createMapModePreferenceModel();
    model.hydrate(storage);
    expect(model.getSnapshot()).toMatchObject({ phase: 'idle', preferredMode: '3d' });
  });

  it('normalizes an invalid persisted mode to 2B', () => {
    const storage = createStorage(JSON.stringify({ lastMapMode: '7d' }));
    const model = createMapModePreferenceModel();
    model.hydrate(storage);
    expect(model.getSnapshot().preferredMode).toBe('2d');
  });

  it('reports unavailable storage without throwing', () => {
    const model = createMapModePreferenceModel();
    expect(() => model.hydrate(null)).not.toThrow();
    expect(model.getSnapshot().phase).toBe('storage-unavailable');
  });

  it('requests one 3B restore when runtime first becomes ready in 2B', () => {
    const storage = createStorage(JSON.stringify({ lastMapMode: '3d' }));
    const model = createMapModePreferenceModel();
    model.hydrate(storage);
    const restore = model.observeRuntimeMode('2d', 'map-runtime-ready', storage);
    expect(restore).toBe('3d');
    expect(model.getSnapshot()).toMatchObject({
      phase: 'restore-pending',
      restoreTarget: '3d',
      restoreAttempted: true,
      runtimeMode: '2d',
    });
    expect(model.getDiagnostics().restoreRequestCount).toBe(1);
  });

  it('does not loop restore requests on repeated runtime-ready events', () => {
    const storage = createStorage(JSON.stringify({ lastMapMode: '3d' }));
    const model = createMapModePreferenceModel();
    model.hydrate(storage);
    expect(model.observeRuntimeMode('2d', 'map-runtime-ready', storage)).toBe('3d');
    expect(model.observeRuntimeMode('2d', 'map-runtime-ready', storage)).toBeNull();
    expect(model.getDiagnostics().restoreRequestCount).toBe(1);
  });

  it('does not synthesize restore when runtime already matches preference', () => {
    const storage = createStorage(JSON.stringify({ lastMapMode: '2d' }));
    const model = createMapModePreferenceModel();
    model.hydrate(storage);
    expect(model.observeRuntimeMode('2d', 'map-runtime-ready', storage)).toBeNull();
    expect(model.getSnapshot()).toMatchObject({ phase: 'synchronized', runtimeMode: '2d' });
  });

  it('persists a successful user-visible 3B mode event', () => {
    const storage = createStorage();
    const model = createMapModePreferenceModel();
    model.hydrate(storage);
    model.observeRuntimeMode('3d', 'map-runtime', storage);
    const serialized = storage.values.get(EXPERIENCE_STORAGE_KEY) ?? '';
    expect(JSON.parse(serialized)).toMatchObject({ lastMapMode: '3d' });
    expect(model.getSnapshot()).toMatchObject({ phase: 'synchronized', preferredMode: '3d', runtimeMode: '3d' });
  });

  it('persists a later 2B mode event', () => {
    const storage = createStorage(JSON.stringify({ lastMapMode: '3d' }));
    const model = createMapModePreferenceModel();
    model.hydrate(storage);
    model.observeRuntimeMode('2d', 'map-runtime', storage);
    expect(JSON.parse(storage.values.get(EXPERIENCE_STORAGE_KEY) ?? '{}').lastMapMode).toBe('2d');
  });

  it('deduplicates repeated synchronized writes', () => {
    const storage = createStorage();
    const setItem = vi.spyOn(storage, 'setItem');
    const model = createMapModePreferenceModel();
    model.hydrate(storage);
    model.observeRuntimeMode('2d', 'map-runtime', storage);
    model.observeRuntimeMode('2d', 'map-runtime', storage);
    expect(setItem).toHaveBeenCalledTimes(1);
    expect(model.getDiagnostics().duplicateWriteCount).toBe(1);
  });

  it('keeps in-memory preference when storage becomes unavailable', () => {
    const model = createMapModePreferenceModel();
    model.hydrate(null);
    model.observeRuntimeMode('3d', 'map-runtime', null);
    expect(model.getSnapshot()).toMatchObject({
      phase: 'storage-unavailable', preferredMode: '3d', runtimeMode: '3d',
    });
  });

  it('contains storage write failures', () => {
    const storage: StorageLike = {
      getItem: () => null,
      setItem: () => { throw new DOMException('quota', 'QuotaExceededError'); },
    };
    const model = createMapModePreferenceModel();
    model.hydrate(storage);
    expect(() => model.observeRuntimeMode('3d', 'map-runtime', storage)).not.toThrow();
    expect(model.getSnapshot()).toMatchObject({ phase: 'write-failed', writeFailureCount: 1, preferredMode: '3d' });
  });

  it('contains storage read failures', () => {
    const storage: StorageLike = {
      getItem: () => { throw new DOMException('blocked', 'SecurityError'); },
      setItem: () => undefined,
    };
    const model = createMapModePreferenceModel();
    expect(() => model.hydrate(storage)).not.toThrow();
    expect(model.getSnapshot()).toMatchObject({ phase: 'storage-unavailable', readFailureCount: 1, preferredMode: '2d' });
  });

  it('allows the one-shot restore guard to be reset explicitly', () => {
    const storage = createStorage(JSON.stringify({ lastMapMode: '3d' }));
    const model = createMapModePreferenceModel();
    model.hydrate(storage);
    model.observeRuntimeMode('2d', 'map-runtime-ready', storage);
    model.resetRestoreGuard();
    expect(model.getSnapshot()).toMatchObject({ restoreAttempted: false, restoreTarget: null });
    expect(model.observeRuntimeMode('2d', 'map-runtime-ready', storage)).toBe('3d');
  });

  it('supports marking a restore request from an external preference event', () => {
    const model = createMapModePreferenceModel();
    model.markRestoreRequested('3d');
    expect(model.getSnapshot()).toMatchObject({ phase: 'restore-pending', restoreTarget: '3d', restoreAttempted: true });
  });

  it('notifies listeners on hydration and runtime sync', () => {
    const model = createMapModePreferenceModel();
    const listener = vi.fn();
    model.subscribe(listener);
    const storage = createStorage();
    model.hydrate(storage);
    model.observeRuntimeMode('3d', 'map-runtime', storage);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('isolates listener failures', () => {
    const model = createMapModePreferenceModel();
    const healthy = vi.fn();
    model.subscribe(() => { throw new TypeError('listener failed'); });
    model.subscribe(healthy);
    model.hydrate(createStorage());
    expect(healthy).toHaveBeenCalledTimes(1);
    expect(model.getDiagnostics().listenerFailureCount).toBe(1);
  });

  it('bounds listeners', () => {
    const model = createMapModePreferenceModel({ maxListeners: 1 });
    model.subscribe(vi.fn());
    model.subscribe(vi.fn());
    expect(model.getDiagnostics()).toMatchObject({ listenerCount: 1, rejectedListenerCount: 1 });
  });

  it('unsubscribes idempotently', () => {
    const model = createMapModePreferenceModel();
    const unsubscribe = model.subscribe(vi.fn());
    unsubscribe();
    unsubscribe();
    expect(model.getDiagnostics().listenerCount).toBe(0);
  });

  it('keeps snapshots immutable', () => {
    const model = createMapModePreferenceModel();
    expect(Object.isFrozen(model.getSnapshot())).toBe(true);
    expect(Object.isFrozen(model.getDiagnostics())).toBe(true);
  });

  it('disposes safely and rejects future subscriptions', () => {
    const model = createMapModePreferenceModel();
    model.dispose();
    model.subscribe(vi.fn());
    expect(model.getDiagnostics()).toMatchObject({ disposed: true, rejectedListenerCount: 1 });
    expect(model.observeRuntimeMode('3d', 'map-runtime', createStorage())).toBeNull();
  });
});
