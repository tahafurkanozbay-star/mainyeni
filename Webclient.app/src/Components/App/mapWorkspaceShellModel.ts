export type MapWorkspaceShellPhase = 'booting' | 'ready' | 'updating' | 'error';
export type MapWorkspaceShellModality = 'keyboard' | 'pointer' | 'touch' | 'unknown';
export type MapWorkspaceShellRegionId = 'navigation' | 'map' | 'sidebar' | 'toolbar' | 'workspace' | 'help';
export type MapWorkspaceShellTone = 'neutral' | 'info' | 'warning' | 'danger' | 'success';

export interface MapWorkspaceShellRegionDefinition {
  readonly id: MapWorkspaceShellRegionId;
  readonly label: string;
  readonly shortLabel: string;
  readonly selector: string;
  readonly order: number;
}

export interface MapWorkspaceShellRegionState extends MapWorkspaceShellRegionDefinition {
  readonly available: boolean;
  readonly active: boolean;
  readonly lastFocusedRevision: number | null;
}

export interface MapWorkspaceShellSnapshot {
  readonly revision: number;
  readonly phase: MapWorkspaceShellPhase;
  readonly modality: MapWorkspaceShellModality;
  readonly activeRegion: MapWorkspaceShellRegionId | null;
  readonly availableRegionIds: readonly MapWorkspaceShellRegionId[];
  readonly regions: readonly MapWorkspaceShellRegionState[];
  readonly cycleCount: number;
  readonly retryAttempt: number;
  readonly maxRetries: number;
  readonly canRetry: boolean;
  readonly announcement: string;
  readonly visualMessage: string;
  readonly tone: MapWorkspaceShellTone;
  readonly busy: boolean;
}

export interface MapWorkspaceShellObserverDiagnostics {
  readonly activeObserverCount: number;
  readonly rejectedObserverCount: number;
  readonly failureCount: number;
  readonly reporterFailureCount: number;
  readonly lastFailureRevision: number | null;
  readonly lastFailureKind: string | null;
  readonly disposed: boolean;
}

export interface MapWorkspaceShellModelOptions {
  readonly maxObservers?: number;
  readonly maxRetries?: number;
  readonly onObserverError?: (error: unknown) => void;
}

const DEFAULT_MAX_OBSERVERS = 32;
const MAX_OBSERVERS_LIMIT = 96;
const DEFAULT_MAX_RETRIES = 3;
const MAX_RETRIES_LIMIT = 6;

export const MAP_WORKSPACE_SHELL_REGIONS: readonly MapWorkspaceShellRegionDefinition[] = Object.freeze([
  Object.freeze({
    id: 'navigation',
    label: 'Ana navigasyon',
    shortLabel: 'Navigasyon',
    selector: '.mainbar-container, header[role="banner"], #mainbar',
    order: 10,
  }),
  Object.freeze({
    id: 'map',
    label: 'Ana harita',
    shortLabel: 'Harita',
    selector: '#esri-map-container',
    order: 20,
  }),
  Object.freeze({
    id: 'sidebar',
    label: 'Katman ve hizmet paneli',
    shortLabel: 'Panel',
    selector: '#sidebar, .sidebar-container, .sidebar-container1',
    order: 30,
  }),
  Object.freeze({
    id: 'toolbar',
    label: 'Harita araç çubuğu',
    shortLabel: 'Araçlar',
    selector: '#toolbar-widget, [aria-label="Harita araçları"]',
    order: 40,
  }),
  Object.freeze({
    id: 'workspace',
    label: 'Çalışma alanı kontrolleri',
    shortLabel: 'Görünüm',
    selector: '#experience-workspace-controls',
    order: 50,
  }),
  Object.freeze({
    id: 'help',
    label: 'Kısayol ve çalışma alanı yardımı',
    shortLabel: 'Yardım',
    selector: '.map-shortcut-help__launcher',
    order: 60,
  }),
]);

const clampInteger = (value: number | undefined, fallback: number, min: number, max: number): number => {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(value ?? fallback)));
};

const classifyFailure = (error: unknown): string => {
  if (error instanceof Error) return error.name || 'Error';
  if (error === null) return 'null';
  return typeof error;
};

const phasePresentation = (
  phase: MapWorkspaceShellPhase,
  retryAttempt: number,
  maxRetries: number,
): Pick<MapWorkspaceShellSnapshot, 'announcement' | 'visualMessage' | 'tone' | 'busy' | 'canRetry'> => {
  switch (phase) {
    case 'booting':
      return {
        announcement: retryAttempt > 0
          ? `Harita çalışma alanı yeniden hazırlanıyor. Deneme ${retryAttempt}/${maxRetries}.`
          : 'Harita çalışma alanı hazırlanıyor.',
        visualMessage: retryAttempt > 0 ? 'Harita yeniden hazırlanıyor' : 'Harita hazırlanıyor',
        tone: 'info',
        busy: true,
        canRetry: false,
      };
    case 'updating':
      return {
        announcement: 'Harita görünümü güncelleniyor.',
        visualMessage: 'Harita güncelleniyor',
        tone: 'info',
        busy: true,
        canRetry: false,
      };
    case 'error':
      return {
        announcement: retryAttempt >= maxRetries
          ? 'Harita çalışma alanı hazırlanamadı. Yeniden deneme sınırına ulaşıldı.'
          : 'Harita çalışma alanı hazırlanamadı. Yeniden deneyebilirsiniz.',
        visualMessage: retryAttempt >= maxRetries ? 'Harita kullanılamıyor' : 'Harita yüklenemedi',
        tone: 'danger',
        busy: false,
        canRetry: retryAttempt < maxRetries,
      };
    case 'ready':
    default:
      return {
        announcement: 'Harita çalışma alanı kullanıma hazır.',
        visualMessage: 'Harita hazır',
        tone: 'success',
        busy: false,
        canRetry: false,
      };
  }
};

const normalizeAvailableRegionIds = (
  ids: readonly MapWorkspaceShellRegionId[],
): readonly MapWorkspaceShellRegionId[] => {
  const allowed = new Set<MapWorkspaceShellRegionId>(MAP_WORKSPACE_SHELL_REGIONS.map((region) => region.id));
  const seen = new Set<MapWorkspaceShellRegionId>();
  const output: MapWorkspaceShellRegionId[] = [];
  for (const id of ids) {
    if (!allowed.has(id) || seen.has(id)) continue;
    seen.add(id);
    output.push(id);
  }
  output.sort((left, right) => {
    const leftOrder = MAP_WORKSPACE_SHELL_REGIONS.find((region) => region.id === left)?.order ?? 0;
    const rightOrder = MAP_WORKSPACE_SHELL_REGIONS.find((region) => region.id === right)?.order ?? 0;
    return leftOrder - rightOrder;
  });
  return Object.freeze(output);
};

const buildRegions = (
  availableRegionIds: readonly MapWorkspaceShellRegionId[],
  activeRegion: MapWorkspaceShellRegionId | null,
  focusRevisions: ReadonlyMap<MapWorkspaceShellRegionId, number>,
): readonly MapWorkspaceShellRegionState[] => {
  const available = new Set(availableRegionIds);
  return Object.freeze(MAP_WORKSPACE_SHELL_REGIONS.map((definition) => Object.freeze({
    ...definition,
    available: available.has(definition.id),
    active: definition.id === activeRegion,
    lastFocusedRevision: focusRevisions.get(definition.id) ?? null,
  })));
};

const sameRegionIds = (
  left: readonly MapWorkspaceShellRegionId[],
  right: readonly MapWorkspaceShellRegionId[],
): boolean => left.length === right.length && left.every((value, index) => value === right[index]);

const createDiagnostics = (): MapWorkspaceShellObserverDiagnostics => Object.freeze({
  activeObserverCount: 0,
  rejectedObserverCount: 0,
  failureCount: 0,
  reporterFailureCount: 0,
  lastFailureRevision: null,
  lastFailureKind: null,
  disposed: false,
});

export class MapWorkspaceShellModel {
  readonly #listeners = new Set<() => void>();
  readonly #maxObservers: number;
  readonly #maxRetries: number;
  readonly #onObserverError: ((error: unknown) => void) | undefined;
  readonly #focusRevisions = new Map<MapWorkspaceShellRegionId, number>();
  #availableRegionIds: readonly MapWorkspaceShellRegionId[] = Object.freeze([]);
  #activeRegion: MapWorkspaceShellRegionId | null = null;
  #phase: MapWorkspaceShellPhase = 'booting';
  #modality: MapWorkspaceShellModality = 'unknown';
  #cycleCount = 0;
  #retryAttempt = 0;
  #revision = 0;
  #disposed = false;
  #diagnostics: MapWorkspaceShellObserverDiagnostics = createDiagnostics();
  #snapshot: MapWorkspaceShellSnapshot;

  constructor(options: MapWorkspaceShellModelOptions = {}) {
    this.#maxObservers = clampInteger(options.maxObservers, DEFAULT_MAX_OBSERVERS, 1, MAX_OBSERVERS_LIMIT);
    this.#maxRetries = clampInteger(options.maxRetries, DEFAULT_MAX_RETRIES, 1, MAX_RETRIES_LIMIT);
    this.#onObserverError = options.onObserverError;
    this.#snapshot = this.#createSnapshot();
  }

  readonly getSnapshot = (): MapWorkspaceShellSnapshot => this.#snapshot;
  readonly getObserverDiagnostics = (): MapWorkspaceShellObserverDiagnostics => this.#diagnostics;

  readonly subscribe = (listener: () => void): (() => void) => {
    if (this.#disposed) {
      this.#recordRejectedObserver();
      return () => undefined;
    }
    if (this.#listeners.has(listener)) return () => this.#unsubscribe(listener);
    if (this.#listeners.size >= this.#maxObservers) {
      this.#recordRejectedObserver();
      throw new Error(`MapWorkspaceShellModel observer limit exceeded (${this.#maxObservers}).`);
    }
    this.#listeners.add(listener);
    this.#refreshObserverCount();
    return () => this.#unsubscribe(listener);
  };

  setPhase(phase: MapWorkspaceShellPhase): void {
    if (this.#disposed || phase === this.#phase) return;
    this.#phase = phase;
    if (phase === 'ready') this.#retryAttempt = 0;
    this.#publish();
  }

  setAvailableRegions(ids: readonly MapWorkspaceShellRegionId[]): void {
    if (this.#disposed) return;
    const normalized = normalizeAvailableRegionIds(ids);
    if (sameRegionIds(normalized, this.#availableRegionIds)) return;
    this.#availableRegionIds = normalized;
    if (this.#activeRegion && !normalized.includes(this.#activeRegion)) this.#activeRegion = null;
    this.#publish();
  }

  setActiveRegion(id: MapWorkspaceShellRegionId | null): void {
    if (this.#disposed || id === this.#activeRegion) return;
    if (id !== null && !this.#availableRegionIds.includes(id)) return;
    this.#activeRegion = id;
    if (id) this.#focusRevisions.set(id, this.#revision + 1);
    this.#publish();
  }

  setModality(modality: MapWorkspaceShellModality): void {
    if (this.#disposed || modality === this.#modality) return;
    this.#modality = modality;
    this.#publish();
  }

  recordRegionCycle(id: MapWorkspaceShellRegionId): void {
    if (this.#disposed || !this.#availableRegionIds.includes(id)) return;
    this.#cycleCount += 1;
    this.#activeRegion = id;
    this.#modality = 'keyboard';
    this.#focusRevisions.set(id, this.#revision + 1);
    this.#publish();
  }

  requestRetry(): boolean {
    if (this.#disposed || this.#phase !== 'error' || this.#retryAttempt >= this.#maxRetries) return false;
    this.#retryAttempt += 1;
    this.#phase = 'booting';
    this.#publish();
    return true;
  }

  markRetryFailed(): void {
    if (this.#disposed) return;
    this.#phase = 'error';
    this.#publish();
  }

  nextRegion(current: MapWorkspaceShellRegionId | null, reverse = false): MapWorkspaceShellRegionId | null {
    const available = this.#availableRegionIds;
    if (available.length === 0) return null;
    const currentIndex = current ? available.indexOf(current) : -1;
    if (currentIndex < 0) return reverse ? available[available.length - 1] ?? null : available[0] ?? null;
    const offset = reverse ? -1 : 1;
    const nextIndex = (currentIndex + offset + available.length) % available.length;
    return available[nextIndex] ?? null;
  }

  resetInteraction(): void {
    if (this.#disposed) return;
    this.#activeRegion = null;
    this.#modality = 'unknown';
    this.#cycleCount = 0;
    this.#focusRevisions.clear();
    this.#publish();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#listeners.clear();
    this.#availableRegionIds = Object.freeze([]);
    this.#activeRegion = null;
    this.#focusRevisions.clear();
    this.#diagnostics = Object.freeze({
      ...this.#diagnostics,
      activeObserverCount: 0,
      disposed: true,
    });
  }

  disposed(): boolean {
    return this.#disposed;
  }

  #createSnapshot(): MapWorkspaceShellSnapshot {
    const presentation = phasePresentation(this.#phase, this.#retryAttempt, this.#maxRetries);
    return Object.freeze({
      revision: this.#revision,
      phase: this.#phase,
      modality: this.#modality,
      activeRegion: this.#activeRegion,
      availableRegionIds: this.#availableRegionIds,
      regions: buildRegions(this.#availableRegionIds, this.#activeRegion, this.#focusRevisions),
      cycleCount: this.#cycleCount,
      retryAttempt: this.#retryAttempt,
      maxRetries: this.#maxRetries,
      ...presentation,
    });
  }

  #publish(): void {
    this.#revision += 1;
    this.#snapshot = this.#createSnapshot();
    for (const listener of this.#listeners) {
      try {
        listener();
      } catch (error) {
        this.#reportObserverFailure(error);
      }
    }
  }

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

  #recordObserverFailure(error: unknown, reporterFailure: boolean): void {
    this.#diagnostics = Object.freeze({
      ...this.#diagnostics,
      failureCount: this.#diagnostics.failureCount + 1,
      reporterFailureCount: this.#diagnostics.reporterFailureCount + (reporterFailure ? 1 : 0),
      lastFailureRevision: this.#snapshot.revision,
      lastFailureKind: classifyFailure(error),
    });
  }

  #reportObserverFailure(error: unknown): void {
    this.#recordObserverFailure(error, false);
    if (!this.#onObserverError) return;
    try {
      this.#onObserverError(error);
    } catch (reporterError) {
      this.#recordObserverFailure(reporterError, true);
    }
  }
}

export const createMapWorkspaceShellModel = (
  options: MapWorkspaceShellModelOptions = {},
): MapWorkspaceShellModel => new MapWorkspaceShellModel(options);
