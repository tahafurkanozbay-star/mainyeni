import type { NotificationItem, NotificationTone } from './notificationCenterModel';

export type NotificationTriageScope = 'all' | 'unread' | 'important' | 'urgent' | 'actionable';
export type NotificationTriageSort = 'newest' | 'oldest' | 'priority';
export type NotificationTriageMove = 'next' | 'previous' | 'first' | 'last' | 'page-next' | 'page-previous';

export interface NotificationTriageEntry {
  readonly id: string;
  readonly title: string;
  readonly message: string;
  readonly category: string;
  readonly tone: NotificationTone;
  readonly read: boolean;
  readonly important: boolean;
  readonly urgent: boolean;
  readonly dismissible: boolean;
  readonly actionable: boolean;
  readonly createdAt: number;
  readonly occurrenceCount: number;
  readonly position: number;
  readonly setSize: number;
  readonly selected: boolean;
}

export interface NotificationTriageSnapshot {
  readonly revision: number;
  readonly query: string;
  readonly normalizedQuery: string;
  readonly scope: NotificationTriageScope;
  readonly sort: NotificationTriageSort;
  readonly activeId: string | null;
  readonly activeIndex: number;
  readonly entries: readonly NotificationTriageEntry[];
  readonly resultCount: number;
  readonly totalCount: number;
  readonly unreadCount: number;
  readonly importantCount: number;
  readonly urgentCount: number;
  readonly actionableCount: number;
  readonly announcement: string;
  readonly emptyReason: 'none' | 'no-items' | 'query' | 'scope';
}

export interface NotificationTriageDiagnostics {
  readonly activeListenerCount: number;
  readonly rejectedListenerCount: number;
  readonly listenerFailureCount: number;
  readonly reporterFailureCount: number;
  readonly lastFailureRevision: number | null;
  readonly lastFailureKind: string | null;
  readonly disposed: boolean;
}

export interface NotificationTriageModelOptions {
  readonly maxItems?: number;
  readonly maxQueryLength?: number;
  readonly maxListeners?: number;
  readonly pageSize?: number;
  readonly onObserverError?: (error: unknown) => void;
}

interface IndexedItem {
  readonly source: NotificationItem;
  readonly searchText: string;
  readonly important: boolean;
  readonly urgent: boolean;
  readonly actionable: boolean;
}

const DEFAULT_MAX_ITEMS = 96;
const MAX_ITEMS_LIMIT = 200;
const DEFAULT_QUERY_LENGTH = 96;
const MAX_QUERY_LENGTH = 180;
const DEFAULT_MAX_LISTENERS = 24;
const MAX_LISTENERS = 100;
const DEFAULT_PAGE_SIZE = 6;
const MAX_PAGE_SIZE = 20;

const TURKISH_REPLACEMENTS: Readonly<Record<string, string>> = Object.freeze({
  'ı': 'i',
  'İ': 'i',
  'ş': 's',
  'Ş': 's',
  'ğ': 'g',
  'Ğ': 'g',
  'ü': 'u',
  'Ü': 'u',
  'ö': 'o',
  'Ö': 'o',
  'ç': 'c',
  'Ç': 'c',
});

const clampInteger = (value: number | undefined, fallback: number, min: number, max: number): number => {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(value ?? fallback)));
};

const isControlCode = (code: number): boolean => code < 32 || code === 127;

const cleanBoundedText = (value: string, maxLength: number): string => {
  let cleaned = '';
  for (const character of value) {
    const code = character.codePointAt(0);
    cleaned += code !== undefined && isControlCode(code) ? ' ' : character;
  }
  return cleaned.replace(/\s+/gu, ' ').trim().slice(0, maxLength);
};

export const normalizeNotificationTriageText = (value: string): string => {
  const mapped = Array.from(value, (character) => TURKISH_REPLACEMENTS[character] ?? character).join('');
  return mapped
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/gu, '')
    .toLocaleLowerCase('tr-TR')
    .replace(/[^a-z0-9\s+_.:/-]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
};

const classifyFailure = (error: unknown): string => {
  if (error instanceof Error) return cleanBoundedText(error.name || 'Error', 48) || 'Error';
  if (error === null) return 'null';
  return typeof error;
};

const isImportant = (item: NotificationItem): boolean => item.priority === 'urgent' || item.tone === 'error' || item.tone === 'warning';
const isUrgent = (item: NotificationItem): boolean => item.priority === 'urgent' || item.tone === 'error';

const indexItem = (item: NotificationItem): IndexedItem => Object.freeze({
  source: item,
  important: isImportant(item),
  urgent: isUrgent(item),
  actionable: item.actions.length > 0,
  searchText: normalizeNotificationTriageText([
    item.title,
    item.message,
    item.category,
    item.tone,
    item.priority,
    ...item.actions.map((action) => action.label),
  ].join(' ')),
});

const scopeAllows = (item: IndexedItem, scope: NotificationTriageScope): boolean => {
  if (scope === 'unread') return !item.source.read;
  if (scope === 'important') return item.important;
  if (scope === 'urgent') return item.urgent;
  if (scope === 'actionable') return item.actionable;
  return true;
};

const compareNewest = (left: IndexedItem, right: IndexedItem): number => {
  const time = right.source.createdAt - left.source.createdAt;
  if (time !== 0) return time;
  return left.source.id.localeCompare(right.source.id, 'tr');
};

const compareOldest = (left: IndexedItem, right: IndexedItem): number => {
  const time = left.source.createdAt - right.source.createdAt;
  if (time !== 0) return time;
  return left.source.id.localeCompare(right.source.id, 'tr');
};

const priorityRank = (item: IndexedItem): number => {
  if (item.source.tone === 'error') return 0;
  if (item.source.priority === 'urgent') return 1;
  if (item.source.tone === 'warning') return 2;
  if (!item.source.read) return 3;
  return 4;
};

const comparePriority = (left: IndexedItem, right: IndexedItem): number => {
  const rank = priorityRank(left) - priorityRank(right);
  return rank !== 0 ? rank : compareNewest(left, right);
};

const sortItems = (items: readonly IndexedItem[], sort: NotificationTriageSort): readonly IndexedItem[] => {
  const result = items.slice();
  result.sort(sort === 'oldest' ? compareOldest : sort === 'priority' ? comparePriority : compareNewest);
  return result;
};

const createAnnouncement = (
  resultCount: number,
  totalCount: number,
  query: string,
  scope: NotificationTriageScope,
): string => {
  if (totalCount === 0) return 'Henüz bildirim yok.';
  if (resultCount === 0) return 'Arama ve filtrelerle eşleşen bildirim bulunamadı.';
  if (!query && scope === 'all') return `${totalCount} bildirim hızlı erişime hazır.`;
  return `${resultCount} bildirim eşleşti.`;
};

const buildSnapshot = (
  revision: number,
  indexed: readonly IndexedItem[],
  query: string,
  scope: NotificationTriageScope,
  sort: NotificationTriageSort,
  activeId: string | null,
): NotificationTriageSnapshot => {
  const normalizedQuery = normalizeNotificationTriageText(query);
  const filtered = sortItems(indexed.filter((item) => (
    scopeAllows(item, scope) && (!normalizedQuery || item.searchText.includes(normalizedQuery))
  )), sort);
  const requestedIndex = activeId ? filtered.findIndex((item) => item.source.id === activeId) : -1;
  const activeIndex = requestedIndex >= 0 ? requestedIndex : filtered.length > 0 ? 0 : -1;
  const resolvedActiveId = activeIndex >= 0 ? filtered[activeIndex]?.source.id ?? null : null;
  const unreadCount = indexed.reduce((count, item) => count + (item.source.read ? 0 : 1), 0);
  const importantCount = indexed.reduce((count, item) => count + (item.important ? 1 : 0), 0);
  const urgentCount = indexed.reduce((count, item) => count + (item.urgent ? 1 : 0), 0);
  const actionableCount = indexed.reduce((count, item) => count + (item.actionable ? 1 : 0), 0);
  const entries = Object.freeze(filtered.map((item, index) => Object.freeze({
    id: item.source.id,
    title: item.source.title,
    message: item.source.message,
    category: item.source.category,
    tone: item.source.tone,
    read: item.source.read,
    important: item.important,
    urgent: item.urgent,
    dismissible: item.source.dismissible,
    actionable: item.actionable,
    createdAt: item.source.createdAt,
    occurrenceCount: item.source.occurrenceCount,
    position: index + 1,
    setSize: filtered.length,
    selected: item.source.id === resolvedActiveId,
  })));
  const emptyReason: NotificationTriageSnapshot['emptyReason'] = entries.length > 0
    ? 'none'
    : indexed.length === 0
      ? 'no-items'
      : normalizedQuery
        ? 'query'
        : 'scope';
  return Object.freeze({
    revision,
    query,
    normalizedQuery,
    scope,
    sort,
    activeId: resolvedActiveId,
    activeIndex,
    entries,
    resultCount: entries.length,
    totalCount: indexed.length,
    unreadCount,
    importantCount,
    urgentCount,
    actionableCount,
    announcement: createAnnouncement(entries.length, indexed.length, normalizedQuery, scope),
    emptyReason,
  });
};

export class NotificationTriageModel {
  readonly #maxItems: number;
  readonly #maxQueryLength: number;
  readonly #maxListeners: number;
  readonly #pageSize: number;
  readonly #onObserverError: ((error: unknown) => void) | undefined;
  readonly #listeners = new Set<() => void>();
  #indexed: readonly IndexedItem[] = Object.freeze([]);
  #snapshot: NotificationTriageSnapshot;
  #disposed = false;
  #diagnostics: NotificationTriageDiagnostics = Object.freeze({
    activeListenerCount: 0,
    rejectedListenerCount: 0,
    listenerFailureCount: 0,
    reporterFailureCount: 0,
    lastFailureRevision: null,
    lastFailureKind: null,
    disposed: false,
  });

  constructor(options: NotificationTriageModelOptions = {}) {
    this.#maxItems = clampInteger(options.maxItems, DEFAULT_MAX_ITEMS, 1, MAX_ITEMS_LIMIT);
    this.#maxQueryLength = clampInteger(options.maxQueryLength, DEFAULT_QUERY_LENGTH, 1, MAX_QUERY_LENGTH);
    this.#maxListeners = clampInteger(options.maxListeners, DEFAULT_MAX_LISTENERS, 1, MAX_LISTENERS);
    this.#pageSize = clampInteger(options.pageSize, DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE);
    this.#onObserverError = options.onObserverError;
    this.#snapshot = buildSnapshot(0, this.#indexed, '', 'all', 'newest', null);
  }

  readonly getSnapshot = (): NotificationTriageSnapshot => this.#snapshot;
  readonly diagnostics = (): NotificationTriageDiagnostics => this.#diagnostics;

  readonly subscribe = (listener: () => void): (() => void) => {
    if (this.#disposed) {
      this.#recordRejectedListener();
      return () => undefined;
    }
    if (this.#listeners.has(listener)) return () => this.#unsubscribe(listener);
    if (this.#listeners.size >= this.#maxListeners) {
      this.#recordRejectedListener();
      return () => undefined;
    }
    this.#listeners.add(listener);
    this.#refreshListenerCount();
    return () => this.#unsubscribe(listener);
  };

  reconcile(items: readonly NotificationItem[]): void {
    if (this.#disposed) return;
    const indexed: IndexedItem[] = [];
    const seen = new Set<string>();
    for (const item of items) {
      if (indexed.length >= this.#maxItems) break;
      const id = cleanBoundedText(item.id, 96);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      indexed.push(indexItem(item));
    }
    this.#indexed = Object.freeze(indexed);
    this.#rebuild(this.#snapshot.query, this.#snapshot.scope, this.#snapshot.sort, this.#snapshot.activeId);
  }

  setQuery(value: string): void {
    if (this.#disposed) return;
    const query = cleanBoundedText(value, this.#maxQueryLength);
    if (query === this.#snapshot.query) return;
    this.#rebuild(query, this.#snapshot.scope, this.#snapshot.sort, this.#snapshot.activeId);
  }

  setScope(scope: NotificationTriageScope): void {
    if (this.#disposed || scope === this.#snapshot.scope) return;
    if (!['all', 'unread', 'important', 'urgent', 'actionable'].includes(scope)) return;
    this.#rebuild(this.#snapshot.query, scope, this.#snapshot.sort, this.#snapshot.activeId);
  }

  setSort(sort: NotificationTriageSort): void {
    if (this.#disposed || sort === this.#snapshot.sort) return;
    if (!['newest', 'oldest', 'priority'].includes(sort)) return;
    this.#rebuild(this.#snapshot.query, this.#snapshot.scope, sort, this.#snapshot.activeId);
  }

  setActive(id: string): void {
    if (this.#disposed || id === this.#snapshot.activeId) return;
    if (!this.#snapshot.entries.some((entry) => entry.id === id)) return;
    this.#rebuild(this.#snapshot.query, this.#snapshot.scope, this.#snapshot.sort, id);
  }

  moveActive(move: NotificationTriageMove): void {
    if (this.#disposed || this.#snapshot.entries.length === 0) return;
    const length = this.#snapshot.entries.length;
    const current = this.#snapshot.activeIndex >= 0 ? this.#snapshot.activeIndex : 0;
    let next = current;
    if (move === 'next') next = (current + 1) % length;
    if (move === 'previous') next = (current - 1 + length) % length;
    if (move === 'first') next = 0;
    if (move === 'last') next = length - 1;
    if (move === 'page-next') next = Math.min(length - 1, current + this.#pageSize);
    if (move === 'page-previous') next = Math.max(0, current - this.#pageSize);
    const id = this.#snapshot.entries[next]?.id;
    if (id) this.setActive(id);
  }

  reset(): void {
    if (this.#disposed) return;
    this.#emit(buildSnapshot(this.#snapshot.revision + 1, this.#indexed, '', 'all', 'newest', null));
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#listeners.clear();
    this.#diagnostics = Object.freeze({ ...this.#diagnostics, activeListenerCount: 0, disposed: true });
  }

  #rebuild(query: string, scope: NotificationTriageScope, sort: NotificationTriageSort, activeId: string | null): void {
    this.#emit(buildSnapshot(this.#snapshot.revision + 1, this.#indexed, query, scope, sort, activeId));
  }

  #emit(next: NotificationTriageSnapshot): void {
    if (this.#disposed) return;
    this.#snapshot = next;
    for (const listener of this.#listeners) {
      try {
        listener();
      } catch (error) {
        this.#recordListenerFailure(error);
      }
    }
  }

  #recordListenerFailure(error: unknown): void {
    this.#diagnostics = Object.freeze({
      ...this.#diagnostics,
      listenerFailureCount: this.#diagnostics.listenerFailureCount + 1,
      lastFailureRevision: this.#snapshot.revision,
      lastFailureKind: classifyFailure(error),
    });
    const reporter = this.#onObserverError;
    if (!reporter) return;
    try {
      reporter(error);
    } catch (reporterError) {
      this.#diagnostics = Object.freeze({
        ...this.#diagnostics,
        reporterFailureCount: this.#diagnostics.reporterFailureCount + 1,
        lastFailureRevision: this.#snapshot.revision,
        lastFailureKind: `reporter:${classifyFailure(reporterError)}`,
      });
    }
  }

  #recordRejectedListener(): void {
    this.#diagnostics = Object.freeze({
      ...this.#diagnostics,
      rejectedListenerCount: this.#diagnostics.rejectedListenerCount + 1,
    });
  }

  #unsubscribe(listener: () => void): void {
    if (!this.#listeners.delete(listener)) return;
    this.#refreshListenerCount();
  }

  #refreshListenerCount(): void {
    this.#diagnostics = Object.freeze({
      ...this.#diagnostics,
      activeListenerCount: this.#listeners.size,
    });
  }
}
