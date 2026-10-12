export type WindowWorkspaceScope = 'recent' | 'open' | 'queries' | 'tools' | 'all';
export type WindowWorkspaceMove = 'next' | 'previous' | 'first' | 'last' | 'page-next' | 'page-previous';
export type WindowWorkspaceKind = 'query' | 'tool' | 'navigation' | 'other';
export type WindowWorkspaceState = 'active' | 'minimized' | 'hidden';

export interface WindowWorkspaceSourceRecord {
  readonly id: string;
  readonly title?: string | null;
  readonly visible: boolean;
  readonly minimized: boolean;
  readonly lazy?: boolean;
}

export interface WindowWorkspaceSourceSnapshot {
  readonly revision: number;
  readonly activeWindowId: string | null;
  readonly windows: readonly WindowWorkspaceSourceRecord[];
}

export interface WindowWorkspaceEntry {
  readonly id: string;
  readonly domId: string;
  readonly title: string;
  readonly kind: WindowWorkspaceKind;
  readonly kindLabel: string;
  readonly state: WindowWorkspaceState;
  readonly stateLabel: string;
  readonly visible: boolean;
  readonly minimized: boolean;
  readonly lazy: boolean;
  readonly recentRank: number | null;
  readonly selected: boolean;
  readonly position: number;
  readonly setSize: number;
  readonly searchableText: string;
}

export interface WindowWorkspaceSnapshot {
  readonly revision: number;
  readonly sourceRevision: number;
  readonly query: string;
  readonly normalizedQuery: string;
  readonly scope: WindowWorkspaceScope;
  readonly activeEntryId: string | null;
  readonly activeWindowId: string | null;
  readonly totalCount: number;
  readonly resultCount: number;
  readonly openCount: number;
  readonly minimizedCount: number;
  readonly recentCount: number;
  readonly entries: readonly WindowWorkspaceEntry[];
  readonly announcement: string;
  readonly emptyReason: 'none' | 'no-windows' | 'no-recent' | 'no-open' | 'no-results';
}

export interface WindowWorkspaceDiagnostics {
  readonly activeListenerCount: number;
  readonly rejectedListenerCount: number;
  readonly listenerFailureCount: number;
  readonly reporterFailureCount: number;
  readonly lastFailureKind: string | null;
  readonly lastFailureRevision: number | null;
  readonly disposed: boolean;
}

export interface WindowWorkspaceModelOptions {
  readonly maxQueryLength?: number;
  readonly maxListeners?: number;
  readonly maxRecent?: number;
  readonly maxWindows?: number;
  readonly pageSize?: number;
  readonly onListenerError?: (error: unknown) => void;
}

export interface WindowWorkspaceAuditFinding {
  readonly code:
    | 'duplicate-id'
    | 'empty-id'
    | 'oversized-id'
    | 'oversized-title'
    | 'catalog-too-large';
  readonly windowId?: string;
  readonly detail: string;
}

export interface WindowWorkspaceInventory {
  readonly totalCount: number;
  readonly queryCount: number;
  readonly toolCount: number;
  readonly navigationCount: number;
  readonly otherCount: number;
}

export const WINDOW_WORKSPACE_SCOPES: readonly Readonly<{
  id: WindowWorkspaceScope;
  label: string;
  emptyLabel: string;
}>[] = Object.freeze([
  Object.freeze({ id: 'recent', label: 'Son', emptyLabel: 'Henüz son kullanılan pencere yok.' }),
  Object.freeze({ id: 'open', label: 'Açık', emptyLabel: 'Açık veya küçültülmüş pencere yok.' }),
  Object.freeze({ id: 'queries', label: 'Sorgular', emptyLabel: 'Kayıtlı sorgu penceresi yok.' }),
  Object.freeze({ id: 'tools', label: 'Araçlar', emptyLabel: 'Kayıtlı harita aracı yok.' }),
  Object.freeze({ id: 'all', label: 'Tümü', emptyLabel: 'Kayıtlı pencere yok.' }),
]);

const DEFAULT_MAX_QUERY_LENGTH = 96;
const MAX_QUERY_LENGTH_LIMIT = 192;
const DEFAULT_MAX_LISTENERS = 32;
const MAX_LISTENERS_LIMIT = 128;
const DEFAULT_MAX_RECENT = 12;
const MAX_RECENT_LIMIT = 32;
const DEFAULT_MAX_WINDOWS = 128;
const MAX_WINDOWS_LIMIT = 256;
const DEFAULT_PAGE_SIZE = 7;
const MAX_PAGE_SIZE = 24;
const MAX_WINDOW_ID_LENGTH = 128;
const MAX_WINDOW_TITLE_LENGTH = 180;

const TOOL_LABELS: Readonly<Record<string, string>> = Object.freeze({
  'basemap-widget': 'Altlık harita',
  'bookmark-widget': 'Yer işaretleri',
  'context-menu-widget': 'Harita bağlam menüsü',
  'feedback-widget': 'Geri bildirim',
  'global-identify-widget': 'Detay sorgulama',
  'measurement-widget': 'Ölçüm araçları',
  'sketch-widget': 'Çizim araçları',
  'streetview-widget': 'Sokak görünümü',
  'toolbar-widget': 'Harita araç çubuğu',
  sidebar: 'Şehir servisleri',
  mainbar: 'Ana navigasyon',
});

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

const clampInteger = (
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
): number => {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(value ?? fallback)));
};

const stripControlCharacters = (value: string): string => {
  let sanitized = '';
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    sanitized += codePoint !== undefined && (codePoint < 32 || codePoint === 127) ? ' ' : character;
  }
  return sanitized;
};

const sanitizeInlineText = (value: unknown, maxLength: number): string => {
  if (typeof value !== 'string') return '';
  return stripControlCharacters(value).replace(/\s+/gu, ' ').trim().slice(0, maxLength);
};

export const normalizeWindowWorkspaceText = (value: string): string => {
  const replaced = [...value]
    .map((character) => TURKISH_ASCII_REPLACEMENTS[character] ?? character)
    .join('');
  return replaced
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/gu, '')
    .toLocaleLowerCase('tr-TR')
    .replace(/[^a-z0-9\s_-]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
};

const normalizeWindowId = (value: unknown): string => sanitizeInlineText(value, MAX_WINDOW_ID_LENGTH);

const humanizeWindowId = (id: string): string => {
  const known = TOOL_LABELS[id];
  if (known) return known;
  const stripped = id
    .replace(/-query-window$/u, '')
    .replace(/-widget$/u, '')
    .replace(/-window$/u, '')
    .replace(/[-_]+/gu, ' ')
    .trim();
  if (!stripped) return id;
  return stripped.charAt(0).toLocaleUpperCase('tr-TR') + stripped.slice(1);
};

const resolveTitle = (record: WindowWorkspaceSourceRecord): string => {
  const title = sanitizeInlineText(record.title, MAX_WINDOW_TITLE_LENGTH);
  return title || humanizeWindowId(record.id);
};

export const classifyWindowWorkspaceKind = (id: string): WindowWorkspaceKind => {
  if (id === 'sidebar' || id === 'mainbar' || id.includes('navigation')) return 'navigation';
  if (id.endsWith('-query-window')) return 'query';
  if (id.endsWith('-widget') || id.includes('toolbar')) return 'tool';
  return 'other';
};

export const windowWorkspaceKindLabel = (kind: WindowWorkspaceKind): string => {
  switch (kind) {
    case 'query': return 'Sorgu';
    case 'tool': return 'Harita aracı';
    case 'navigation': return 'Gezinme';
    case 'other': return 'Pencere';
  }
};

const stateFor = (
  record: Readonly<Pick<WindowWorkspaceSourceRecord, 'visible' | 'minimized'>>,
  activeWindowId: string | null,
  id: string,
): WindowWorkspaceState => {
  if (record.visible && !record.minimized && activeWindowId === id) return 'active';
  if (record.visible && record.minimized) return 'minimized';
  if (record.visible) return 'active';
  return 'hidden';
};

export const windowWorkspaceStateLabel = (state: WindowWorkspaceState): string => {
  switch (state) {
    case 'active': return 'Açık';
    case 'minimized': return 'Küçültülmüş';
    case 'hidden': return 'Kapalı';
  }
};

export const auditWindowWorkspaceSource = (
  source: WindowWorkspaceSourceSnapshot,
  maxWindows = DEFAULT_MAX_WINDOWS,
): readonly WindowWorkspaceAuditFinding[] => {
  const findings: WindowWorkspaceAuditFinding[] = [];
  const seen = new Set<string>();
  const boundedMax = clampInteger(maxWindows, DEFAULT_MAX_WINDOWS, 1, MAX_WINDOWS_LIMIT);

  if (source.windows.length > boundedMax) {
    findings.push(Object.freeze({
      code: 'catalog-too-large',
      detail: `Window catalog has ${source.windows.length} entries; maximum is ${boundedMax}.`,
    }));
  }

  for (const raw of source.windows.slice(0, boundedMax + 1)) {
    const id = normalizeWindowId(raw.id);
    if (!id) {
      findings.push(Object.freeze({ code: 'empty-id', detail: 'Window id cannot be empty.' }));
      continue;
    }
    if (String(raw.id).trim().length > MAX_WINDOW_ID_LENGTH) {
      findings.push(Object.freeze({
        code: 'oversized-id',
        windowId: id,
        detail: `Window id exceeds ${MAX_WINDOW_ID_LENGTH} characters.`,
      }));
    }
    if (seen.has(id)) {
      findings.push(Object.freeze({
        code: 'duplicate-id',
        windowId: id,
        detail: `Duplicate window id: ${id}`,
      }));
    }
    seen.add(id);
    if (typeof raw.title === 'string' && raw.title.trim().length > MAX_WINDOW_TITLE_LENGTH) {
      findings.push(Object.freeze({
        code: 'oversized-title',
        windowId: id,
        detail: `Window title exceeds ${MAX_WINDOW_TITLE_LENGTH} characters: ${id}`,
      }));
    }
  }

  return Object.freeze(findings);
};

interface IndexedWindow {
  readonly id: string;
  readonly title: string;
  readonly kind: WindowWorkspaceKind;
  readonly kindLabel: string;
  readonly visible: boolean;
  readonly minimized: boolean;
  readonly lazy: boolean;
  readonly state: WindowWorkspaceState;
  readonly stateLabel: string;
  readonly recentRank: number | null;
  readonly searchableText: string;
}

const buildInventory = (records: readonly IndexedWindow[]): WindowWorkspaceInventory => {
  const inventory = {
    totalCount: records.length,
    queryCount: 0,
    toolCount: 0,
    navigationCount: 0,
    otherCount: 0,
  };
  for (const record of records) {
    if (record.kind === 'query') inventory.queryCount += 1;
    else if (record.kind === 'tool') inventory.toolCount += 1;
    else if (record.kind === 'navigation') inventory.navigationCount += 1;
    else inventory.otherCount += 1;
  }
  return Object.freeze(inventory);
};

const compareRecent = (left: IndexedWindow, right: IndexedWindow): number => {
  if (left.recentRank !== null || right.recentRank !== null) {
    if (left.recentRank === null) return 1;
    if (right.recentRank === null) return -1;
    if (left.recentRank !== right.recentRank) return left.recentRank - right.recentRank;
  }
  return left.title.localeCompare(right.title, 'tr-TR', { sensitivity: 'base' });
};

const compareOpen = (left: IndexedWindow, right: IndexedWindow): number => {
  const leftState = left.state === 'active' ? 0 : left.state === 'minimized' ? 1 : 2;
  const rightState = right.state === 'active' ? 0 : right.state === 'minimized' ? 1 : 2;
  if (leftState !== rightState) return leftState - rightState;
  return compareRecent(left, right);
};

const scopeMatches = (record: IndexedWindow, scope: WindowWorkspaceScope): boolean => {
  switch (scope) {
    case 'recent': return record.recentRank !== null;
    case 'open': return record.visible;
    case 'queries': return record.kind === 'query';
    case 'tools': return record.kind === 'tool' || record.kind === 'navigation';
    case 'all': return true;
  }
};

const createAnnouncement = (
  resultCount: number,
  totalCount: number,
  scope: WindowWorkspaceScope,
  normalizedQuery: string,
): string => {
  if (totalCount === 0) return 'Henüz kayıtlı çalışma penceresi yok.';
  if (resultCount === 0) return normalizedQuery
    ? 'Aramayla eşleşen çalışma penceresi bulunamadı.'
    : `${WINDOW_WORKSPACE_SCOPES.find((candidate) => candidate.id === scope)?.emptyLabel ?? 'Pencere bulunamadı.'}`;
  if (normalizedQuery) return `${resultCount} çalışma penceresi aramayla eşleşti.`;
  if (scope === 'recent') return `${resultCount} son kullanılan pencere gösteriliyor.`;
  if (scope === 'open') return `${resultCount} açık veya küçültülmüş pencere gösteriliyor.`;
  return `${resultCount} çalışma penceresi gösteriliyor.`;
};

const emptyReasonFor = (
  resultCount: number,
  totalCount: number,
  scope: WindowWorkspaceScope,
  normalizedQuery: string,
): WindowWorkspaceSnapshot['emptyReason'] => {
  if (resultCount > 0) return 'none';
  if (totalCount === 0) return 'no-windows';
  if (normalizedQuery) return 'no-results';
  if (scope === 'recent') return 'no-recent';
  if (scope === 'open') return 'no-open';
  return 'no-results';
};

export class WindowWorkspaceModel {
  readonly #listeners = new Set<() => void>();
  readonly #maxQueryLength: number;
  readonly #maxListeners: number;
  readonly #maxRecent: number;
  readonly #maxWindows: number;
  readonly #pageSize: number;
  readonly #onListenerError?: (error: unknown) => void;

  #source: WindowWorkspaceSourceSnapshot = Object.freeze({
    revision: 0,
    activeWindowId: null,
    windows: Object.freeze([]),
  });
  #recentIds: string[] = [];
  #query = '';
  #scope: WindowWorkspaceScope = 'recent';
  #activeEntryId: string | null = null;
  #revision = 0;
  #snapshot: WindowWorkspaceSnapshot;
  #diagnostics: WindowWorkspaceDiagnostics = Object.freeze({
    activeListenerCount: 0,
    rejectedListenerCount: 0,
    listenerFailureCount: 0,
    reporterFailureCount: 0,
    lastFailureKind: null,
    lastFailureRevision: null,
    disposed: false,
  });
  #disposed = false;

  constructor(options: WindowWorkspaceModelOptions = {}) {
    this.#maxQueryLength = clampInteger(
      options.maxQueryLength,
      DEFAULT_MAX_QUERY_LENGTH,
      1,
      MAX_QUERY_LENGTH_LIMIT,
    );
    this.#maxListeners = clampInteger(
      options.maxListeners,
      DEFAULT_MAX_LISTENERS,
      1,
      MAX_LISTENERS_LIMIT,
    );
    this.#maxRecent = clampInteger(options.maxRecent, DEFAULT_MAX_RECENT, 1, MAX_RECENT_LIMIT);
    this.#maxWindows = clampInteger(options.maxWindows, DEFAULT_MAX_WINDOWS, 1, MAX_WINDOWS_LIMIT);
    this.#pageSize = clampInteger(options.pageSize, DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE);
    this.#onListenerError = options.onListenerError;
    this.#snapshot = this.#buildSnapshot();
  }

  readonly getSnapshot = (): WindowWorkspaceSnapshot => this.#snapshot;
  readonly getDiagnostics = (): WindowWorkspaceDiagnostics => this.#diagnostics;

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

  ingest(source: WindowWorkspaceSourceSnapshot): void {
    if (this.#disposed) return;
    const findings = auditWindowWorkspaceSource(source, this.#maxWindows);
    if (findings.some((finding) => finding.code === 'duplicate-id' || finding.code === 'empty-id')) {
      throw new Error(`Invalid window workspace source: ${findings.map((finding) => finding.code).join(', ')}`);
    }

    const windows = Object.freeze(source.windows.slice(0, this.#maxWindows).map((record) => Object.freeze({
      id: normalizeWindowId(record.id),
      title: sanitizeInlineText(record.title, MAX_WINDOW_TITLE_LENGTH) || null,
      visible: record.visible === true,
      minimized: record.minimized === true,
      lazy: record.lazy === true,
    })));

    const activeWindowId = windows.some((record) => record.id === source.activeWindowId)
      ? source.activeWindowId
      : windows.find((record) => record.visible && !record.minimized)?.id ?? null;

    if (activeWindowId && activeWindowId !== this.#source.activeWindowId) {
      this.#recordRecent(activeWindowId);
    }

    const ids = new Set(windows.map((record) => record.id));
    this.#recentIds = this.#recentIds.filter((id) => ids.has(id)).slice(0, this.#maxRecent);
    this.#source = Object.freeze({
      revision: Number.isFinite(source.revision) ? Math.max(0, Math.trunc(source.revision)) : 0,
      activeWindowId,
      windows,
    });
    this.#commit();
  }

  setQuery(value: string): void {
    if (this.#disposed) return;
    const query = sanitizeInlineText(value, this.#maxQueryLength);
    if (query === this.#query) return;
    this.#query = query;
    this.#commit();
  }

  clearQuery(): void {
    this.setQuery('');
  }

  setScope(scope: WindowWorkspaceScope): void {
    if (this.#disposed || scope === this.#scope) return;
    if (!WINDOW_WORKSPACE_SCOPES.some((candidate) => candidate.id === scope)) return;
    this.#scope = scope;
    this.#commit();
  }

  setActive(id: string): void {
    if (this.#disposed) return;
    const normalized = normalizeWindowId(id);
    if (!this.#snapshot.entries.some((entry) => entry.id === normalized)) return;
    if (normalized === this.#activeEntryId) return;
    this.#activeEntryId = normalized;
    this.#commit();
  }

  moveActive(move: WindowWorkspaceMove): void {
    if (this.#disposed || this.#snapshot.entries.length === 0) return;
    const entries = this.#snapshot.entries;
    const currentIndex = Math.max(
      0,
      entries.findIndex((entry) => entry.id === this.#snapshot.activeEntryId),
    );
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

  noteActivated(id: string): void {
    if (this.#disposed) return;
    const normalized = normalizeWindowId(id);
    if (!this.#source.windows.some((record) => record.id === normalized)) return;
    this.#recordRecent(normalized);
    this.#activeEntryId = normalized;
    this.#commit();
  }

  resetDiscovery(): void {
    if (this.#disposed) return;
    this.#query = '';
    this.#scope = this.#recentIds.length > 0 ? 'recent' : 'all';
    this.#activeEntryId = null;
    this.#commit();
  }

  inventory(): WindowWorkspaceInventory {
    return buildInventory(this.#indexSource());
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#listeners.clear();
    this.#diagnostics = Object.freeze({
      ...this.#diagnostics,
      activeListenerCount: 0,
      disposed: true,
    });
  }

  disposed(): boolean {
    return this.#disposed;
  }

  #recordRecent(id: string): void {
    this.#recentIds = [id, ...this.#recentIds.filter((candidate) => candidate !== id)]
      .slice(0, this.#maxRecent);
  }

  #indexSource(): readonly IndexedWindow[] {
    const recentRank = new Map(this.#recentIds.map((id, index) => [id, index] as const));
    return Object.freeze(this.#source.windows.map((record) => {
      const title = resolveTitle(record);
      const kind = classifyWindowWorkspaceKind(record.id);
      const kindLabel = windowWorkspaceKindLabel(kind);
      const state = stateFor(record, this.#source.activeWindowId, record.id);
      const stateLabel = windowWorkspaceStateLabel(state);
      return Object.freeze({
        id: record.id,
        title,
        kind,
        kindLabel,
        visible: record.visible,
        minimized: record.minimized,
        lazy: record.lazy === true,
        state,
        stateLabel,
        recentRank: recentRank.get(record.id) ?? null,
        searchableText: normalizeWindowWorkspaceText(
          `${title} ${record.id} ${kindLabel} ${stateLabel}`,
        ),
      });
    }));
  }

  #buildSnapshot(): WindowWorkspaceSnapshot {
    const normalizedQuery = normalizeWindowWorkspaceText(this.#query);
    const indexed = this.#indexSource();
    const filtered = indexed
      .filter((record) => scopeMatches(record, this.#scope))
      .filter((record) => !normalizedQuery || record.searchableText.includes(normalizedQuery))
      .sort(this.#scope === 'open' ? compareOpen : compareRecent);

    const activeEntryId = filtered.some((record) => record.id === this.#activeEntryId)
      ? this.#activeEntryId
      : filtered.some((record) => record.id === this.#source.activeWindowId)
        ? this.#source.activeWindowId
        : filtered[0]?.id ?? null;

    const entries = Object.freeze(filtered.map((record, index) => Object.freeze({
      id: record.id,
      domId: `experience-window-dock-item-${record.id.replace(/[^a-zA-Z0-9_-]/gu, '-')}`,
      title: record.title,
      kind: record.kind,
      kindLabel: record.kindLabel,
      state: record.state,
      stateLabel: record.stateLabel,
      visible: record.visible,
      minimized: record.minimized,
      lazy: record.lazy,
      recentRank: record.recentRank,
      selected: record.id === activeEntryId,
      position: index + 1,
      setSize: filtered.length,
      searchableText: record.searchableText,
    })));

    const openCount = indexed.filter((record) => record.visible).length;
    const minimizedCount = indexed.filter((record) => record.visible && record.minimized).length;
    return Object.freeze({
      revision: this.#revision,
      sourceRevision: this.#source.revision,
      query: this.#query,
      normalizedQuery,
      scope: this.#scope,
      activeEntryId,
      activeWindowId: this.#source.activeWindowId,
      totalCount: indexed.length,
      resultCount: entries.length,
      openCount,
      minimizedCount,
      recentCount: this.#recentIds.length,
      entries,
      announcement: createAnnouncement(entries.length, indexed.length, this.#scope, normalizedQuery),
      emptyReason: emptyReasonFor(entries.length, indexed.length, this.#scope, normalizedQuery),
    });
  }

  #commit(): void {
    if (this.#disposed) return;
    this.#revision += 1;
    this.#snapshot = this.#buildSnapshot();
    for (const listener of Array.from(this.#listeners)) {
      try {
        listener();
      } catch (error) {
        this.#recordListenerFailure(error);
      }
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

  #recordListenerFailure(error: unknown): void {
    this.#diagnostics = Object.freeze({
      ...this.#diagnostics,
      listenerFailureCount: this.#diagnostics.listenerFailureCount + 1,
      lastFailureKind: error instanceof Error ? error.name || 'Error' : typeof error,
      lastFailureRevision: this.#snapshot.revision,
    });
    if (!this.#onListenerError) return;
    try {
      this.#onListenerError(error);
    } catch (reporterError) {
      this.#diagnostics = Object.freeze({
        ...this.#diagnostics,
        reporterFailureCount: this.#diagnostics.reporterFailureCount + 1,
        lastFailureKind: reporterError instanceof Error
          ? `reporter:${reporterError.name || 'Error'}`
          : `reporter:${typeof reporterError}`,
        lastFailureRevision: this.#snapshot.revision,
      });
    }
  }
}

export const createWindowWorkspaceModel = (
  options: WindowWorkspaceModelOptions = {},
): WindowWorkspaceModel => new WindowWorkspaceModel(options);
