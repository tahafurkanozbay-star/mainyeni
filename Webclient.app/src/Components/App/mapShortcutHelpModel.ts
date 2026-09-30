import type { MapWorkspaceShortcutDefinition } from './mapWorkspaceShortcuts';

export type MapShortcutHelpCategory = 'all' | 'navigation' | 'workspace' | 'tools';
export type MapShortcutHelpMove = 'next' | 'previous' | 'first' | 'last' | 'page-next' | 'page-previous';

export interface MapShortcutHelpEntry {
  readonly id: string;
  readonly sourceId: string;
  readonly label: string;
  readonly description: string;
  readonly category: Exclude<MapShortcutHelpCategory, 'all'>;
  readonly categoryLabel: string;
  readonly position: number;
  readonly setSize: number;
  readonly selected: boolean;
}

export interface MapShortcutHelpSnapshot {
  readonly revision: number;
  readonly query: string;
  readonly normalizedQuery: string;
  readonly category: MapShortcutHelpCategory;
  readonly activeId: string | null;
  readonly resultCount: number;
  readonly totalCount: number;
  readonly entries: readonly MapShortcutHelpEntry[];
  readonly announcement: string;
  readonly emptyReason: 'none' | 'query' | 'category';
}

export interface MapShortcutHelpCategoryOption {
  readonly id: MapShortcutHelpCategory;
  readonly label: string;
}

export interface MapShortcutHelpObserverDiagnostics {
  readonly failureCount: number;
  readonly reporterFailureCount: number;
  readonly activeObserverCount: number;
  readonly rejectedObserverCount: number;
  readonly lastFailureRevision: number | null;
  readonly lastFailureKind: string | null;
  readonly disposed: boolean;
}

export interface MapShortcutHelpModelOptions {
  readonly maxQueryLength?: number;
  readonly maxListeners?: number;
  readonly pageSize?: number;
  readonly onListenerError?: (error: unknown) => void;
}

export interface MapShortcutHelpAuditFinding {
  readonly code: 'duplicate-id' | 'empty-label' | 'empty-description' | 'invalid-category' | 'catalog-too-large';
  readonly shortcutId?: string;
  readonly detail: string;
}

const DEFAULT_MAX_QUERY_LENGTH = 80;
const MAX_QUERY_LENGTH_LIMIT = 160;
const DEFAULT_MAX_LISTENERS = 24;
const MAX_LISTENERS_LIMIT = 100;
const DEFAULT_PAGE_SIZE = 5;
const MAX_PAGE_SIZE = 20;
const MAX_CATALOG_SIZE = 64;

export const MAP_SHORTCUT_HELP_CATEGORIES: readonly MapShortcutHelpCategoryOption[] = Object.freeze([
  Object.freeze({ id: 'all', label: 'Tümü' }),
  Object.freeze({ id: 'navigation', label: 'Odak ve gezinme' }),
  Object.freeze({ id: 'workspace', label: 'Çalışma alanı' }),
  Object.freeze({ id: 'tools', label: 'Harita araçları' }),
]);

const CATEGORY_LABELS: Readonly<Record<Exclude<MapShortcutHelpCategory, 'all'>, string>> = Object.freeze({
  navigation: 'Odak ve gezinme',
  workspace: 'Çalışma alanı',
  tools: 'Harita araçları',
});

const ACTION_CATEGORY: Readonly<Record<MapWorkspaceShortcutDefinition['action'], Exclude<MapShortcutHelpCategory, 'all'>>> = Object.freeze({
  'focus-map': 'navigation',
  'focus-navigation': 'navigation',
  'toggle-sidebar': 'workspace',
  'open-command-center': 'workspace',
  'open-basemap': 'tools',
  'open-measurement': 'tools',
  'open-feedback': 'tools',
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

const clampInteger = (value: number | undefined, fallback: number, min: number, max: number): number => {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(value ?? fallback)));
};

const classifyFailure = (error: unknown): string => {
  if (error instanceof Error) return error.name || 'Error';
  if (error === null) return 'null';
  return typeof error;
};

export const normalizeMapShortcutHelpText = (value: string): string => {
  const replaced = Array.from(value, (character) => TURKISH_ASCII_REPLACEMENTS[character] ?? character).join('');
  return replaced
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/gu, '')
    .toLocaleLowerCase('tr-TR')
    .replace(/[^a-z0-9+?\s-]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
};

const categoryForShortcut = (shortcut: MapWorkspaceShortcutDefinition): Exclude<MapShortcutHelpCategory, 'all'> => (
  ACTION_CATEGORY[shortcut.action]
);

export const auditMapShortcutHelpCatalog = (
  shortcuts: readonly MapWorkspaceShortcutDefinition[],
): readonly MapShortcutHelpAuditFinding[] => {
  const findings: MapShortcutHelpAuditFinding[] = [];
  const seen = new Set<string>();

  if (shortcuts.length > MAX_CATALOG_SIZE) {
    findings.push(Object.freeze({
      code: 'catalog-too-large',
      detail: `Shortcut help catalog exceeds ${MAX_CATALOG_SIZE} entries.`,
    }));
  }

  for (const shortcut of shortcuts.slice(0, MAX_CATALOG_SIZE + 1)) {
    if (seen.has(shortcut.id)) {
      findings.push(Object.freeze({
        code: 'duplicate-id',
        shortcutId: shortcut.id,
        detail: `Duplicate shortcut help id: ${shortcut.id}`,
      }));
    }
    seen.add(shortcut.id);

    if (!shortcut.label.trim()) {
      findings.push(Object.freeze({
        code: 'empty-label',
        shortcutId: shortcut.id,
        detail: `Shortcut ${shortcut.id} requires a visible key label.`,
      }));
    }

    if (!shortcut.description.trim()) {
      findings.push(Object.freeze({
        code: 'empty-description',
        shortcutId: shortcut.id,
        detail: `Shortcut ${shortcut.id} requires an accessible description.`,
      }));
    }

    if (!categoryForShortcut(shortcut)) {
      findings.push(Object.freeze({
        code: 'invalid-category',
        shortcutId: shortcut.id,
        detail: `Shortcut ${shortcut.id} does not map to a help category.`,
      }));
    }
  }

  return Object.freeze(findings);
};

interface IndexedShortcut {
  readonly source: MapWorkspaceShortcutDefinition;
  readonly category: Exclude<MapShortcutHelpCategory, 'all'>;
  readonly searchText: string;
}

const indexShortcuts = (shortcuts: readonly MapWorkspaceShortcutDefinition[]): readonly IndexedShortcut[] => Object.freeze(
  shortcuts.slice(0, MAX_CATALOG_SIZE).map((shortcut) => {
    const category = categoryForShortcut(shortcut);
    return Object.freeze({
      source: shortcut,
      category,
      searchText: normalizeMapShortcutHelpText(`${shortcut.label} ${shortcut.description} ${CATEGORY_LABELS[category]}`),
    });
  }),
);

const createAnnouncement = (
  resultCount: number,
  totalCount: number,
  query: string,
  category: MapShortcutHelpCategory,
): string => {
  if (!query && category === 'all') return `${totalCount} harita kısayolu gösteriliyor.`;
  if (resultCount === 0) return 'Filtrelerle eşleşen harita kısayolu bulunamadı.';
  return `${resultCount} harita kısayolu bulundu.`;
};

const createSnapshot = (
  revision: number,
  query: string,
  category: MapShortcutHelpCategory,
  activeId: string | null,
  indexed: readonly IndexedShortcut[],
): MapShortcutHelpSnapshot => {
  const normalizedQuery = normalizeMapShortcutHelpText(query);
  const filtered = indexed.filter((item) => (
    (category === 'all' || item.category === category)
    && (!normalizedQuery || item.searchText.includes(normalizedQuery))
  ));
  const nextActiveId = filtered.some((item) => item.source.id === activeId)
    ? activeId
    : filtered[0]?.source.id ?? null;
  const entries = Object.freeze(filtered.map((item, index) => Object.freeze({
    id: `map-shortcut-help-option-${item.source.id}`,
    sourceId: item.source.id,
    label: item.source.label,
    description: item.source.description,
    category: item.category,
    categoryLabel: CATEGORY_LABELS[item.category],
    position: index + 1,
    setSize: filtered.length,
    selected: item.source.id === nextActiveId,
  })));
  const emptyReason: MapShortcutHelpSnapshot['emptyReason'] = filtered.length > 0
    ? 'none'
    : normalizedQuery
      ? 'query'
      : category === 'all'
        ? 'none'
        : 'category';

  return Object.freeze({
    revision,
    query,
    normalizedQuery,
    category,
    activeId: nextActiveId,
    resultCount: filtered.length,
    totalCount: indexed.length,
    entries,
    announcement: createAnnouncement(filtered.length, indexed.length, normalizedQuery, category),
    emptyReason,
  });
};

const createObserverDiagnostics = (): MapShortcutHelpObserverDiagnostics => Object.freeze({
  failureCount: 0,
  reporterFailureCount: 0,
  activeObserverCount: 0,
  rejectedObserverCount: 0,
  lastFailureRevision: null,
  lastFailureKind: null,
  disposed: false,
});

export class MapShortcutHelpModel {
  readonly #indexed: readonly IndexedShortcut[];
  readonly #listeners = new Set<() => void>();
  readonly #maxQueryLength: number;
  readonly #maxListeners: number;
  readonly #pageSize: number;
  readonly #onListenerError?: (error: unknown) => void;
  #snapshot: MapShortcutHelpSnapshot;
  #diagnostics: MapShortcutHelpObserverDiagnostics = createObserverDiagnostics();
  #disposed = false;

  constructor(shortcuts: readonly MapWorkspaceShortcutDefinition[], options: MapShortcutHelpModelOptions = {}) {
    const findings = auditMapShortcutHelpCatalog(shortcuts);
    if (findings.length > 0) {
      throw new Error(`Invalid map shortcut help catalog: ${findings.map((finding) => finding.code).join(', ')}`);
    }
    this.#indexed = indexShortcuts(shortcuts);
    this.#maxQueryLength = clampInteger(options.maxQueryLength, DEFAULT_MAX_QUERY_LENGTH, 1, MAX_QUERY_LENGTH_LIMIT);
    this.#maxListeners = clampInteger(options.maxListeners, DEFAULT_MAX_LISTENERS, 1, MAX_LISTENERS_LIMIT);
    this.#pageSize = clampInteger(options.pageSize, DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE);
    this.#onListenerError = options.onListenerError;
    this.#snapshot = createSnapshot(0, '', 'all', null, this.#indexed);
  }

  readonly getSnapshot = (): MapShortcutHelpSnapshot => this.#snapshot;
  readonly getObserverDiagnostics = (): MapShortcutHelpObserverDiagnostics => this.#diagnostics;

  readonly subscribe = (listener: () => void): (() => void) => {
    if (this.#disposed) {
      this.#recordRejectedObserver();
      return () => undefined;
    }
    if (this.#listeners.has(listener)) return () => this.#unsubscribe(listener);
    if (this.#listeners.size >= this.#maxListeners) {
      this.#recordRejectedObserver();
      throw new Error(`MapShortcutHelpModel listener limit exceeded (${this.#maxListeners}).`);
    }
    this.#listeners.add(listener);
    this.#refreshObserverCount();
    return () => this.#unsubscribe(listener);
  };

  #recordRejectedObserver(): void {
    this.#diagnostics = Object.freeze({
      ...this.#diagnostics,
      rejectedObserverCount: this.#diagnostics.rejectedObserverCount + 1,
    });
  }

  #refreshObserverCount(): void {
    this.#diagnostics = Object.freeze({
      ...this.#diagnostics,
      activeObserverCount: this.#listeners.size,
    });
  }

  #unsubscribe(listener: () => void): void {
    if (!this.#listeners.delete(listener)) return;
    this.#refreshObserverCount();
  }

  #recordObserverFailure(error: unknown, reporterFailure = false): void {
    this.#diagnostics = Object.freeze({
      ...this.#diagnostics,
      failureCount: this.#diagnostics.failureCount + 1,
      reporterFailureCount: this.#diagnostics.reporterFailureCount + (reporterFailure ? 1 : 0),
      lastFailureRevision: this.#snapshot.revision,
      lastFailureKind: classifyFailure(error),
    });
  }

  #reportObserverFailure(error: unknown): void {
    this.#recordObserverFailure(error);
    if (!this.#onListenerError) return;
    try {
      this.#onListenerError(error);
    } catch (reporterError) {
      this.#recordObserverFailure(reporterError, true);
    }
  }

  #emit(next: MapShortcutHelpSnapshot): void {
    if (this.#disposed || next === this.#snapshot) return;
    this.#snapshot = next;
    for (const listener of this.#listeners) {
      try {
        listener();
      } catch (error) {
        this.#reportObserverFailure(error);
      }
    }
  }

  #rebuild(query: string, category: MapShortcutHelpCategory, activeId: string | null): void {
    this.#emit(createSnapshot(this.#snapshot.revision + 1, query, category, activeId, this.#indexed));
  }

  setQuery(value: string): void {
    if (this.#disposed) return;
    const query = value.slice(0, this.#maxQueryLength);
    if (query === this.#snapshot.query) return;
    this.#rebuild(query, this.#snapshot.category, this.#snapshot.activeId);
  }

  setCategory(category: MapShortcutHelpCategory): void {
    if (this.#disposed || category === this.#snapshot.category) return;
    if (!MAP_SHORTCUT_HELP_CATEGORIES.some((item) => item.id === category)) return;
    this.#rebuild(this.#snapshot.query, category, this.#snapshot.activeId);
  }

  setActive(sourceId: string): void {
    if (this.#disposed || sourceId === this.#snapshot.activeId) return;
    if (!this.#snapshot.entries.some((entry) => entry.sourceId === sourceId)) return;
    this.#rebuild(this.#snapshot.query, this.#snapshot.category, sourceId);
  }

  moveActive(direction: MapShortcutHelpMove): void {
    if (this.#disposed || this.#snapshot.entries.length === 0) return;
    const entries = this.#snapshot.entries;
    const currentIndex = Math.max(0, entries.findIndex((entry) => entry.sourceId === this.#snapshot.activeId));
    let nextIndex = currentIndex;
    switch (direction) {
      case 'next': nextIndex = (currentIndex + 1) % entries.length; break;
      case 'previous': nextIndex = (currentIndex - 1 + entries.length) % entries.length; break;
      case 'first': nextIndex = 0; break;
      case 'last': nextIndex = entries.length - 1; break;
      case 'page-next': nextIndex = Math.min(entries.length - 1, currentIndex + this.#pageSize); break;
      case 'page-previous': nextIndex = Math.max(0, currentIndex - this.#pageSize); break;
    }
    const target = entries[nextIndex] ?? entries[0];
    if (target) this.setActive(target.sourceId);
  }

  reset(): void {
    if (this.#disposed) return;
    this.#emit(createSnapshot(this.#snapshot.revision + 1, '', 'all', null, this.#indexed));
  }

  listenerCount(): number {
    return this.#listeners.size;
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
}
