export interface SidebarStorageLike {
  readonly getItem: (key: string) => string | null;
  readonly setItem: (key: string, value: string) => void;
  readonly removeItem?: (key: string) => void;
}

export interface SidebarPreferenceStoreOptions {
  readonly storage?: SidebarStorageLike | null;
  readonly validItemIds: readonly string[];
  readonly favoritesKey?: string;
  readonly recentsKey?: string;
  readonly maxFavoriteIds?: number;
  readonly maxRecentIds?: number;
  readonly maxSerializedBytes?: number;
}

export interface SidebarPreferenceSnapshot {
  readonly favoriteIds: readonly string[];
  readonly recentIds: readonly string[];
  readonly storageAvailable: boolean;
}

export type SidebarPreferenceOperation =
  | 'read-favorites'
  | 'read-recents'
  | 'write-favorites'
  | 'write-recents'
  | 'remove-favorites'
  | 'remove-recents';

export interface SidebarPreferenceDiagnostics {
  readonly readFailureCount: number;
  readonly writeFailureCount: number;
  readonly lastFailureOperation: SidebarPreferenceOperation | null;
  readonly lastFailureKind: string | null;
}

export interface SidebarPreferenceStore {
  readonly load: () => SidebarPreferenceSnapshot;
  readonly saveFavorites: (ids: readonly string[]) => boolean;
  readonly saveRecents: (ids: readonly string[]) => boolean;
  readonly clearFavorites: () => boolean;
  readonly clearRecents: () => boolean;
  readonly sanitizeFavoriteIds: (ids: readonly string[]) => readonly string[];
  readonly sanitizeRecentIds: (ids: readonly string[]) => readonly string[];
  readonly getDiagnostics: () => SidebarPreferenceDiagnostics;
}

const DEFAULT_FAVORITES_KEY = 'kentrehberi:service-favorites';
const DEFAULT_RECENTS_KEY = 'kentrehberi:service-recents';
const DEFAULT_MAX_FAVORITES = 128;
const DEFAULT_MAX_RECENTS = 12;
const DEFAULT_MAX_SERIALIZED_BYTES = 16 * 1024;

const clampPositiveInteger = (value: number | undefined, fallback: number, maximum: number): number => {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(1, Math.trunc(value)));
};

const normalizeKey = (value: string | undefined, fallback: string): string => {
  const normalized = value?.trim() ?? '';
  if (!normalized) return fallback;
  if (normalized.length > 160) throw new RangeError('Sidebar preference storage key exceeds 160 characters.');
  return normalized;
};

const classifyFailure = (error: unknown): string => {
  if (error instanceof Error) return error.name || 'Error';
  if (error === null) return 'null';
  return typeof error;
};

const freezeIds = (ids: readonly string[]): readonly string[] => Object.freeze([...ids]);

const serializedByteLength = (value: string): number => {
  if (typeof TextEncoder === 'function') return new TextEncoder().encode(value).byteLength;
  return value.length * 2;
};

const parseStoredIds = (value: string | null): readonly unknown[] => {
  if (value === null || value.trim() === '') return Object.freeze([]);
  const parsed: unknown = JSON.parse(value);
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === 'object' && 'ids' in parsed) {
    const ids = (parsed as { readonly ids?: unknown }).ids;
    return Array.isArray(ids) ? ids : Object.freeze([]);
  }
  return Object.freeze([]);
};

export const createSidebarPreferenceStore = (
  options: SidebarPreferenceStoreOptions,
): SidebarPreferenceStore => {
  if (!options || !Array.isArray(options.validItemIds)) {
    throw new TypeError('Sidebar preference store requires valid item ids.');
  }

  const validIds = new Set<string>();
  for (const value of options.validItemIds) {
    if (typeof value !== 'string') throw new TypeError('Sidebar preference item ids must be strings.');
    const id = value.trim();
    if (!id) throw new TypeError('Sidebar preference item id cannot be empty.');
    if (id.length > 160) throw new RangeError('Sidebar preference item id exceeds 160 characters.');
    if (validIds.has(id)) throw new Error(`Duplicate sidebar preference item id: ${id}`);
    validIds.add(id);
  }

  const storage = options.storage ?? null;
  const favoritesKey = normalizeKey(options.favoritesKey, DEFAULT_FAVORITES_KEY);
  const recentsKey = normalizeKey(options.recentsKey, DEFAULT_RECENTS_KEY);
  if (favoritesKey === recentsKey) throw new Error('Sidebar favorites and recents must use distinct storage keys.');

  const maxFavoriteIds = clampPositiveInteger(options.maxFavoriteIds, DEFAULT_MAX_FAVORITES, 512);
  const maxRecentIds = clampPositiveInteger(options.maxRecentIds, DEFAULT_MAX_RECENTS, 64);
  const maxSerializedBytes = clampPositiveInteger(
    options.maxSerializedBytes,
    DEFAULT_MAX_SERIALIZED_BYTES,
    128 * 1024,
  );

  let diagnostics: SidebarPreferenceDiagnostics = Object.freeze({
    readFailureCount: 0,
    writeFailureCount: 0,
    lastFailureOperation: null,
    lastFailureKind: null,
  });

  const recordReadFailure = (operation: SidebarPreferenceOperation, error: unknown): void => {
    diagnostics = Object.freeze({
      readFailureCount: diagnostics.readFailureCount + 1,
      writeFailureCount: diagnostics.writeFailureCount,
      lastFailureOperation: operation,
      lastFailureKind: classifyFailure(error),
    });
  };

  const recordWriteFailure = (operation: SidebarPreferenceOperation, error: unknown): void => {
    diagnostics = Object.freeze({
      readFailureCount: diagnostics.readFailureCount,
      writeFailureCount: diagnostics.writeFailureCount + 1,
      lastFailureOperation: operation,
      lastFailureKind: classifyFailure(error),
    });
  };

  const sanitizeIds = (ids: readonly string[], maximum: number): readonly string[] => {
    if (!Array.isArray(ids)) throw new TypeError('Sidebar preference ids must be an array.');
    const sanitized: string[] = [];
    const seen = new Set<string>();
    for (const value of ids) {
      if (typeof value !== 'string') continue;
      const id = value.trim();
      if (!validIds.has(id) || seen.has(id)) continue;
      seen.add(id);
      sanitized.push(id);
      if (sanitized.length >= maximum) break;
    }
    return freezeIds(sanitized);
  };

  const sanitizeFavoriteIds = (ids: readonly string[]): readonly string[] => sanitizeIds(ids, maxFavoriteIds);
  const sanitizeRecentIds = (ids: readonly string[]): readonly string[] => sanitizeIds(ids, maxRecentIds);

  const read = (
    key: string,
    maximum: number,
    operation: SidebarPreferenceOperation,
  ): readonly string[] => {
    if (storage === null) return freezeIds([]);
    try {
      const raw = storage.getItem(key);
      if (raw !== null && serializedByteLength(raw) > maxSerializedBytes) {
        throw new RangeError('Stored sidebar preference payload exceeds the configured byte budget.');
      }
      return sanitizeIds(parseStoredIds(raw).filter((value): value is string => typeof value === 'string'), maximum);
    } catch (error) {
      recordReadFailure(operation, error);
      return freezeIds([]);
    }
  };

  const write = (
    key: string,
    ids: readonly string[],
    maximum: number,
    operation: SidebarPreferenceOperation,
  ): boolean => {
    if (storage === null) return false;
    const sanitized = sanitizeIds(ids, maximum);
    const serialized = JSON.stringify(sanitized);
    if (serializedByteLength(serialized) > maxSerializedBytes) {
      recordWriteFailure(operation, new RangeError('Sidebar preference payload exceeds the configured byte budget.'));
      return false;
    }
    try {
      storage.setItem(key, serialized);
      return true;
    } catch (error) {
      recordWriteFailure(operation, error);
      return false;
    }
  };

  const remove = (key: string, operation: SidebarPreferenceOperation): boolean => {
    if (storage === null) return false;
    if (typeof storage.removeItem !== 'function') {
      return write(key, [], operation === 'remove-favorites' ? maxFavoriteIds : maxRecentIds, operation);
    }
    try {
      storage.removeItem(key);
      return true;
    } catch (error) {
      recordWriteFailure(operation, error);
      return false;
    }
  };

  const load = (): SidebarPreferenceSnapshot => Object.freeze({
    favoriteIds: read(favoritesKey, maxFavoriteIds, 'read-favorites'),
    recentIds: read(recentsKey, maxRecentIds, 'read-recents'),
    storageAvailable: storage !== null,
  });

  const saveFavorites = (ids: readonly string[]): boolean =>
    write(favoritesKey, ids, maxFavoriteIds, 'write-favorites');

  const saveRecents = (ids: readonly string[]): boolean =>
    write(recentsKey, ids, maxRecentIds, 'write-recents');

  const clearFavorites = (): boolean => remove(favoritesKey, 'remove-favorites');
  const clearRecents = (): boolean => remove(recentsKey, 'remove-recents');
  const getDiagnostics = (): SidebarPreferenceDiagnostics => diagnostics;

  return Object.freeze({
    load,
    saveFavorites,
    saveRecents,
    clearFavorites,
    clearRecents,
    sanitizeFavoriteIds,
    sanitizeRecentIds,
    getDiagnostics,
  });
};
