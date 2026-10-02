import type { NormalizedSearchRecord } from '../_Common/QuerySearchRuntime';
import {
  createGeneralSearchFilters,
  generalSearchResultDomId,
  generalSearchSuggestionDomId,
  moveGeneralSearchActiveIndex,
  projectGeneralSearchWorkspace,
  toggleFacetValue,
  type GeneralSearchSortMode,
  type GeneralSearchSuggestion,
  type GeneralSearchWorkspaceFilters,
  type GeneralSearchWorkspaceOptions,
  type GeneralSearchWorkspacePhase,
  type GeneralSearchWorkspaceSnapshot,
} from './generalSearchWorkspaceModel';

export interface GeneralSearchWorkspaceControllerOptions extends GeneralSearchWorkspaceOptions {
  readonly maximumListeners?: number;
  readonly initialQuery?: string;
}

export interface GeneralSearchWorkspaceControllerSnapshot {
  readonly workspace: GeneralSearchWorkspaceSnapshot;
  readonly errorMessage: string;
  readonly suggestionOpen: boolean;
  readonly activeSuggestionIndex: number;
  readonly activeSuggestionId: string | null;
  readonly filterPanelOpen: boolean;
  readonly announcement: string;
  readonly revision: number;
}

export type GeneralSearchWorkspaceListener = () => void;

interface MutableControllerState {
  records: readonly NormalizedSearchRecord[];
  phase: GeneralSearchWorkspacePhase;
  filters: GeneralSearchWorkspaceFilters;
  page: number;
  activeIndex: number;
  errorMessage: string;
  suggestionOpen: boolean;
  activeSuggestionIndex: number;
  filterPanelOpen: boolean;
  announcement: string;
  revision: number;
}

const normalizeListenerLimit = (value: unknown): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 24;
  return Math.min(128, Math.max(1, Math.trunc(parsed)));
};

const normalizeError = (value: unknown): string => {
  if (value instanceof Error) return String(value.message || value.name || 'Arama hatası').slice(0, 400);
  return String(value ?? '').trim().slice(0, 400);
};

const freezeSnapshot = (
  state: MutableControllerState,
  options: GeneralSearchWorkspaceControllerOptions,
): GeneralSearchWorkspaceControllerSnapshot => {
  const workspace = projectGeneralSearchWorkspace({
    records: state.records,
    filters: state.filters,
    page: state.page,
    activeIndex: state.activeIndex,
    phase: state.phase,
    options,
  });
  const boundedSuggestionIndex = workspace.suggestions.length === 0
    ? -1
    : Math.min(workspace.suggestions.length - 1, Math.max(0, state.activeSuggestionIndex));
  const activeSuggestion = boundedSuggestionIndex >= 0
    ? workspace.suggestions[boundedSuggestionIndex] ?? null
    : null;
  return Object.freeze({
    workspace,
    errorMessage: state.errorMessage,
    suggestionOpen: state.suggestionOpen && workspace.suggestions.length > 0,
    activeSuggestionIndex: boundedSuggestionIndex,
    activeSuggestionId: activeSuggestion
      ? generalSearchSuggestionDomId(activeSuggestion.id)
      : null,
    filterPanelOpen: state.filterPanelOpen,
    announcement: state.announcement,
    revision: state.revision,
  });
};

const defaultAnnouncement = (workspace: GeneralSearchWorkspaceSnapshot): string => {
  if (workspace.phase === 'loading') return 'Arama sonuçları yükleniyor.';
  if (workspace.phase === 'error') return 'Arama tamamlanamadı.';
  if (workspace.matchedCount === 0) return 'Eşleşen sonuç bulunamadı.';
  return `${workspace.matchedCount} sonuç gösterime hazır.`;
};

export class GeneralSearchWorkspaceController {
  readonly #options: GeneralSearchWorkspaceControllerOptions;
  readonly #maximumListeners: number;
  readonly #listeners = new Set<GeneralSearchWorkspaceListener>();
  #state: MutableControllerState;
  #snapshot: GeneralSearchWorkspaceControllerSnapshot;
  #disposed = false;

  constructor(options: GeneralSearchWorkspaceControllerOptions = {}) {
    this.#options = Object.freeze({ ...options });
    this.#maximumListeners = normalizeListenerLimit(options.maximumListeners);
    this.#state = {
      records: Object.freeze([]),
      phase: 'idle',
      filters: createGeneralSearchFilters({
        text: options.initialQuery ?? '',
        sort: options.initialSort ?? 'relevance',
      }),
      page: 1,
      activeIndex: -1,
      errorMessage: '',
      suggestionOpen: false,
      activeSuggestionIndex: 0,
      filterPanelOpen: false,
      announcement: '',
      revision: 0,
    };
    this.#snapshot = freezeSnapshot(this.#state, this.#options);
  }

  #ensureActive(): void {
    if (this.#disposed) throw new Error('General search workspace controller has been disposed');
  }

  #rebuild(announcement?: string): void {
    const preliminary = freezeSnapshot(this.#state, this.#options);
    this.#state = {
      ...this.#state,
      page: preliminary.workspace.page.page,
      activeIndex: preliminary.workspace.activeIndex,
      activeSuggestionIndex: preliminary.activeSuggestionIndex,
      announcement: announcement ?? this.#state.announcement,
      revision: this.#state.revision + 1,
    };
    const next = freezeSnapshot(this.#state, this.#options);
    if (!this.#state.announcement) {
      this.#state = {
        ...this.#state,
        announcement: defaultAnnouncement(next.workspace),
      };
    }
    this.#snapshot = freezeSnapshot(this.#state, this.#options);
    for (const listener of [...this.#listeners]) {
      try {
        listener();
      } catch {
        // A view listener must never prevent state publication to other subscribers.
      }
    }
  }

  getSnapshot = (): GeneralSearchWorkspaceControllerSnapshot => this.#snapshot;

  subscribe = (listener: GeneralSearchWorkspaceListener): (() => void) => {
    this.#ensureActive();
    if (this.#listeners.size >= this.#maximumListeners && !this.#listeners.has(listener)) {
      throw new Error(`General search listener limit reached: ${this.#maximumListeners}`);
    }
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  beginLoading(query?: string): void {
    this.#ensureActive();
    if (query !== undefined) {
      this.#state = {
        ...this.#state,
        filters: createGeneralSearchFilters({ ...this.#state.filters, text: query }),
      };
    }
    this.#state = {
      ...this.#state,
      phase: 'loading',
      errorMessage: '',
      suggestionOpen: false,
      page: 1,
      activeIndex: -1,
      announcement: 'Arama sonuçları yükleniyor.',
    };
    this.#rebuild('Arama sonuçları yükleniyor.');
  }

  replaceRecords(records: readonly NormalizedSearchRecord[]): void {
    this.#ensureActive();
    const frozenRecords = Object.freeze([...records]);
    this.#state = {
      ...this.#state,
      records: frozenRecords,
      phase: frozenRecords.length === 0 ? 'empty' : 'ready',
      errorMessage: '',
      page: 1,
      activeIndex: frozenRecords.length === 0 ? -1 : 0,
      suggestionOpen: false,
      activeSuggestionIndex: 0,
      announcement: '',
    };
    this.#rebuild();
  }

  setError(error: unknown): void {
    this.#ensureActive();
    const errorMessage = normalizeError(error) || 'Arama sırasında beklenmeyen bir hata oluştu.';
    this.#state = {
      ...this.#state,
      phase: 'error',
      errorMessage,
      suggestionOpen: false,
      announcement: `Arama tamamlanamadı. ${errorMessage}`,
    };
    this.#rebuild(this.#state.announcement);
  }

  clearError(): void {
    this.#ensureActive();
    if (!this.#state.errorMessage) return;
    this.#state = {
      ...this.#state,
      errorMessage: '',
      phase: this.#state.records.length === 0 ? 'empty' : 'ready',
      announcement: '',
    };
    this.#rebuild();
  }

  setText(text: string): void {
    this.#ensureActive();
    this.#state = {
      ...this.#state,
      filters: createGeneralSearchFilters({ ...this.#state.filters, text }),
      page: 1,
      activeIndex: 0,
      suggestionOpen: Boolean(String(text).trim()),
      activeSuggestionIndex: 0,
      announcement: '',
    };
    this.#rebuild();
  }

  setSort(sort: GeneralSearchSortMode): void {
    this.#ensureActive();
    this.#state = {
      ...this.#state,
      filters: createGeneralSearchFilters({ ...this.#state.filters, sort }),
      page: 1,
      activeIndex: 0,
      suggestionOpen: false,
      announcement: 'Sonuç sıralaması güncellendi.',
    };
    this.#rebuild(this.#state.announcement);
  }

  toggleCategory(value: string): void {
    this.#ensureActive();
    this.#state = {
      ...this.#state,
      filters: createGeneralSearchFilters({
        ...this.#state.filters,
        categories: toggleFacetValue(this.#state.filters.categories, value),
      }),
      page: 1,
      activeIndex: 0,
      suggestionOpen: false,
      announcement: 'Kategori filtresi güncellendi.',
    };
    this.#rebuild(this.#state.announcement);
  }

  toggleType(value: string): void {
    this.#ensureActive();
    this.#state = {
      ...this.#state,
      filters: createGeneralSearchFilters({
        ...this.#state.filters,
        types: toggleFacetValue(this.#state.filters.types, value),
      }),
      page: 1,
      activeIndex: 0,
      suggestionOpen: false,
      announcement: 'Tür filtresi güncellendi.',
    };
    this.#rebuild(this.#state.announcement);
  }

  clearFilters(options: Readonly<{ keepText?: boolean; keepSort?: boolean }> = {}): void {
    this.#ensureActive();
    this.#state = {
      ...this.#state,
      filters: createGeneralSearchFilters({
        text: options.keepText ? this.#state.filters.text : '',
        sort: options.keepSort ? this.#state.filters.sort : 'relevance',
      }),
      page: 1,
      activeIndex: 0,
      suggestionOpen: false,
      activeSuggestionIndex: 0,
      announcement: 'Arama filtreleri temizlendi.',
    };
    this.#rebuild(this.#state.announcement);
  }

  clearText(): void {
    this.#ensureActive();
    this.#state = {
      ...this.#state,
      filters: createGeneralSearchFilters({ ...this.#state.filters, text: '' }),
      page: 1,
      activeIndex: 0,
      suggestionOpen: false,
      activeSuggestionIndex: 0,
      announcement: 'Metin filtresi temizlendi.',
    };
    this.#rebuild(this.#state.announcement);
  }

  setPage(page: number): void {
    this.#ensureActive();
    this.#state = {
      ...this.#state,
      page,
      activeIndex: 0,
      suggestionOpen: false,
      announcement: '',
    };
    this.#rebuild();
    const current = this.#snapshot.workspace.page.page;
    const count = this.#snapshot.workspace.page.pageCount;
    this.#state = {
      ...this.#state,
      announcement: `Sayfa ${current} / ${count}.`,
    };
    this.#snapshot = freezeSnapshot(this.#state, this.#options);
  }

  moveActive(key: string): number {
    this.#ensureActive();
    const itemCount = this.#snapshot.workspace.page.items.length;
    const activeIndex = moveGeneralSearchActiveIndex(
      this.#snapshot.workspace.activeIndex,
      itemCount,
      key,
    );
    if (activeIndex === this.#snapshot.workspace.activeIndex) return activeIndex;
    this.#state = {
      ...this.#state,
      activeIndex,
      suggestionOpen: false,
      announcement: '',
    };
    this.#rebuild('');
    return activeIndex;
  }

  activeRecord(): NormalizedSearchRecord | null {
    const index = this.#snapshot.workspace.activeIndex;
    if (index < 0) return null;
    return this.#snapshot.workspace.page.items[index]?.record ?? null;
  }

  activeRecordDomId(): string | null {
    const key = this.#snapshot.workspace.activeKey;
    return key ? generalSearchResultDomId(key) : null;
  }

  openSuggestions(): void {
    this.#ensureActive();
    if (this.#snapshot.workspace.suggestions.length === 0) return;
    this.#state = {
      ...this.#state,
      suggestionOpen: true,
      activeSuggestionIndex: 0,
    };
    this.#rebuild();
  }

  closeSuggestions(): void {
    this.#ensureActive();
    if (!this.#state.suggestionOpen) return;
    this.#state = {
      ...this.#state,
      suggestionOpen: false,
      activeSuggestionIndex: 0,
    };
    this.#rebuild();
  }

  moveSuggestion(direction: 'next' | 'previous' | 'first' | 'last'): number {
    this.#ensureActive();
    const count = this.#snapshot.workspace.suggestions.length;
    if (count === 0) return -1;
    let next = Math.min(count - 1, Math.max(0, this.#snapshot.activeSuggestionIndex));
    if (direction === 'next') next = Math.min(count - 1, next + 1);
    else if (direction === 'previous') next = Math.max(0, next - 1);
    else if (direction === 'first') next = 0;
    else next = count - 1;
    this.#state = {
      ...this.#state,
      suggestionOpen: true,
      activeSuggestionIndex: next,
    };
    this.#rebuild();
    return next;
  }

  activeSuggestion(): GeneralSearchSuggestion | null {
    const index = this.#snapshot.activeSuggestionIndex;
    if (index < 0) return null;
    return this.#snapshot.workspace.suggestions[index] ?? null;
  }

  applySuggestion(suggestion: GeneralSearchSuggestion): NormalizedSearchRecord | null {
    this.#ensureActive();
    if (suggestion.kind === 'category') {
      this.#state = {
        ...this.#state,
        filters: createGeneralSearchFilters({
          ...this.#state.filters,
          categories: [suggestion.label],
        }),
        page: 1,
        activeIndex: 0,
        suggestionOpen: false,
        announcement: `Kategori filtresi ${suggestion.label} olarak ayarlandı.`,
      };
      this.#rebuild(this.#state.announcement);
      return null;
    }
    if (suggestion.kind === 'type') {
      this.#state = {
        ...this.#state,
        filters: createGeneralSearchFilters({
          ...this.#state.filters,
          types: [suggestion.label],
        }),
        page: 1,
        activeIndex: 0,
        suggestionOpen: false,
        announcement: `Tür filtresi ${suggestion.label} olarak ayarlandı.`,
      };
      this.#rebuild(this.#state.announcement);
      return null;
    }
    const record = this.#state.records.find((item) => `record:${item.key}` === suggestion.id) ?? null;
    this.#state = {
      ...this.#state,
      suggestionOpen: false,
      announcement: record ? `${record.title} seçildi.` : '',
    };
    this.#rebuild(this.#state.announcement);
    return record;
  }

  applyActiveSuggestion(): NormalizedSearchRecord | null {
    const suggestion = this.activeSuggestion();
    return suggestion ? this.applySuggestion(suggestion) : null;
  }

  setFilterPanelOpen(open: boolean): void {
    this.#ensureActive();
    if (open === this.#state.filterPanelOpen) return;
    this.#state = {
      ...this.#state,
      filterPanelOpen: open,
      suggestionOpen: open ? false : this.#state.suggestionOpen,
    };
    this.#rebuild();
  }

  toggleFilterPanel(): void {
    this.setFilterPanelOpen(!this.#state.filterPanelOpen);
  }

  reset(initialQuery = ''): void {
    this.#ensureActive();
    this.#state = {
      records: Object.freeze([]),
      phase: 'idle',
      filters: createGeneralSearchFilters({
        text: initialQuery,
        sort: this.#options.initialSort ?? 'relevance',
      }),
      page: 1,
      activeIndex: -1,
      errorMessage: '',
      suggestionOpen: false,
      activeSuggestionIndex: 0,
      filterPanelOpen: false,
      announcement: '',
      revision: this.#state.revision,
    };
    this.#rebuild('');
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#listeners.clear();
  }
}

export const createGeneralSearchWorkspaceController = (
  options: GeneralSearchWorkspaceControllerOptions = {},
): GeneralSearchWorkspaceController => new GeneralSearchWorkspaceController(options);
