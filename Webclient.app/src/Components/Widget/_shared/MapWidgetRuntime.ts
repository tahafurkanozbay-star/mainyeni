import type { KeyboardEvent as ReactKeyboardEvent } from 'react';

export const DEFAULT_WIDGET_OPERATION_TIMEOUT_MS = 15_000;
export const MAX_WIDGET_OPERATION_TIMEOUT_MS = 60_000;
export const MAX_WIDGET_ERROR_MESSAGE_LENGTH = 240;
export const MAX_IDENTIFY_ATTRIBUTE_COUNT = 80;
export const MAX_BOOKMARK_COUNT = 100;

export interface DisposableLike {
  dispose?: () => void;
  destroy?: () => void;
  remove?: () => void;
  abort?: (reason?: unknown) => void;
}

export interface MapPointLike {
  readonly x?: unknown;
  readonly y?: unknown;
  readonly latitude?: unknown;
  readonly longitude?: unknown;
  readonly spatialReference?: unknown;
}

export interface NormalizedMapPoint {
  readonly latitude: number;
  readonly longitude: number;
}

export interface ContextMenuViewport {
  readonly width: number;
  readonly height: number;
  readonly safeInsetTop?: number;
  readonly safeInsetRight?: number;
  readonly safeInsetBottom?: number;
  readonly safeInsetLeft?: number;
}

export interface ContextMenuSize {
  readonly width: number;
  readonly height: number;
}

export interface ContextMenuPosition {
  readonly x: number;
  readonly y: number;
}

export interface BookmarkRecord {
  readonly Title: string;
  readonly Lat: number;
  readonly Lng: number;
  readonly Zoom: number;
}

export interface BookmarkValidationResult {
  readonly bookmarks: readonly BookmarkRecord[];
  readonly rejected: number;
}

export type WidgetOperationPhase = 'idle' | 'running' | 'success' | 'error' | 'cancelled';

export interface WidgetOperationSnapshot {
  readonly generation: number;
  readonly phase: WidgetOperationPhase;
  readonly startedAt: number | null;
  readonly completedAt: number | null;
  readonly error: string | null;
}

export interface LatestOperationContext {
  readonly generation: number;
  readonly signal: AbortSignal;
  readonly startedAt: number;
  readonly isCurrent: () => boolean;
}

export interface LatestOperationGate {
  readonly snapshot: () => WidgetOperationSnapshot;
  readonly run: <T>(
    operation: (context: LatestOperationContext) => Promise<T> | T,
    options?: Readonly<{ timeoutMs?: number }>,
  ) => Promise<T>;
  readonly cancel: (reason?: string) => void;
  readonly dispose: () => void;
}

export interface ResourceBag {
  readonly add: <T extends DisposableLike | (() => void) | null | undefined>(resource: T) => T;
  readonly delete: (resource: DisposableLike | (() => void) | null | undefined) => void;
  readonly dispose: () => void;
  readonly size: () => number;
  readonly disposed: () => boolean;
}

export interface SafeRecordEntry {
  readonly key: string;
  readonly value: string;
}

export interface RovingMenuState {
  readonly activeIndex: number;
  readonly itemCount: number;
}

const SECRETISH_KEY = /(authorization|cookie|token|secret|password|session|credential|api[-_]?key)/iu;
const replaceControlCharacters = (value: string): string => (
  Array.from(value, (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f ? ' ' : character;
  }).join('')
);

const finiteNumber = (value: unknown): number | null => {
  const numeric = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(numeric) ? numeric : null;
};

const now = (): number => (
  typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now()
);

export const clamp = (value: number, min: number, max: number): number => (
  Math.min(Math.max(value, min), max)
);

export const normalizeTimeout = (
  timeoutMs: unknown,
  fallback = DEFAULT_WIDGET_OPERATION_TIMEOUT_MS,
): number => {
  const numeric = finiteNumber(timeoutMs);
  if (numeric === null || numeric <= 0) return fallback;
  return clamp(Math.round(numeric), 100, MAX_WIDGET_OPERATION_TIMEOUT_MS);
};

export const normalizeWidgetError = (
  error: unknown,
  fallback = 'İşlem tamamlanamadı. Lütfen tekrar deneyin.',
): string => {
  const raw = error instanceof Error
    ? error.message
    : typeof error === 'string'
      ? error
      : fallback;
  const normalized = raw
    
    .replace(/\s+/gu, ' ')
    .trim();
  if (!normalized) return fallback;
  return normalized.slice(0, MAX_WIDGET_ERROR_MESSAGE_LENGTH);
};

export const isAbortLikeError = (error: unknown): boolean => {
  if (error instanceof DOMException && error.name === 'AbortError') return true;
  if (!(error instanceof Error)) return false;
  const candidate = error as Error & { code?: unknown };
  return error.name === 'AbortError'
    || candidate.code === 'ABORT_ERR'
    || candidate.code === 'CANCELLED'
    || /aborted|cancelled|canceled/iu.test(error.message);
};

export const sanitizeExternalUrl = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    if (trimmed.length > 2048) return null;
    const parsed = new URL(trimmed, window.location.href);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    if (parsed.username || parsed.password) return null;
    return parsed.toString();
  } catch {
    return null;
  }
};

export const openExternalUrl = (
  value: unknown,
  opener: Pick<Window, 'open'> = window,
): boolean => {
  const safeUrl = sanitizeExternalUrl(value);
  if (!safeUrl) return false;
  const opened = opener.open(safeUrl, '_blank', 'noopener,noreferrer');
  if (!opened) return false;
  try {
    opened.opener = null;
  } catch {
    // Browser may expose a restricted proxy. noopener already protects the boundary.
  }
  return true;
};

export const normalizeMapPoint = (point: unknown): NormalizedMapPoint | null => {
  if (!point || typeof point !== 'object' || Array.isArray(point)) return null;
  const candidate = point as MapPointLike;
  const latitude = finiteNumber(candidate.latitude ?? candidate.y);
  const longitude = finiteNumber(candidate.longitude ?? candidate.x);
  if (latitude === null || longitude === null) return null;
  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return null;
  return Object.freeze({ latitude, longitude });
};

export const clampContextMenuPosition = (
  requested: ContextMenuPosition,
  viewport: ContextMenuViewport,
  menu: ContextMenuSize,
  margin = 8,
): ContextMenuPosition => {
  const safeMargin = Math.max(0, finiteNumber(margin) ?? 0);
  const width = Math.max(0, finiteNumber(viewport.width) ?? 0);
  const height = Math.max(0, finiteNumber(viewport.height) ?? 0);
  const menuWidth = Math.max(0, finiteNumber(menu.width) ?? 0);
  const menuHeight = Math.max(0, finiteNumber(menu.height) ?? 0);
  const left = Math.max(0, finiteNumber(viewport.safeInsetLeft) ?? 0);
  const right = Math.max(0, finiteNumber(viewport.safeInsetRight) ?? 0);
  const top = Math.max(0, finiteNumber(viewport.safeInsetTop) ?? 0);
  const bottom = Math.max(0, finiteNumber(viewport.safeInsetBottom) ?? 0);
  const minX = left + safeMargin;
  const minY = top + safeMargin;
  const maxX = Math.max(minX, width - right - menuWidth - safeMargin);
  const maxY = Math.max(minY, height - bottom - menuHeight - safeMargin);
  return Object.freeze({
    x: clamp(finiteNumber(requested.x) ?? minX, minX, maxX),
    y: clamp(finiteNumber(requested.y) ?? minY, minY, maxY),
  });
};

export const sanitizeWidgetLabel = (value: unknown, fallback = 'İsimsiz öğe'): string => {
  if (typeof value !== 'string') return fallback;
  const normalized = replaceControlCharacters(value)
    .replace(/\s+/gu, ' ')
    .trim();
  return normalized ? normalized.slice(0, 120) : fallback;
};

export const safeRecordEntries = (
  value: unknown,
  maxEntries = MAX_IDENTIFY_ATTRIBUTE_COUNT,
): readonly SafeRecordEntry[] => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return Object.freeze([]);
  const limit = clamp(Math.trunc(finiteNumber(maxEntries) ?? MAX_IDENTIFY_ATTRIBUTE_COUNT), 0, 250);
  const entries: SafeRecordEntry[] = [];
  for (const [rawKey, rawValue] of Object.entries(value as Record<string, unknown>)) {
    if (entries.length >= limit) break;
    const key = sanitizeWidgetLabel(rawKey, 'Alan');
    if (SECRETISH_KEY.test(key)) continue;
    let display = '';
    if (rawValue === null || rawValue === undefined) display = '';
    else if (typeof rawValue === 'string') display = rawValue;
    else if (typeof rawValue === 'number' || typeof rawValue === 'boolean' || typeof rawValue === 'bigint') {
      display = String(rawValue);
    } else if (rawValue instanceof Date) display = rawValue.toISOString();
    else {
      try {
        display = JSON.stringify(rawValue);
      } catch {
        display = '[gösterilemiyor]';
      }
    }
    entries.push(Object.freeze({
      key,
      value: replaceControlCharacters(display).slice(0, 500),
    }));
  }
  return Object.freeze(entries);
};

const disposeOne = (resource: DisposableLike | (() => void)): void => {
  if (typeof resource === 'function') {
    resource();
    return;
  }
  if (typeof resource.abort === 'function') {
    resource.abort('widget-disposed');
    return;
  }
  if (typeof resource.remove === 'function') {
    resource.remove();
    return;
  }
  if (typeof resource.dispose === 'function') {
    resource.dispose();
    return;
  }
  resource.destroy?.();
};

export const createResourceBag = (
  onDisposeError?: (error: unknown) => void,
): ResourceBag => {
  const resources = new Set<DisposableLike | (() => void)>();
  let closed = false;

  const add: ResourceBag['add'] = (resource) => {
    if (!resource) return resource;
    if (closed) {
      try {
        disposeOne(resource);
      } catch (error) {
        onDisposeError?.(error);
      }
      return resource;
    }
    resources.add(resource);
    return resource;
  };

  return Object.freeze({
    add,
    delete(resource: DisposableLike | (() => void) | null | undefined) {
      if (resource) resources.delete(resource);
    },
    dispose() {
      if (closed) return;
      closed = true;
      const ordered = [...resources].reverse();
      resources.clear();
      for (const resource of ordered) {
        try {
          disposeOne(resource);
        } catch (error) {
          onDisposeError?.(error);
        }
      }
    },
    size: () => resources.size,
    disposed: () => closed,
  });
};

export const createLatestOperationGate = (
  onState?: (snapshot: WidgetOperationSnapshot) => void,
): LatestOperationGate => {
  let generation = 0;
  let active: AbortController | null = null;
  let disposed = false;
  let state: WidgetOperationSnapshot = Object.freeze({
    generation,
    phase: 'idle',
    startedAt: null,
    completedAt: null,
    error: null,
  });

  const publish = (next: WidgetOperationSnapshot): void => {
    state = Object.freeze(next);
    onState?.(state);
  };

  const cancel = (reason = 'cancelled'): void => {
    generation += 1;
    active?.abort(reason);
    active = null;
    publish({
      generation,
      phase: 'cancelled',
      startedAt: state.startedAt,
      completedAt: now(),
      error: null,
    });
  };

  const run: LatestOperationGate['run'] = async (operation, options = {}) => {
    if (disposed) throw new Error('Widget operation gate has been disposed.');
    generation += 1;
    const currentGeneration = generation;
    active?.abort('superseded');
    const controller = new AbortController();
    active = controller;
    const startedAt = now();
    const timeoutMs = normalizeTimeout(options.timeoutMs);
    const timeout = window.setTimeout(() => controller.abort('timeout'), timeoutMs);
    publish({
      generation: currentGeneration,
      phase: 'running',
      startedAt,
      completedAt: null,
      error: null,
    });

    const context: LatestOperationContext = Object.freeze({
      generation: currentGeneration,
      signal: controller.signal,
      startedAt,
      isCurrent: () => (
        !disposed
        && generation === currentGeneration
        && active === controller
        && !controller.signal.aborted
      ),
    });

    try {
      const operationPromise = Promise.resolve().then(() => operation(context));
      const abortPromise = new Promise<never>((_resolve, reject) => {
        if (controller.signal.aborted) {
          reject(new DOMException('Operation cancelled.', 'AbortError'));
          return;
        }
        controller.signal.addEventListener('abort', () => {
          reject(new DOMException('Operation cancelled.', 'AbortError'));
        }, { once: true });
      });
      const result = await Promise.race([operationPromise, abortPromise]);
      if (!context.isCurrent()) {
        throw new DOMException('Operation superseded or cancelled.', 'AbortError');
      }
      active = null;
      publish({
        generation: currentGeneration,
        phase: 'success',
        startedAt,
        completedAt: now(),
        error: null,
      });
      return result;
    } catch (error) {
      const current = generation === currentGeneration && active === controller;
      if (current) active = null;
      if (controller.signal.aborted || isAbortLikeError(error)) {
        if (current) {
          publish({
            generation: currentGeneration,
            phase: 'cancelled',
            startedAt,
            completedAt: now(),
            error: null,
          });
        }
        throw error;
      }
      if (current) {
        publish({
          generation: currentGeneration,
          phase: 'error',
          startedAt,
          completedAt: now(),
          error: normalizeWidgetError(error),
        });
      }
      throw error;
    } finally {
      window.clearTimeout(timeout);
    }
  };

  return Object.freeze({
    snapshot: () => state,
    run,
    cancel,
    dispose() {
      if (disposed) return;
      disposed = true;
      cancel('disposed');
    },
  });
};

const bookmarkFromUnknown = (value: unknown): BookmarkRecord | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const title = sanitizeWidgetLabel(candidate.Title, '');
  const lat = finiteNumber(candidate.Lat);
  const lng = finiteNumber(candidate.Lng);
  const zoom = finiteNumber(candidate.Zoom);
  if (!title || lat === null || lng === null || zoom === null) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  if (zoom < 0 || zoom > 30) return null;
  return Object.freeze({
    Title: title,
    Lat: lat,
    Lng: lng,
    Zoom: zoom,
  });
};

export const decodeBookmarks = (
  value: unknown,
  maxCount = MAX_BOOKMARK_COUNT,
): BookmarkValidationResult => {
  if (!Array.isArray(value)) return Object.freeze({ bookmarks: Object.freeze([]), rejected: value == null ? 0 : 1 });
  const limit = clamp(Math.trunc(finiteNumber(maxCount) ?? MAX_BOOKMARK_COUNT), 1, MAX_BOOKMARK_COUNT);
  const bookmarks: BookmarkRecord[] = [];
  const seen = new Set<string>();
  let rejected = 0;
  for (const raw of value) {
    const bookmark = bookmarkFromUnknown(raw);
    if (!bookmark) {
      rejected += 1;
      continue;
    }
    const identity = bookmark.Title.toLocaleLowerCase('tr-TR');
    if (seen.has(identity)) {
      rejected += 1;
      continue;
    }
    seen.add(identity);
    if (bookmarks.length < limit) bookmarks.push(bookmark);
    else rejected += 1;
  }
  return Object.freeze({ bookmarks: Object.freeze(bookmarks), rejected });
};

export const createBookmarkRecord = (
  title: unknown,
  center: MapPointLike | null | undefined,
  zoomValue: unknown,
): BookmarkRecord | null => {
  const normalizedTitle = sanitizeWidgetLabel(title, '');
  const point = normalizeMapPoint(center);
  const zoom = finiteNumber(zoomValue);
  if (!normalizedTitle || !point || zoom === null || zoom < 0 || zoom > 30) return null;
  return Object.freeze({
    Title: normalizedTitle,
    Lat: point.latitude,
    Lng: point.longitude,
    Zoom: zoom,
  });
};

export const appendBookmark = (
  current: readonly BookmarkRecord[],
  next: BookmarkRecord,
  maxCount = MAX_BOOKMARK_COUNT,
): readonly BookmarkRecord[] => {
  const identity = next.Title.toLocaleLowerCase('tr-TR');
  if (current.some((item) => item.Title.toLocaleLowerCase('tr-TR') === identity)) return current;
  const limit = clamp(Math.trunc(finiteNumber(maxCount) ?? MAX_BOOKMARK_COUNT), 1, MAX_BOOKMARK_COUNT);
  const merged = [...current, next];
  return Object.freeze(merged.slice(Math.max(0, merged.length - limit)));
};

export const removeBookmarkAt = (
  current: readonly BookmarkRecord[],
  index: number,
): readonly BookmarkRecord[] => (
  Object.freeze(current.filter((_, itemIndex) => itemIndex !== index))
);

export const nextRovingIndex = (
  state: RovingMenuState,
  key: ReactKeyboardEvent['key'] | string,
): number => {
  const count = Math.max(0, Math.trunc(state.itemCount));
  if (count === 0) return -1;
  const current = clamp(Math.trunc(state.activeIndex), 0, count - 1);
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  if (key === 'ArrowDown' || key === 'ArrowRight') return (current + 1) % count;
  if (key === 'ArrowUp' || key === 'ArrowLeft') return (current - 1 + count) % count;
  return current;
};

export const objectIdFromIdentifyResult = (
  result: unknown,
  fallback: string | number,
): string | number => {
  if (!result || typeof result !== 'object') return fallback;
  const candidate = result as {
    attributes?: Record<string, unknown>;
    feature?: { attributes?: Record<string, unknown> };
  };
  const attributes = candidate.attributes ?? candidate.feature?.attributes ?? {};
  const value = attributes.OBJECTID
    ?? attributes.ObjectID
    ?? attributes.objectid
    ?? attributes.FID
    ?? attributes.fid;
  return typeof value === 'string' || typeof value === 'number' ? value : fallback;
};

export const isCompactWidgetViewport = (): boolean => (
  typeof window !== 'undefined'
  && window.matchMedia('(max-width: 767.98px)').matches
);
