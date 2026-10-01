import {
  EXPERIENCE_STORAGE_KEY,
  mergeExperiencePreferences,
  normalizeExperiencePreferences,
  parseExperiencePreferences,
  serializeExperiencePreferences,
  type ExperienceMapMode,
  type ExperiencePreferences,
  type StorageLike,
} from '../../experience/experienceRuntime';

export type MapModePreferencePhase = 'idle' | 'restore-pending' | 'synchronized' | 'storage-unavailable' | 'write-failed';

export interface MapModePreferenceSnapshot {
  readonly revision: number;
  readonly phase: MapModePreferencePhase;
  readonly preferredMode: ExperienceMapMode;
  readonly runtimeMode: ExperienceMapMode | null;
  readonly restoreTarget: ExperienceMapMode | null;
  readonly restoreAttempted: boolean;
  readonly readFailureCount: number;
  readonly writeFailureCount: number;
  readonly successfulWriteCount: number;
  readonly announcement: string;
}

export interface MapModePreferenceDiagnostics {
  readonly listenerCount: number;
  readonly rejectedListenerCount: number;
  readonly listenerFailureCount: number;
  readonly runtimeEventCount: number;
  readonly restoreRequestCount: number;
  readonly duplicateWriteCount: number;
  readonly disposed: boolean;
}

export interface MapModePreferenceModelOptions {
  readonly maxListeners?: number;
}

type Listener = () => void;

const DEFAULT_MAX_LISTENERS = 16;
const MAX_LISTENERS = 64;

const clampListeners = (value: number | undefined): number => {
  if (!Number.isFinite(value)) return DEFAULT_MAX_LISTENERS;
  return Math.max(1, Math.min(MAX_LISTENERS, Math.trunc(value ?? DEFAULT_MAX_LISTENERS)));
};

const modeLabel = (mode: ExperienceMapMode): string => mode === '3d' ? '3B' : '2B';

const announcementFor = (
  phase: MapModePreferencePhase,
  preferredMode: ExperienceMapMode,
  runtimeMode: ExperienceMapMode | null,
): string => {
  if (phase === 'restore-pending') return `Son kullanılan ${modeLabel(preferredMode)} görünüm geri yükleniyor.`;
  if (phase === 'synchronized' && runtimeMode) return `${modeLabel(runtimeMode)} görünüm tercihi eşitlendi.`;
  if (phase === 'write-failed') return 'Görünüm tercihi bu oturumda saklanamadı.';
  if (phase === 'storage-unavailable') return 'Görünüm tercihi kalıcı depolama olmadan kullanılacak.';
  return `${modeLabel(preferredMode)} görünüm tercihi hazır.`;
};

const createSnapshot = (input: Omit<MapModePreferenceSnapshot, 'announcement'>): MapModePreferenceSnapshot => Object.freeze({
  ...input,
  announcement: announcementFor(input.phase, input.preferredMode, input.runtimeMode),
});

const initialSnapshot = (): MapModePreferenceSnapshot => createSnapshot({
  revision: 0,
  phase: 'idle',
  preferredMode: '2d',
  runtimeMode: null,
  restoreTarget: null,
  restoreAttempted: false,
  readFailureCount: 0,
  writeFailureCount: 0,
  successfulWriteCount: 0,
});

export class MapModePreferenceModel {
  readonly #listeners = new Set<Listener>();
  readonly #maxListeners: number;
  #snapshot = initialSnapshot();
  #preferences: ExperiencePreferences = normalizeExperiencePreferences(null);
  #diagnostics: MapModePreferenceDiagnostics = Object.freeze({
    listenerCount: 0,
    rejectedListenerCount: 0,
    listenerFailureCount: 0,
    runtimeEventCount: 0,
    restoreRequestCount: 0,
    duplicateWriteCount: 0,
    disposed: false,
  });
  #disposed = false;

  constructor(options: MapModePreferenceModelOptions = {}) {
    this.#maxListeners = clampListeners(options.maxListeners);
  }

  readonly getSnapshot = (): MapModePreferenceSnapshot => this.#snapshot;
  readonly getDiagnostics = (): MapModePreferenceDiagnostics => this.#diagnostics;

  readonly subscribe = (listener: Listener): (() => void) => {
    if (this.#disposed) {
      this.#patchDiagnostics({ rejectedListenerCount: this.#diagnostics.rejectedListenerCount + 1 });
      return () => undefined;
    }
    if (this.#listeners.has(listener)) return () => this.#unsubscribe(listener);
    if (this.#listeners.size >= this.#maxListeners) {
      this.#patchDiagnostics({ rejectedListenerCount: this.#diagnostics.rejectedListenerCount + 1 });
      return () => undefined;
    }
    this.#listeners.add(listener);
    this.#patchDiagnostics({ listenerCount: this.#listeners.size });
    return () => this.#unsubscribe(listener);
  };

  hydrate(storage: StorageLike | null | undefined): MapModePreferenceSnapshot {
    if (this.#disposed) return this.#snapshot;
    if (!storage) {
      this.#replace({ phase: 'storage-unavailable' });
      return this.#snapshot;
    }

    try {
      this.#preferences = parseExperiencePreferences(storage.getItem(EXPERIENCE_STORAGE_KEY));
      this.#replace({
        phase: 'idle',
        preferredMode: this.#preferences.lastMapMode,
      });
    } catch {
      this.#preferences = normalizeExperiencePreferences(null);
      this.#replace({
        phase: 'storage-unavailable',
        preferredMode: this.#preferences.lastMapMode,
        readFailureCount: this.#snapshot.readFailureCount + 1,
      });
    }
    return this.#snapshot;
  }

  observeRuntimeMode(
    mode: ExperienceMapMode,
    source: string | null | undefined,
    storage: StorageLike | null | undefined,
  ): ExperienceMapMode | null {
    if (this.#disposed) return null;
    this.#patchDiagnostics({ runtimeEventCount: this.#diagnostics.runtimeEventCount + 1 });

    if (
      source === 'map-runtime-ready'
      && !this.#snapshot.restoreAttempted
      && this.#snapshot.preferredMode !== mode
    ) {
      const target = this.#snapshot.preferredMode;
      this.#replace({
        phase: 'restore-pending',
        runtimeMode: mode,
        restoreTarget: target,
        restoreAttempted: true,
      });
      this.#patchDiagnostics({ restoreRequestCount: this.#diagnostics.restoreRequestCount + 1 });
      return target;
    }

    this.#persist(mode, storage);
    return null;
  }

  markRestoreRequested(target: ExperienceMapMode): void {
    if (this.#disposed) return;
    this.#replace({
      phase: 'restore-pending',
      restoreTarget: target,
      restoreAttempted: true,
    });
  }

  resetRestoreGuard(): void {
    if (this.#disposed) return;
    this.#replace({ restoreAttempted: false, restoreTarget: null });
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#listeners.clear();
    this.#patchDiagnostics({ listenerCount: 0, disposed: true });
  }

  #persist(mode: ExperienceMapMode, storage: StorageLike | null | undefined): void {
    if (this.#snapshot.preferredMode === mode && this.#snapshot.runtimeMode === mode && this.#snapshot.phase === 'synchronized') {
      this.#patchDiagnostics({ duplicateWriteCount: this.#diagnostics.duplicateWriteCount + 1 });
      return;
    }

    this.#preferences = mergeExperiencePreferences(this.#preferences, { lastMapMode: mode });
    if (!storage) {
      this.#replace({
        phase: 'storage-unavailable',
        preferredMode: mode,
        runtimeMode: mode,
        restoreTarget: null,
      });
      return;
    }

    try {
      storage.setItem(EXPERIENCE_STORAGE_KEY, serializeExperiencePreferences(this.#preferences));
      this.#replace({
        phase: 'synchronized',
        preferredMode: mode,
        runtimeMode: mode,
        restoreTarget: null,
        successfulWriteCount: this.#snapshot.successfulWriteCount + 1,
      });
    } catch {
      this.#replace({
        phase: 'write-failed',
        preferredMode: mode,
        runtimeMode: mode,
        restoreTarget: null,
        writeFailureCount: this.#snapshot.writeFailureCount + 1,
      });
    }
  }

  #replace(patch: Partial<MapModePreferenceSnapshot>): void {
    if (this.#disposed) return;
    const base = this.#snapshot;
    this.#snapshot = createSnapshot({
      revision: base.revision + 1,
      phase: patch.phase ?? base.phase,
      preferredMode: patch.preferredMode ?? base.preferredMode,
      runtimeMode: patch.runtimeMode === undefined ? base.runtimeMode : patch.runtimeMode,
      restoreTarget: patch.restoreTarget === undefined ? base.restoreTarget : patch.restoreTarget,
      restoreAttempted: patch.restoreAttempted ?? base.restoreAttempted,
      readFailureCount: patch.readFailureCount ?? base.readFailureCount,
      writeFailureCount: patch.writeFailureCount ?? base.writeFailureCount,
      successfulWriteCount: patch.successfulWriteCount ?? base.successfulWriteCount,
    });
    this.#notify();
  }

  #notify(): void {
    for (const listener of this.#listeners) {
      try {
        listener();
      } catch {
        this.#patchDiagnostics({ listenerFailureCount: this.#diagnostics.listenerFailureCount + 1 });
      }
    }
  }

  #unsubscribe(listener: Listener): void {
    if (!this.#listeners.delete(listener)) return;
    this.#patchDiagnostics({ listenerCount: this.#listeners.size });
  }

  #patchDiagnostics(patch: Partial<MapModePreferenceDiagnostics>): void {
    this.#diagnostics = Object.freeze({ ...this.#diagnostics, ...patch });
  }
}

export const createMapModePreferenceModel = (options: MapModePreferenceModelOptions = {}): MapModePreferenceModel => (
  new MapModePreferenceModel(options)
);
