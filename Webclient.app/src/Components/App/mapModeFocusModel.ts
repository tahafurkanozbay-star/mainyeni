import type { ExperienceMapMode } from '../../experience/experienceRuntime';

export type MapModeFocusMove = 'next' | 'previous' | 'first' | 'last';

export interface MapModeFocusSnapshot {
  readonly revision: number;
  readonly focusedMode: ExperienceMapMode;
  readonly activeMode: ExperienceMapMode;
  readonly disabled: boolean;
  readonly tabIndex2D: 0 | -1;
  readonly tabIndex3D: 0 | -1;
}

export interface MapModeFocusDiagnostics {
  readonly activeObserverCount: number;
  readonly rejectedObserverCount: number;
  readonly observerFailureCount: number;
  readonly reporterFailureCount: number;
  readonly lastObserverFailureKind: string | null;
  readonly lastReporterFailureKind: string | null;
  readonly disposed: boolean;
}

export interface MapModeFocusOptions {
  readonly initialMode?: ExperienceMapMode;
  readonly maxObservers?: number;
  readonly onObserverError?: (error: unknown) => void;
}

type Listener = () => void;

const DEFAULT_MAX_OBSERVERS = 16;
const MAX_OBSERVERS_LIMIT = 48;

const clampInteger = (value: number | undefined, fallback: number, min: number, max: number): number => {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(value ?? fallback)));
};

const classifyFailure = (error: unknown): string => {
  if (error instanceof Error) return error.name || 'Error';
  if (error === null) return 'null';
  return typeof error;
};

const createSnapshot = (
  revision: number,
  focusedMode: ExperienceMapMode,
  activeMode: ExperienceMapMode,
  disabled: boolean,
): MapModeFocusSnapshot => Object.freeze({
  revision,
  focusedMode,
  activeMode,
  disabled,
  tabIndex2D: focusedMode === '2d' ? 0 : -1,
  tabIndex3D: focusedMode === '3d' ? 0 : -1,
});

export class MapModeFocusModel {
  readonly #listeners = new Set<Listener>();
  readonly #maxObservers: number;
  readonly #onObserverError?: (error: unknown) => void;
  #snapshot: MapModeFocusSnapshot;
  #diagnostics: MapModeFocusDiagnostics;
  #disposed = false;

  constructor(options: MapModeFocusOptions = {}) {
    const initialMode = options.initialMode === '3d' ? '3d' : '2d';
    this.#maxObservers = clampInteger(options.maxObservers, DEFAULT_MAX_OBSERVERS, 1, MAX_OBSERVERS_LIMIT);
    this.#onObserverError = options.onObserverError;
    this.#snapshot = createSnapshot(0, initialMode, initialMode, false);
    this.#diagnostics = Object.freeze({
      activeObserverCount: 0,
      rejectedObserverCount: 0,
      observerFailureCount: 0,
      reporterFailureCount: 0,
      lastObserverFailureKind: null,
      lastReporterFailureKind: null,
      disposed: false,
    });
  }

  readonly getSnapshot = (): MapModeFocusSnapshot => this.#snapshot;

  readonly getDiagnostics = (): MapModeFocusDiagnostics => this.#diagnostics;

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

  sync(activeMode: ExperienceMapMode, disabled: boolean): void {
    if (this.#disposed) return;
    const nextFocused = activeMode !== this.#snapshot.activeMode
      ? activeMode
      : this.#snapshot.focusedMode;
    if (
      activeMode === this.#snapshot.activeMode
      && disabled === this.#snapshot.disabled
      && nextFocused === this.#snapshot.focusedMode
    ) return;
    this.#emit(createSnapshot(
      this.#snapshot.revision + 1,
      nextFocused,
      activeMode,
      disabled,
    ));
  }

  setFocused(mode: ExperienceMapMode): void {
    if (this.#disposed || mode === this.#snapshot.focusedMode) return;
    this.#emit(createSnapshot(
      this.#snapshot.revision + 1,
      mode,
      this.#snapshot.activeMode,
      this.#snapshot.disabled,
    ));
  }

  move(move: MapModeFocusMove): ExperienceMapMode {
    if (this.#disposed || this.#snapshot.disabled) return this.#snapshot.focusedMode;
    let next = this.#snapshot.focusedMode;
    if (move === 'first') next = '2d';
    else if (move === 'last') next = '3d';
    else next = this.#snapshot.focusedMode === '2d' ? '3d' : '2d';
    this.setFocused(next);
    return next;
  }

  activateFocused(): ExperienceMapMode | null {
    if (this.#disposed || this.#snapshot.disabled) return null;
    return this.#snapshot.focusedMode;
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

  #emit(next: MapModeFocusSnapshot): void {
    if (this.#disposed || next === this.#snapshot) return;
    this.#snapshot = next;
    for (const listener of this.#listeners) {
      try {
        listener();
      } catch (error) {
        this.#recordObserverFailure(error);
      }
    }
  }

  #recordObserverFailure(error: unknown): void {
    this.#diagnostics = Object.freeze({
      ...this.#diagnostics,
      observerFailureCount: this.#diagnostics.observerFailureCount + 1,
      lastObserverFailureKind: classifyFailure(error),
    });
    if (!this.#onObserverError) return;
    try {
      this.#onObserverError(error);
    } catch (reporterError) {
      this.#diagnostics = Object.freeze({
        ...this.#diagnostics,
        reporterFailureCount: this.#diagnostics.reporterFailureCount + 1,
        lastReporterFailureKind: classifyFailure(reporterError),
      });
    }
  }

  #recordRejectedObserver(): void {
    this.#diagnostics = Object.freeze({
      ...this.#diagnostics,
      rejectedObserverCount: this.#diagnostics.rejectedObserverCount + 1,
    });
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
}
