import { describe, expect, it, vi } from 'vitest';
import { createSidebarPreferenceStore, type SidebarStorageLike } from './sidebarPreferenceStore';

const VALID_IDS = ['park', 'library', 'bus', 'metro', 'water'] as const;

class MemoryStorage implements SidebarStorageLike {
  readonly values = new Map<string, string>();
  readonly getItem = vi.fn((key: string): string | null => this.values.get(key) ?? null);
  readonly setItem = vi.fn((key: string, value: string): void => {
    this.values.set(key, value);
  });
  readonly removeItem = vi.fn((key: string): void => {
    this.values.delete(key);
  });
}

describe('createSidebarPreferenceStore', () => {
  it('returns empty immutable preferences when storage is unavailable', () => {
    const store = createSidebarPreferenceStore({ validItemIds: VALID_IDS, storage: null });
    const snapshot = store.load();
    expect(snapshot).toEqual({ favoriteIds: [], recentIds: [], storageAvailable: false });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.favoriteIds)).toBe(true);
    expect(Object.isFrozen(snapshot.recentIds)).toBe(true);
  });

  it('loads legacy array payloads', () => {
    const storage = new MemoryStorage();
    storage.values.set('kentrehberi:service-favorites', JSON.stringify(['park', 'bus']));
    storage.values.set('kentrehberi:service-recents', JSON.stringify(['metro', 'library']));
    const store = createSidebarPreferenceStore({ validItemIds: VALID_IDS, storage });
    expect(store.load()).toMatchObject({
      favoriteIds: ['park', 'bus'],
      recentIds: ['metro', 'library'],
      storageAvailable: true,
    });
  });

  it('accepts versioned object payloads for forward-compatible reads', () => {
    const storage = new MemoryStorage();
    storage.values.set('kentrehberi:service-favorites', JSON.stringify({ version: 1, ids: ['park', 'bus'] }));
    const store = createSidebarPreferenceStore({ validItemIds: VALID_IDS, storage });
    expect(store.load().favoriteIds).toEqual(['park', 'bus']);
  });

  it('rejects unknown and duplicate ids during reads', () => {
    const storage = new MemoryStorage();
    storage.values.set('kentrehberi:service-favorites', JSON.stringify(['park', 'missing', 'park', 'bus']));
    const store = createSidebarPreferenceStore({ validItemIds: VALID_IDS, storage });
    expect(store.load().favoriteIds).toEqual(['park', 'bus']);
  });

  it('bounds loaded favorites and recents independently', () => {
    const storage = new MemoryStorage();
    storage.values.set('kentrehberi:service-favorites', JSON.stringify(VALID_IDS));
    storage.values.set('kentrehberi:service-recents', JSON.stringify(VALID_IDS));
    const store = createSidebarPreferenceStore({
      validItemIds: VALID_IDS,
      storage,
      maxFavoriteIds: 3,
      maxRecentIds: 2,
    });
    const snapshot = store.load();
    expect(snapshot.favoriteIds).toEqual(['park', 'library', 'bus']);
    expect(snapshot.recentIds).toEqual(['park', 'library']);
  });

  it('writes sanitized favorites', () => {
    const storage = new MemoryStorage();
    const store = createSidebarPreferenceStore({ validItemIds: VALID_IDS, storage });
    expect(store.saveFavorites(['park', 'missing', 'park', 'bus'])).toBe(true);
    expect(storage.values.get('kentrehberi:service-favorites')).toBe(JSON.stringify(['park', 'bus']));
  });

  it('writes sanitized recents with configured bounds', () => {
    const storage = new MemoryStorage();
    const store = createSidebarPreferenceStore({ validItemIds: VALID_IDS, storage, maxRecentIds: 2 });
    expect(store.saveRecents(['metro', 'bus', 'park'])).toBe(true);
    expect(storage.values.get('kentrehberi:service-recents')).toBe(JSON.stringify(['metro', 'bus']));
  });

  it('uses caller-provided storage keys', () => {
    const storage = new MemoryStorage();
    const store = createSidebarPreferenceStore({
      validItemIds: VALID_IDS,
      storage,
      favoritesKey: 'custom:favorites',
      recentsKey: 'custom:recents',
    });
    store.saveFavorites(['park']);
    store.saveRecents(['bus']);
    expect(storage.values.get('custom:favorites')).toBe('["park"]');
    expect(storage.values.get('custom:recents')).toBe('["bus"]');
  });

  it('rejects identical favorite and recent storage keys', () => {
    expect(() => createSidebarPreferenceStore({
      validItemIds: VALID_IDS,
      favoritesKey: 'same',
      recentsKey: 'same',
    })).toThrow(/distinct storage keys/u);
  });

  it('rejects duplicate valid item ids', () => {
    expect(() => createSidebarPreferenceStore({
      validItemIds: ['park', 'park'],
    })).toThrow(/Duplicate sidebar preference item id/u);
  });

  it('rejects empty valid item ids', () => {
    expect(() => createSidebarPreferenceStore({ validItemIds: ['park', ' '] })).toThrow(/cannot be empty/u);
  });

  it('rejects oversized valid ids', () => {
    expect(() => createSidebarPreferenceStore({ validItemIds: ['x'.repeat(161)] })).toThrow(RangeError);
  });

  it('rejects oversized storage keys', () => {
    expect(() => createSidebarPreferenceStore({
      validItemIds: VALID_IDS,
      favoritesKey: 'x'.repeat(161),
    })).toThrow(RangeError);
  });

  it('records malformed JSON as a bounded read diagnostic', () => {
    const storage = new MemoryStorage();
    storage.values.set('kentrehberi:service-favorites', '{bad-json');
    const store = createSidebarPreferenceStore({ validItemIds: VALID_IDS, storage });
    expect(store.load().favoriteIds).toEqual([]);
    expect(store.getDiagnostics()).toEqual({
      readFailureCount: 1,
      writeFailureCount: 0,
      lastFailureOperation: 'read-favorites',
      lastFailureKind: 'SyntaxError',
    });
  });

  it('does not retain raw storage error messages in diagnostics', () => {
    const storage: SidebarStorageLike = {
      getItem: () => { throw new Error('sensitive storage detail'); },
      setItem: () => undefined,
    };
    const store = createSidebarPreferenceStore({ validItemIds: VALID_IDS, storage });
    store.load();
    expect(JSON.stringify(store.getDiagnostics())).not.toContain('sensitive storage detail');
    expect(store.getDiagnostics().lastFailureKind).toBe('Error');
  });

  it('records independent failures for favorites and recents reads', () => {
    const storage: SidebarStorageLike = {
      getItem: () => { throw new TypeError('blocked'); },
      setItem: () => undefined,
    };
    const store = createSidebarPreferenceStore({ validItemIds: VALID_IDS, storage });
    store.load();
    expect(store.getDiagnostics()).toMatchObject({
      readFailureCount: 2,
      lastFailureOperation: 'read-recents',
      lastFailureKind: 'TypeError',
    });
  });

  it('records storage write failures and returns false', () => {
    const storage: SidebarStorageLike = {
      getItem: () => null,
      setItem: () => { throw new DOMException('blocked', 'QuotaExceededError'); },
    };
    const store = createSidebarPreferenceStore({ validItemIds: VALID_IDS, storage });
    expect(store.saveFavorites(['park'])).toBe(false);
    expect(store.getDiagnostics()).toMatchObject({
      readFailureCount: 0,
      writeFailureCount: 1,
      lastFailureOperation: 'write-favorites',
      lastFailureKind: 'QuotaExceededError',
    });
  });

  it('records independent write failures without throwing into the UI', () => {
    const storage: SidebarStorageLike = {
      getItem: () => null,
      setItem: () => { throw new TypeError('storage unavailable'); },
    };
    const store = createSidebarPreferenceStore({ validItemIds: VALID_IDS, storage });
    expect(() => store.saveFavorites(['park'])).not.toThrow();
    expect(() => store.saveRecents(['bus'])).not.toThrow();
    expect(store.getDiagnostics().writeFailureCount).toBe(2);
    expect(store.getDiagnostics().lastFailureOperation).toBe('write-recents');
  });

  it('fails bounded when a serialized read payload exceeds the byte budget', () => {
    const storage = new MemoryStorage();
    storage.values.set('kentrehberi:service-favorites', JSON.stringify(['park', 'library', 'bus']));
    const store = createSidebarPreferenceStore({
      validItemIds: VALID_IDS,
      storage,
      maxSerializedBytes: 8,
    });
    expect(store.load().favoriteIds).toEqual([]);
    expect(store.getDiagnostics()).toMatchObject({
      readFailureCount: 1,
      lastFailureOperation: 'read-favorites',
      lastFailureKind: 'RangeError',
    });
  });

  it('fails bounded before storage when a serialized write exceeds the byte budget', () => {
    const storage = new MemoryStorage();
    const store = createSidebarPreferenceStore({
      validItemIds: VALID_IDS,
      storage,
      maxSerializedBytes: 8,
    });
    expect(store.saveFavorites(['park', 'library'])).toBe(false);
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(store.getDiagnostics()).toMatchObject({
      writeFailureCount: 1,
      lastFailureOperation: 'write-favorites',
      lastFailureKind: 'RangeError',
    });
  });

  it('clears favorites using removeItem when available', () => {
    const storage = new MemoryStorage();
    storage.values.set('kentrehberi:service-favorites', '["park"]');
    const store = createSidebarPreferenceStore({ validItemIds: VALID_IDS, storage });
    expect(store.clearFavorites()).toBe(true);
    expect(storage.removeItem).toHaveBeenCalledWith('kentrehberi:service-favorites');
    expect(storage.values.has('kentrehberi:service-favorites')).toBe(false);
  });

  it('clears recents using removeItem when available', () => {
    const storage = new MemoryStorage();
    storage.values.set('kentrehberi:service-recents', '["bus"]');
    const store = createSidebarPreferenceStore({ validItemIds: VALID_IDS, storage });
    expect(store.clearRecents()).toBe(true);
    expect(storage.removeItem).toHaveBeenCalledWith('kentrehberi:service-recents');
    expect(storage.values.has('kentrehberi:service-recents')).toBe(false);
  });

  it('falls back to writing an empty list when removeItem is unavailable', () => {
    const values = new Map<string, string>();
    const storage: SidebarStorageLike = {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => { values.set(key, value); },
    };
    const store = createSidebarPreferenceStore({ validItemIds: VALID_IDS, storage });
    store.saveFavorites(['park']);
    expect(store.clearFavorites()).toBe(true);
    expect(values.get('kentrehberi:service-favorites')).toBe('[]');
  });

  it('records remove failures as write diagnostics', () => {
    const storage: SidebarStorageLike = {
      getItem: () => null,
      setItem: () => undefined,
      removeItem: () => { throw new Error('remove blocked'); },
    };
    const store = createSidebarPreferenceStore({ validItemIds: VALID_IDS, storage });
    expect(store.clearFavorites()).toBe(false);
    expect(store.getDiagnostics()).toMatchObject({
      writeFailureCount: 1,
      lastFailureOperation: 'remove-favorites',
      lastFailureKind: 'Error',
    });
  });

  it('sanitizes favorite ids without touching storage', () => {
    const storage = new MemoryStorage();
    const store = createSidebarPreferenceStore({ validItemIds: VALID_IDS, storage, maxFavoriteIds: 2 });
    expect(store.sanitizeFavoriteIds(['park', 'missing', 'bus', 'metro'])).toEqual(['park', 'bus']);
    expect(storage.getItem).not.toHaveBeenCalled();
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it('sanitizes recent ids without touching storage', () => {
    const storage = new MemoryStorage();
    const store = createSidebarPreferenceStore({ validItemIds: VALID_IDS, storage, maxRecentIds: 2 });
    expect(store.sanitizeRecentIds(['metro', 'metro', 'bus', 'park'])).toEqual(['metro', 'bus']);
    expect(storage.getItem).not.toHaveBeenCalled();
  });

  it('freezes diagnostics snapshots', () => {
    const store = createSidebarPreferenceStore({ validItemIds: VALID_IDS });
    expect(Object.isFrozen(store.getDiagnostics())).toBe(true);
  });

  it('does not mutate caller arrays', () => {
    const source = ['park', 'bus', 'park'];
    const store = createSidebarPreferenceStore({ validItemIds: VALID_IDS });
    store.sanitizeFavoriteIds(source);
    expect(source).toEqual(['park', 'bus', 'park']);
  });
});
