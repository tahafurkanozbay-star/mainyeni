export type MapWorkspaceShellPhase = 'booting' | 'ready' | 'updating' | 'error';
export type MapWorkspaceViewport = 'compact' | 'medium' | 'wide';
export type MapWorkspaceInputModality = 'unknown' | 'keyboard' | 'pointer' | 'touch';
export type MapWorkspaceHealthTone = 'neutral' | 'success' | 'progress' | 'danger';

export type MapWorkspaceLandmarkId =
  | 'map'
  | 'navigation'
  | 'search'
  | 'sidebar'
  | 'toolbar'
  | 'help';

export interface MapWorkspaceLandmarkDefinition {
  readonly id: MapWorkspaceLandmarkId;
  readonly targetId: string;
  readonly label: string;
  readonly shortLabel: string;
  readonly order: number;
}

export interface MapWorkspaceLandmarkSnapshot extends MapWorkspaceLandmarkDefinition {
  readonly available: boolean;
  readonly active: boolean;
}

export interface MapWorkspaceShellEnvironment {
  readonly width: number;
  readonly height: number;
  readonly coarsePointer: boolean;
  readonly reducedMotion: boolean;
  readonly forcedColors: boolean;
}

export interface MapWorkspaceShellSnapshot {
  readonly revision: number;
  readonly phase: MapWorkspaceShellPhase;
  readonly healthTone: MapWorkspaceHealthTone;
  readonly viewport: MapWorkspaceViewport;
  readonly inputModality: MapWorkspaceInputModality;
  readonly width: number;
  readonly height: number;
  readonly coarsePointer: boolean;
  readonly reducedMotion: boolean;
  readonly forcedColors: boolean;
  readonly activeLandmarkId: MapWorkspaceLandmarkId | null;
  readonly availableLandmarkCount: number;
  readonly landmarks: readonly MapWorkspaceLandmarkSnapshot[];
  readonly announcement: string;
  readonly utilityCollapsed: boolean;
}

export interface MapWorkspaceShellDiagnostics {
  readonly listenerCount: number;
  readonly rejectedListenerCount: number;
  readonly listenerFailureCount: number;
  readonly reporterFailureCount: number;
  readonly lastFailureKind: string | null;
  readonly lastFailureRevision: number | null;
  readonly disposed: boolean;
}

export interface MapWorkspaceShellModelOptions {
  readonly listenerLimit?: number;
  readonly onListenerError?: (error: unknown) => void;
  readonly initialPhase?: MapWorkspaceShellPhase;
  readonly initialEnvironment?: Partial<MapWorkspaceShellEnvironment>;
}

type Listener = () => void;

const DEFAULT_LISTENER_LIMIT = 48;
const MAX_LISTENER_LIMIT = 128;
const COMPACT_MAX_WIDTH = 719;
const MEDIUM_MAX_WIDTH = 1199;
const MIN_DIMENSION = 1;
const MAX_DIMENSION = 20_000;

export const MAP_WORKSPACE_LANDMARKS: readonly MapWorkspaceLandmarkDefinition[] = Object.freeze([
  Object.freeze({ id: 'map', targetId: 'esri-map-container', label: 'Harita çalışma alanı', shortLabel: 'Harita', order: 0 }),
  Object.freeze({ id: 'navigation', targetId: 'mainbar', label: 'Üst gezinme', shortLabel: 'Menü', order: 1 }),
  Object.freeze({ id: 'search', targetId: 'kentrehberi-global-search', label: 'Genel arama', shortLabel: 'Ara', order: 2 }),
  Object.freeze({ id: 'sidebar', targetId: 'sidebar', label: 'Katman ve hizmet menüsü', shortLabel: 'Katmanlar', order: 3 }),
  Object.freeze({ id: 'toolbar', targetId: 'toolbar-widget', label: 'Harita araçları', shortLabel: 'Araçlar', order: 4 }),
  Object.freeze({ id: 'help', targetId: 'map-workspace-help-launcher', label: 'Çalışma alanı yardımı', shortLabel: 'Yardım', order: 5 }),
]);

const clampInteger = (value: number, fallback: number): number => {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(MAX_DIMENSION, Math.max(MIN_DIMENSION, Math.trunc(value)));
};

const clampListenerLimit = (value: number | undefined): number => {
  if (!Number.isFinite(value)) return DEFAULT_LISTENER_LIMIT;
  return Math.min(MAX_LISTENER_LIMIT, Math.max(1, Math.trunc(value ?? DEFAULT_LISTENER_LIMIT)));
};

export const classifyMapWorkspaceViewport = (width: number): MapWorkspaceViewport => {
  if (width <= COMPACT_MAX_WIDTH) return 'compact';
  if (width <= MEDIUM_MAX_WIDTH) return 'medium';
  return 'wide';
};

const healthToneForPhase = (phase: MapWorkspaceShellPhase): MapWorkspaceHealthTone => {
  switch (phase) {
    case 'booting': return 'neutral';
    case 'ready': return 'success';
    case 'updating': return 'progress';
    case 'error': return 'danger';
  }
};

const announcementForPhase = (
  phase: MapWorkspaceShellPhase,
  availableLandmarkCount: number,
): string => {
  switch (phase) {
    case 'booting': return 'Harita çalışma alanı hazırlanıyor.';
    case 'ready': return `Harita çalışma alanı hazır. ${availableLandmarkCount} hızlı gezinme hedefi kullanılabilir.`;
    case 'updating': return 'Harita görünümü güncelleniyor. Kontroller kullanılabilir durumda kalır.';
    case 'error': return 'Harita çalışma alanında bir sorun oluştu. Sayfa kontrolleri ve yardım seçenekleri kullanılabilir.';
  }
};

const failureKind = (error: unknown): string => {
  if (error instanceof Error) return error.name || 'Error';
  if (error === null) return 'null';
  return typeof error;
};

const createLandmarks = (
  availability: ReadonlyMap<MapWorkspaceLandmarkId, boolean>,
  activeId: MapWorkspaceLandmarkId | null,
): readonly MapWorkspaceLandmarkSnapshot[] => Object.freeze(
  MAP_WORKSPACE_LANDMARKS.map((definition) => Object.freeze({
    ...definition,
    available: availability.get(definition.id) === true,
    active: definition.id === activeId,
  })),
);

const createSnapshot = (
  revision: number,
  phase: MapWorkspaceShellPhase,
  environment: MapWorkspaceShellEnvironment,
  inputModality: MapWorkspaceInputModality,
  activeLandmarkId: MapWorkspaceLandmarkId | null,
  availability: ReadonlyMap<MapWorkspaceLandmarkId, boolean>,
  utilityCollapsed: boolean,
): MapWorkspaceShellSnapshot => {
  const landmarks = createLandmarks(availability, activeLandmarkId);
  const availableLandmarkCount = landmarks.reduce((count, landmark) => count + (landmark.available ? 1 : 0), 0);
  return Object.freeze({
    revision,
    phase,
    healthTone: healthToneForPhase(phase),
    viewport: classifyMapWorkspaceViewport(environment.width),
    inputModality,
    width: environment.width,
    height: environment.height,
    coarsePointer: environment.coarsePointer,
    reducedMotion: environment.reducedMotion,
    forcedColors: environment.forcedColors,
    activeLandmarkId,
    availableLandmarkCount,
    landmarks,
    announcement: announcementForPhase(phase, availableLandmarkCount),
    utilityCollapsed,
  });
};

const environmentsEqual = (a: MapWorkspaceShellEnvironment, b: MapWorkspaceShellEnvironment): boolean => (
  a.width === b.width
  && a.height === b.height
  && a.coarsePointer === b.coarsePointer
  && a.reducedMotion === b.reducedMotion
  && a.forcedColors === b.forcedColors
);

const createInitialEnvironment = (
  environment: Partial<MapWorkspaceShellEnvironment> | undefined,
): MapWorkspaceShellEnvironment => Object.freeze({
  width: clampInteger(environment?.width ?? 1280, 1280),
  height: clampInteger(environment?.height ?? 720, 720),
  coarsePointer: environment?.coarsePointer === true,
  reducedMotion: environment?.reducedMotion === true,
  forcedColors: environment?.forcedColors === true,
});

export class MapWorkspaceShellModel {
  readonly #listeners = new Set<Listener>();
  readonly #availability = new Map<MapWorkspaceLandmarkId, boolean>();
  readonly #listenerLimit: number;
  readonly #onListenerError?: (error: unknown) => void;
  #environment: MapWorkspaceShellEnvironment;
  #snapshot: MapWorkspaceShellSnapshot;
  #disposed = false;
  #rejectedListenerCount = 0;
  #listenerFailureCount = 0;
  #reporterFailureCount = 0;
  #lastFailureKind: string | null = null;
  #lastFailureRevision: number | null = null;

  constructor(options: MapWorkspaceShellModelOptions = {}) {
    this.#listenerLimit = clampListenerLimit(options.listenerLimit);
    this.#onListenerError = options.onListenerError;
    this.#environment = createInitialEnvironment(options.initialEnvironment);
    for (const landmark of MAP_WORKSPACE_LANDMARKS) this.#availability.set(landmark.id, false);
    this.#snapshot = createSnapshot(
      0,
      options.initialPhase ?? 'booting',
      this.#environment,
      'unknown',
      null,
      this.#availability,
      false,
    );
  }

  readonly getSnapshot = (): MapWorkspaceShellSnapshot => this.#snapshot;

  readonly getDiagnostics = (): MapWorkspaceShellDiagnostics => Object.freeze({
    listenerCount: this.#listeners.size,
    rejectedListenerCount: this.#rejectedListenerCount,
    listenerFailureCount: this.#listenerFailureCount,
    reporterFailureCount: this.#reporterFailureCount,
    lastFailureKind: this.#lastFailureKind,
    lastFailureRevision: this.#lastFailureRevision,
    disposed: this.#disposed,
  });

  readonly subscribe = (listener: Listener): (() => void) => {
    if (this.#disposed) {
      this.#rejectedListenerCount += 1;
      return () => undefined;
    }
    if (this.#listeners.has(listener)) return () => this.#listeners.delete(listener);
    if (this.#listeners.size >= this.#listenerLimit) {
      this.#rejectedListenerCount += 1;
      return () => undefined;
    }
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  setPhase(phase: MapWorkspaceShellPhase): void {
    if (this.#disposed || phase === this.#snapshot.phase) return;
    this.#publish({ phase });
  }

  setEnvironment(environment: MapWorkspaceShellEnvironment): void {
    if (this.#disposed) return;
    const next = Object.freeze({
      width: clampInteger(environment.width, this.#environment.width),
      height: clampInteger(environment.height, this.#environment.height),
      coarsePointer: environment.coarsePointer === true,
      reducedMotion: environment.reducedMotion === true,
      forcedColors: environment.forcedColors === true,
    });
    if (environmentsEqual(this.#environment, next)) return;
    this.#environment = next;
    this.#publish({});
  }

  setInputModality(modality: MapWorkspaceInputModality): void {
    if (this.#disposed || modality === this.#snapshot.inputModality) return;
    this.#publish({ inputModality: modality });
  }

  setActiveLandmark(id: MapWorkspaceLandmarkId | null): void {
    if (this.#disposed || id === this.#snapshot.activeLandmarkId) return;
    if (id !== null && this.#availability.get(id) !== true) return;
    this.#publish({ activeLandmarkId: id });
  }

  setLandmarkAvailability(id: MapWorkspaceLandmarkId, available: boolean): void {
    if (this.#disposed || this.#availability.get(id) === available) return;
    this.#availability.set(id, available);
    const activeLandmarkId = !available && this.#snapshot.activeLandmarkId === id
      ? null
      : this.#snapshot.activeLandmarkId;
    this.#publish({ activeLandmarkId });
  }

  setAllLandmarkAvailability(values: ReadonlyMap<MapWorkspaceLandmarkId, boolean>): void {
    if (this.#disposed) return;
    let changed = false;
    for (const landmark of MAP_WORKSPACE_LANDMARKS) {
      const available = values.get(landmark.id) === true;
      if (this.#availability.get(landmark.id) === available) continue;
      this.#availability.set(landmark.id, available);
      changed = true;
    }
    if (!changed) return;
    const activeId = this.#snapshot.activeLandmarkId;
    this.#publish({ activeLandmarkId: activeId && this.#availability.get(activeId) ? activeId : null });
  }

  setUtilityCollapsed(collapsed: boolean): void {
    if (this.#disposed || collapsed === this.#snapshot.utilityCollapsed) return;
    this.#publish({ utilityCollapsed: collapsed });
  }

  toggleUtilityCollapsed(): void {
    this.setUtilityCollapsed(!this.#snapshot.utilityCollapsed);
  }

  resetInteractionState(): void {
    if (this.#disposed) return;
    this.#publish({ inputModality: 'unknown', activeLandmarkId: null, utilityCollapsed: false });
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#listeners.clear();
  }

  #recordListenerFailure(error: unknown): void {
    this.#listenerFailureCount += 1;
    this.#lastFailureKind = failureKind(error);
    this.#lastFailureRevision = this.#snapshot.revision;
    if (!this.#onListenerError) return;
    try {
      this.#onListenerError(error);
    } catch (reporterError) {
      this.#reporterFailureCount += 1;
      this.#lastFailureKind = `reporter:${failureKind(reporterError)}`;
    }
  }

  #publish(overrides: Partial<Pick<MapWorkspaceShellSnapshot,
    'phase' | 'inputModality' | 'activeLandmarkId' | 'utilityCollapsed'>>): void {
    const phase = overrides.phase ?? this.#snapshot.phase;
    const inputModality = overrides.inputModality ?? this.#snapshot.inputModality;
    const activeLandmarkId = overrides.activeLandmarkId === undefined
      ? this.#snapshot.activeLandmarkId
      : overrides.activeLandmarkId;
    const utilityCollapsed = overrides.utilityCollapsed ?? this.#snapshot.utilityCollapsed;

    this.#snapshot = createSnapshot(
      this.#snapshot.revision + 1,
      phase,
      this.#environment,
      inputModality,
      activeLandmarkId,
      this.#availability,
      utilityCollapsed,
    );

    for (const listener of this.#listeners) {
      try {
        listener();
      } catch (error) {
        this.#recordListenerFailure(error);
      }
    }
  }
}
