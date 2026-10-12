import type { BookmarkRecord } from '../_shared/MapWidgetRuntime';

export type BookmarkViewMode = 'grid' | 'list';
export type BookmarkMove = 'next' | 'previous' | 'first' | 'last' | 'page-next' | 'page-previous';
export type BookmarkEmptyReason = 'none' | 'no-bookmarks' | 'no-results';

export interface BookmarkExperienceEntry {
  readonly id: string;
  readonly key: string;
  readonly bookmark: BookmarkRecord;
  readonly position: number;
  readonly setSize: number;
  readonly active: boolean;
  readonly searchableText: string;
}

export interface BookmarkExperienceSnapshot {
  readonly revision: number;
  readonly query: string;
  readonly normalizedQuery: string;
  readonly viewMode: BookmarkViewMode;
  readonly activeId: string | null;
  readonly totalCount: number;
  readonly resultCount: number;
  readonly rejectedCount: number;
  readonly entries: readonly BookmarkExperienceEntry[];
  readonly emptyReason: BookmarkEmptyReason;
  readonly announcement: string;
  readonly storageWarning: string | null;
}

export interface BookmarkObserverDiagnostics {
  readonly failureCount: number;
  readonly activeObserverCount: number;
  readonly rejectedObserverCount: number;
  readonly lastFailureRevision: number | null;
  readonly lastFailureKind: string | null;
  readonly disposed: boolean;
}

export interface BookmarkPresentationFacts {
  readonly minimumPointerTargetPx: 44;
  readonly coarsePointerTargetPx: 48;
  readonly supportsReducedMotion: true;
  readonly supportsForcedColors: true;
  readonly keyboardModel: 'roving-active-descendant';
}

export interface BookmarkExperienceModelOptions {
  readonly maxQueryLength?: number;
  readonly maxObservers?: number;
  readonly pageSize?: number;
}

type Listener = () => void;

const DEFAULT_MAX_QUERY_LENGTH = 80;
const MAX_QUERY_LENGTH = 160;
const DEFAULT_MAX_OBSERVERS = 32;
const MAX_OBSERVERS = 128;
const DEFAULT_PAGE_SIZE = 6;
const MAX_PAGE_SIZE = 24;
const MAX_BOOKMARKS = 100;

const TURKISH_ASCII_REPLACEMENTS: Readonly<Record<string, string>> = Object.freeze({
  ı: 'i',
  İ: 'i',
  ş: 's',
  Ş: 's',
  ğ: 'g',
  Ğ: 'g',
  ü: 'u',
  Ü: 'u',
  ö: 'o',
  Ö: 'o',
  ç: 'c',
  Ç: 'c',
});

const clampInteger = (value: number | undefined, fallback: number, min: number, max: number): number => {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(value ?? fallback)));
};

export const normalizeBookmarkSearchText = (value: string): string => {
  const replaced = Array.from(value, (character) => TURKISH_ASCII_REPLACEMENTS[character] ?? character).join('');
  return replaced
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/gu, '')
    .toLocaleLowerCase('tr-TR')
    .replace(/[^a-z0-9\s.-]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
};

const stableHash = (value: string): string => {
  let hash = 0x811c9dc5;
  for (const character of value) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
};

export const bookmarkIdentity = (bookmark: BookmarkRecord): string => (
  `${bookmark.Title}\u001f${bookmark.Lat.toFixed(6)}\u001f${bookmark.Lng.toFixed(6)}\u001f${bookmark.Zoom.toFixed(3)}`
);

export const bookmarkDomId = (bookmark: BookmarkRecord): string => (
  `bookmark-option-${stableHash(bookmarkIdentity(bookmark))}`
);

const buildSearchText = (bookmark: BookmarkRecord): string => normalizeBookmarkSearchText(
  `${bookmark.Title} ${bookmark.Lat.toFixed(4)} ${bookmark.Lng.toFixed(4)} ${bookmark.Zoom.toFixed(1)}`,
);

const createAnnouncement = (
  totalCount: number,
  resultCount: number,
  query: string,
): string => {
  if (totalCount === 0) return 'Henüz kayıtlı yer işareti yok.';
  if (resultCount === 0) return 'Aramayla eşleşen yer işareti bulunamadı.';
  const resultText = query
    ? `${resultCount} yer işareti bulundu.`
    : `${totalCount} yer işareti kayıtlı.`;
  return resultText;
};

const createStorageWarning = (rejectedCount: number): string | null => (
  rejectedCount > 0
    ? `${rejectedCount} geçersiz veya yinelenen yer işareti güvenli biçimde atlandı.`
    : null
);

interface IndexedBookmark {
  readonly bookmark: BookmarkRecord;
  readonly key: string;
  readonly id: string;
  readonly searchableText: string;
}

const indexBookmarks = (bookmarks: readonly BookmarkRecord[]): readonly IndexedBookmark[] => Object.freeze(
  bookmarks.slice(0, MAX_BOOKMARKS).map((bookmark) => Object.freeze({
    bookmark,
    key: bookmarkIdentity(bookmark),
    id: bookmarkDomId(bookmark),
    searchableText: buildSearchText(bookmark),
  })),
);

const createSnapshot = (
  revision: number,
  indexed: readonly IndexedBookmark[],
  query: string,
  viewMode: BookmarkViewMode,
  activeId: string | null,
  rejectedCount: number,
): BookmarkExperienceSnapshot => {
  const normalizedQuery = normalizeBookmarkSearchText(query);
  const filtered = normalizedQuery
    ? indexed.filter((item) => item.searchableText.includes(normalizedQuery))
    : indexed;
  const nextActiveId = filtered.some((item) => item.id === activeId)
    ? activeId
    : filtered[0]?.id ?? null;
  const entries = Object.freeze(filtered.map((item, index) => Object.freeze({
    id: item.id,
    key: item.key,
    bookmark: item.bookmark,
    position: index + 1,
    setSize: filtered.length,
    active: item.id === nextActiveId,
    searchableText: item.searchableText,
  })));
  const emptyReason: BookmarkEmptyReason = indexed.length === 0
    ? 'no-bookmarks'
    : filtered.length === 0
      ? 'no-results'
      : 'none';

  return Object.freeze({
    revision,
    query,
    normalizedQuery,
    viewMode,
    activeId: nextActiveId,
    totalCount: indexed.length,
    resultCount: filtered.length,
    rejectedCount,
    entries,
    emptyReason,
    announcement: createAnnouncement(indexed.length, filtered.length, normalizedQuery),
    storageWarning: createStorageWarning(rejectedCount),
  });
};

const classifyObserverFailure = (error: unknown): string => {
  if (error instanceof Error) return error.name || 'Error';
  if (error === null) return 'null';
  return typeof error;
};

export const BOOKMARK_PRESENTATION_FACTS: BookmarkPresentationFacts = Object.freeze({
  minimumPointerTargetPx: 44,
  coarsePointerTargetPx: 48,
  supportsReducedMotion: true,
  supportsForcedColors: true,
  keyboardModel: 'roving-active-descendant',
});

export class BookmarkExperienceModel {
  readonly #listeners = new Set<Listener>();
  readonly #maxQueryLength: number;
  readonly #maxObservers: number;
  readonly #pageSize: number;
  #indexed: readonly IndexedBookmark[] = Object.freeze([]);
  #snapshot: BookmarkExperienceSnapshot;
  #diagnostics: BookmarkObserverDiagnostics;
  #disposed = false;

  constructor(options: BookmarkExperienceModelOptions = {}) {
    this.#maxQueryLength = clampInteger(options.maxQueryLength, DEFAULT_MAX_QUERY_LENGTH, 1, MAX_QUERY_LENGTH);
    this.#maxObservers = clampInteger(options.maxObservers, DEFAULT_MAX_OBSERVERS, 1, MAX_OBSERVERS);
    this.#pageSize = clampInteger(options.pageSize, DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE);
    this.#snapshot = createSnapshot(0, this.#indexed, '', 'grid', null, 0);
    this.#diagnostics = Object.freeze({
      failureCount: 0,
      activeObserverCount: 0,
      rejectedObserverCount: 0,
      lastFailureRevision: null,
      lastFailureKind: null,
      disposed: false,
    });
  }

  readonly getSnapshot = (): BookmarkExperienceSnapshot => this.#snapshot;
  readonly getObserverDiagnostics = (): BookmarkObserverDiagnostics => this.#diagnostics;

  readonly subscribe = (listener: Listener): (() => void) => {
    if (this.#disposed) {
      this.#recordRejectedObserver();
      return () => undefined;
    }
    if (this.#listeners.has(listener)) return () => this.#unsubscribe(listener);
    if (this.#listeners.size >= this.#maxObservers) {
      this.#recordRejectedObserver();
      return () => undefined;
    }
    this.#listeners.add(listener);
    this.#refreshObserverCount();
    return () => this.#unsubscribe(listener);
  };

  setBookmarks(bookmarks: readonly BookmarkRecord[], rejectedCount = 0): void {
    if (this.#disposed) return;
    this.#indexed = indexBookmarks(bookmarks);
    this.#publish(createSnapshot(
      this.#snapshot.revision + 1,
      this.#indexed,
      this.#snapshot.query,
      this.#snapshot.viewMode,
      this.#snapshot.activeId,
      Math.max(0, Math.trunc(rejectedCount)),
    ));
  }

  setQuery(value: string): void {
    if (this.#disposed) return;
    const query = value.slice(0, this.#maxQueryLength);
    if (query === this.#snapshot.query) return;
    this.#publish(createSnapshot(
      this.#snapshot.revision + 1,
      this.#indexed,
      query,
      this.#snapshot.viewMode,
      this.#snapshot.activeId,
      this.#snapshot.rejectedCount,
    ));
  }

  setViewMode(viewMode: BookmarkViewMode): void {
    if (this.#disposed || viewMode === this.#snapshot.viewMode) return;
    if (viewMode !== 'grid' && viewMode !== 'list') return;
    this.#publish(createSnapshot(
      this.#snapshot.revision + 1,
      this.#indexed,
      this.#snapshot.query,
      viewMode,
      this.#snapshot.activeId,
      this.#snapshot.rejectedCount,
    ));
  }

  setActive(id: string): void {
    if (this.#disposed || id === this.#snapshot.activeId) return;
    if (!this.#snapshot.entries.some((entry) => entry.id === id)) return;
    this.#publish(createSnapshot(
      this.#snapshot.revision + 1,
      this.#indexed,
      this.#snapshot.query,
      this.#snapshot.viewMode,
      id,
      this.#snapshot.rejectedCount,
    ));
  }

  moveActive(move: BookmarkMove): void {
    if (this.#disposed || this.#snapshot.entries.length === 0) return;
    const entries = this.#snapshot.entries;
    const currentIndex = Math.max(0, entries.findIndex((entry) => entry.id === this.#snapshot.activeId));
    let nextIndex = currentIndex;
    switch (move) {
      case 'next': nextIndex = (currentIndex + 1) % entries.length; break;
      case 'previous': nextIndex = (currentIndex - 1 + entries.length) % entries.length; break;
      case 'first': nextIndex = 0; break;
      case 'last': nextIndex = entries.length - 1; break;
      case 'page-next': nextIndex = Math.min(entries.length - 1, currentIndex + this.#pageSize); break;
      case 'page-previous': nextIndex = Math.max(0, currentIndex - this.#pageSize); break;
    }
    this.setActive(entries[nextIndex]?.id ?? entries[0]?.id ?? '');
  }

  resetInteraction(): void {
    if (this.#disposed) return;
    this.#publish(createSnapshot(
      this.#snapshot.revision + 1,
      this.#indexed,
      '',
      this.#snapshot.viewMode,
      null,
      this.#snapshot.rejectedCount,
    ));
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#listeners.clear();
    this.#diagnostics = Object.freeze({
      ...this.#diagnostics,
      activeObserverCount: 0,
      disposed: true,
    });
  }

  disposed(): boolean {
    return this.#disposed;
  }

  #publish(next: BookmarkExperienceSnapshot): void {
    if (this.#disposed || next === this.#snapshot) return;
    this.#snapshot = next;
    for (const listener of this.#listeners) {
      try {
        listener();
      } catch (error) {
        this.#diagnostics = Object.freeze({
          ...this.#diagnostics,
          failureCount: this.#diagnostics.failureCount + 1,
          lastFailureRevision: next.revision,
          lastFailureKind: classifyObserverFailure(error),
        });
      }
    }
  }

  #unsubscribe(listener: Listener): void {
    if (!this.#listeners.delete(listener)) return;
    this.#refreshObserverCount();
  }

  #refreshObserverCount(): void {
    this.#diagnostics = Object.freeze({
      ...this.#diagnostics,
      activeObserverCount: this.#listeners.size,
    });
  }

  #recordRejectedObserver(): void {
    this.#diagnostics = Object.freeze({
      ...this.#diagnostics,
      rejectedObserverCount: this.#diagnostics.rejectedObserverCount + 1,
    });
  }
}

export const createBookmarkExperienceModel = (
  options: BookmarkExperienceModelOptions = {},
): BookmarkExperienceModel => new BookmarkExperienceModel(options);
