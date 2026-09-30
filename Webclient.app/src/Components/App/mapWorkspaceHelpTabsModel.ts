export type MapWorkspaceHelpTabId = 'shortcuts' | 'guide';
export type MapWorkspaceHelpTabMove = 'next' | 'previous' | 'first' | 'last';

export interface MapWorkspaceHelpTabPresentation {
  readonly id: MapWorkspaceHelpTabId;
  readonly label: string;
  readonly selected: boolean;
  readonly tabIndex: 0 | -1;
  readonly panelHidden: boolean;
}

export interface MapWorkspaceHelpTabsSnapshot {
  readonly revision: number;
  readonly activeTab: MapWorkspaceHelpTabId;
  readonly tabs: readonly MapWorkspaceHelpTabPresentation[];
}

export interface MapWorkspaceHelpTabsDiagnostics {
  readonly activeObserverCount: number;
  readonly observerFailureCount: number;
  readonly rejectedObserverCount: number;
  readonly lastFailureRevision: number | null;
  readonly lastFailureKind: string | null;
  readonly disposed: boolean;
}

export interface MapWorkspaceHelpTabsModelOptions {
  readonly maxListeners?: number;
}

const DEFAULT_MAX_LISTENERS = 16;
const MAX_LISTENERS = 64;

const TAB_DEFINITIONS: readonly Readonly<Pick<MapWorkspaceHelpTabPresentation, 'id' | 'label'>>[] = Object.freeze([
  Object.freeze({ id: 'shortcuts', label: 'Kısayollar' }),
  Object.freeze({ id: 'guide', label: 'Çalışma rehberi' }),
]);

const clampListenerLimit = (value: number | undefined): number => {
  if (!Number.isFinite(value)) return DEFAULT_MAX_LISTENERS;
  return Math.max(1, Math.min(MAX_LISTENERS, Math.trunc(value ?? DEFAULT_MAX_LISTENERS)));
};

const classifyFailure = (error: unknown): string => {
  if (error instanceof Error) return error.name || 'Error';
  if (error === null) return 'null';
  return typeof error;
};

export const createMapWorkspaceHelpTabsSnapshot = (
  revision: number,
  activeTab: MapWorkspaceHelpTabId,
): MapWorkspaceHelpTabsSnapshot => Object.freeze({
  revision,
  activeTab,
  tabs: Object.freeze(TAB_DEFINITIONS.map((tab) => Object.freeze({
    ...tab,
    selected: tab.id === activeTab,
    tabIndex: tab.id === activeTab ? 0 : -1,
    panelHidden: tab.id !== activeTab,
  }))),
});

const createDiagnostics = (): MapWorkspaceHelpTabsDiagnostics => Object.freeze({
  activeObserverCount: 0,
  observerFailureCount: 0,
  rejectedObserverCount: 0,
  lastFailureRevision: null,
  lastFailureKind: null,
  disposed: false,
});

export class MapWorkspaceHelpTabsModel {
  readonly #listeners = new Set<() => void>();
  readonly #maxListeners: number;
  #snapshot: MapWorkspaceHelpTabsSnapshot = createMapWorkspaceHelpTabsSnapshot(0, 'shortcuts');
  #diagnostics: MapWorkspaceHelpTabsDiagnostics = createDiagnostics();
  #disposed = false;

  constructor(options: MapWorkspaceHelpTabsModelOptions = {}) {
    this.#maxListeners = clampListenerLimit(options.maxListeners);
  }

  readonly getSnapshot = (): MapWorkspaceHelpTabsSnapshot => this.#snapshot;
  readonly getDiagnostics = (): MapWorkspaceHelpTabsDiagnostics => this.#diagnostics;

  readonly subscribe = (listener: () => void): (() => void) => {
    if (this.#disposed) {
      this.#recordRejectedObserver();
      return () => undefined;
    }
    if (this.#listeners.has(listener)) return () => this.#unsubscribe(listener);
    if (this.#listeners.size >= this.#maxListeners) {
      this.#recordRejectedObserver();
      throw new Error(`MapWorkspaceHelpTabsModel listener limit exceeded (${this.#maxListeners}).`);
    }
    this.#listeners.add(listener);
    this.#refreshObserverCount();
    return () => this.#unsubscribe(listener);
  };

  select(tab: MapWorkspaceHelpTabId): void {
    if (this.#disposed || tab === this.#snapshot.activeTab) return;
    if (!TAB_DEFINITIONS.some((definition) => definition.id === tab)) return;
    this.#publish(tab);
  }

  move(move: MapWorkspaceHelpTabMove): MapWorkspaceHelpTabId {
    if (this.#disposed) return this.#snapshot.activeTab;
    const currentIndex = Math.max(0, TAB_DEFINITIONS.findIndex((tab) => tab.id === this.#snapshot.activeTab));
    let nextIndex = currentIndex;
    if (move === 'next') nextIndex = (currentIndex + 1) % TAB_DEFINITIONS.length;
    if (move === 'previous') nextIndex = (currentIndex - 1 + TAB_DEFINITIONS.length) % TAB_DEFINITIONS.length;
    if (move === 'first') nextIndex = 0;
    if (move === 'last') nextIndex = TAB_DEFINITIONS.length - 1;
    const next = TAB_DEFINITIONS[nextIndex]?.id ?? this.#snapshot.activeTab;
    this.select(next);
    return next;
  }

  reset(): void {
    if (this.#disposed) return;
    if (this.#snapshot.activeTab === 'shortcuts') return;
    this.#publish('shortcuts');
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

  listenerCount(): number {
    return this.#listeners.size;
  }

  disposed(): boolean {
    return this.#disposed;
  }

  #publish(activeTab: MapWorkspaceHelpTabId): void {
    if (this.#disposed) return;
    this.#snapshot = createMapWorkspaceHelpTabsSnapshot(this.#snapshot.revision + 1, activeTab);
    for (const listener of this.#listeners) {
      try {
        listener();
      } catch (error) {
        this.#diagnostics = Object.freeze({
          ...this.#diagnostics,
          observerFailureCount: this.#diagnostics.observerFailureCount + 1,
          lastFailureRevision: this.#snapshot.revision,
          lastFailureKind: classifyFailure(error),
        });
      }
    }
  }

  #unsubscribe(listener: () => void): void {
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
