import type { ExperienceMapMode, ExperienceViewport } from '../../experience/experienceRuntime';

export type MapModeExperiencePhase = 'ready' | 'requesting' | 'error';
export type MapModeExperienceErrorKind = 'timeout' | 'runtime-recovery' | 'dispatch-rejected' | 'unknown';

export interface MapModeExperienceEnvironment {
  readonly viewport: ExperienceViewport;
  readonly reducedMotion: boolean;
  readonly forcedColors: boolean;
  readonly coarsePointer: boolean;
}

export interface MapModeExperienceSnapshot {
  readonly revision: number;
  readonly phase: MapModeExperiencePhase;
  readonly currentMode: ExperienceMapMode;
  readonly requestedMode: ExperienceMapMode | null;
  readonly requestId: number;
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly canRetry: boolean;
  readonly announcement: string;
  readonly errorKind: MapModeExperienceErrorKind | null;
  readonly transitionStartedAt: number | null;
  readonly lastTransitionMs: number | null;
  readonly lastSource: string | null;
  readonly environment: MapModeExperienceEnvironment;
}

export interface MapModeExperienceDiagnostics {
  readonly activeObserverCount: number;
  readonly rejectedObserverCount: number;
  readonly observerFailureCount: number;
  readonly reporterFailureCount: number;
  readonly lastObserverFailureKind: string | null;
  readonly lastReporterFailureKind: string | null;
  readonly disposed: boolean;
}

export interface MapModeExperienceOptions {
  readonly initialMode?: ExperienceMapMode;
  readonly maxAttempts?: number;
  readonly maxObservers?: number;
  readonly now?: () => number;
  readonly onObserverError?: (error: unknown) => void;
}

type Listener = () => void;

const DEFAULT_MAX_ATTEMPTS = 3;
const MAX_ATTEMPTS_LIMIT = 5;
const DEFAULT_MAX_OBSERVERS = 32;
const MAX_OBSERVERS_LIMIT = 96;

const DEFAULT_ENVIRONMENT: MapModeExperienceEnvironment = Object.freeze({
  viewport: 'wide',
  reducedMotion: false,
  forcedColors: false,
  coarsePointer: false,
});

const clampInteger = (value: number | undefined, fallback: number, min: number, max: number): number => {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(value ?? fallback)));
};

const safeNow = (now: () => number): number => {
  const value = now();
  return Number.isFinite(value) ? Math.max(0, value) : 0;
};

const classifyFailure = (error: unknown): string => {
  if (error instanceof Error) return error.name || 'Error';
  if (error === null) return 'null';
  return typeof error;
};

const modeLabel = (mode: ExperienceMapMode): string => mode === '3d' ? '3B' : '2B';

const readyAnnouncement = (mode: ExperienceMapMode): string => (
  mode === '3d'
    ? '3B görünüm etkin. Kamera denetimleri kullanılabilir.'
    : '2B harita görünümü etkin.'
);

const requestAnnouncement = (mode: ExperienceMapMode, attempt: number): string => (
  attempt > 1
    ? `${modeLabel(mode)} görünüm yeniden deneniyor. Deneme ${attempt}.`
    : `${modeLabel(mode)} görünüm hazırlanıyor.`
);

const errorAnnouncement = (
  target: ExperienceMapMode,
  kind: MapModeExperienceErrorKind,
  canRetry: boolean,
): string => {
  const prefix = kind === 'timeout'
    ? `${modeLabel(target)} görünüm beklenenden uzun sürdü.`
    : kind === 'runtime-recovery'
      ? `${modeLabel(target)} görünüme geçiş tamamlanamadı; mevcut görünüm korundu.`
      : kind === 'dispatch-rejected'
        ? `${modeLabel(target)} görünüm isteği çalışma alanına iletilemedi.`
        : `${modeLabel(target)} görünüm geçişi tamamlanamadı.`;
  return canRetry ? `${prefix} Yeniden deneyebilirsiniz.` : `${prefix} Yeniden deneme sınırına ulaşıldı.`;
};

const normalizeSource = (source: unknown): string | null => {
  if (typeof source !== 'string') return null;
  const normalized = source.trim().replace(/\s+/gu, ' ');
  return normalized ? normalized.slice(0, 64) : null;
};

const freezeEnvironment = (value: MapModeExperienceEnvironment): MapModeExperienceEnvironment => Object.freeze({
  viewport: value.viewport,
  reducedMotion: Boolean(value.reducedMotion),
  forcedColors: Boolean(value.forcedColors),
  coarsePointer: Boolean(value.coarsePointer),
});

const createSnapshot = (input: {
  revision: number;
  phase: MapModeExperiencePhase;
  currentMode: ExperienceMapMode;
  requestedMode: ExperienceMapMode | null;
  requestId: number;
  attempt: number;
  maxAttempts: number;
  announcement: string;
  errorKind: MapModeExperienceErrorKind | null;
  transitionStartedAt: number | null;
  lastTransitionMs: number | null;
  lastSource: string | null;
  environment: MapModeExperienceEnvironment;
}): MapModeExperienceSnapshot => Object.freeze({
  revision: input.revision,
  phase: input.phase,
  currentMode: input.currentMode,
  requestedMode: input.requestedMode,
  requestId: input.requestId,
  attempt: input.attempt,
  maxAttempts: input.maxAttempts,
  canRetry: input.phase === 'error' && input.requestedMode !== null && input.attempt < input.maxAttempts,
  announcement: input.announcement,
  errorKind: input.errorKind,
  transitionStartedAt: input.transitionStartedAt,
  lastTransitionMs: input.lastTransitionMs,
  lastSource: input.lastSource,
  environment: freezeEnvironment(input.environment),
});

export class MapModeExperienceModel {
  readonly #listeners = new Set<Listener>();
  readonly #maxAttempts: number;
  readonly #maxObservers: number;
  readonly #now: () => number;
  readonly #onObserverError?: (error: unknown) => void;
  #snapshot: MapModeExperienceSnapshot;
  #diagnostics: MapModeExperienceDiagnostics;
  #disposed = false;

  constructor(options: MapModeExperienceOptions = {}) {
    const initialMode = options.initialMode === '3d' ? '3d' : '2d';
    this.#maxAttempts = clampInteger(options.maxAttempts, DEFAULT_MAX_ATTEMPTS, 1, MAX_ATTEMPTS_LIMIT);
    this.#maxObservers = clampInteger(options.maxObservers, DEFAULT_MAX_OBSERVERS, 1, MAX_OBSERVERS_LIMIT);
    this.#now = options.now ?? Date.now;
    this.#onObserverError = options.onObserverError;
    this.#snapshot = createSnapshot({
      revision: 0,
      phase: 'ready',
      currentMode: initialMode,
      requestedMode: null,
      requestId: 0,
      attempt: 0,
      maxAttempts: this.#maxAttempts,
      announcement: readyAnnouncement(initialMode),
      errorKind: null,
      transitionStartedAt: null,
      lastTransitionMs: null,
      lastSource: 'initial',
      environment: DEFAULT_ENVIRONMENT,
    });
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

  readonly getSnapshot = (): MapModeExperienceSnapshot => this.#snapshot;

  readonly getDiagnostics = (): MapModeExperienceDiagnostics => this.#diagnostics;

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

  setEnvironment(environment: Partial<MapModeExperienceEnvironment>): void {
    if (this.#disposed) return;
    const current = this.#snapshot.environment;
    const next: MapModeExperienceEnvironment = {
      viewport: environment.viewport === 'compact' || environment.viewport === 'medium' || environment.viewport === 'wide'
        ? environment.viewport
        : current.viewport,
      reducedMotion: typeof environment.reducedMotion === 'boolean' ? environment.reducedMotion : current.reducedMotion,
      forcedColors: typeof environment.forcedColors === 'boolean' ? environment.forcedColors : current.forcedColors,
      coarsePointer: typeof environment.coarsePointer === 'boolean' ? environment.coarsePointer : current.coarsePointer,
    };
    if (
      next.viewport === current.viewport
      && next.reducedMotion === current.reducedMotion
      && next.forcedColors === current.forcedColors
      && next.coarsePointer === current.coarsePointer
    ) return;
    this.#replace({
      ...this.#snapshot,
      revision: this.#snapshot.revision + 1,
      environment: next,
    });
  }

  requestMode(mode: ExperienceMapMode): number | null {
    if (this.#disposed) return null;
    if (mode === this.#snapshot.currentMode && this.#snapshot.phase === 'ready') return null;
    if (this.#snapshot.phase === 'requesting' && this.#snapshot.requestedMode === mode) return this.#snapshot.requestId;

    const continuingSameTarget = this.#snapshot.requestedMode === mode && this.#snapshot.phase === 'error';
    const attempt = continuingSameTarget ? this.#snapshot.attempt + 1 : 1;
    if (attempt > this.#maxAttempts) return null;

    const requestId = this.#snapshot.requestId + 1;
    this.#replace(createSnapshot({
      revision: this.#snapshot.revision + 1,
      phase: 'requesting',
      currentMode: this.#snapshot.currentMode,
      requestedMode: mode,
      requestId,
      attempt,
      maxAttempts: this.#maxAttempts,
      announcement: requestAnnouncement(mode, attempt),
      errorKind: null,
      transitionStartedAt: safeNow(this.#now),
      lastTransitionMs: this.#snapshot.lastTransitionMs,
      lastSource: 'user-request',
      environment: this.#snapshot.environment,
    }));
    return requestId;
  }

  confirmMode(mode: ExperienceMapMode, source?: unknown): void {
    if (this.#disposed) return;
    const now = safeNow(this.#now);
    const requestedMode = this.#snapshot.requestedMode;
    const transitionMs = this.#snapshot.transitionStartedAt === null
      ? this.#snapshot.lastTransitionMs
      : Math.max(0, now - this.#snapshot.transitionStartedAt);
    const normalizedSource = normalizeSource(source);

    if (this.#snapshot.phase === 'requesting' && requestedMode && requestedMode !== mode) {
      this.#replace(createSnapshot({
        revision: this.#snapshot.revision + 1,
        phase: 'error',
        currentMode: mode,
        requestedMode,
        requestId: this.#snapshot.requestId,
        attempt: this.#snapshot.attempt,
        maxAttempts: this.#maxAttempts,
        announcement: errorAnnouncement(requestedMode, 'runtime-recovery', this.#snapshot.attempt < this.#maxAttempts),
        errorKind: 'runtime-recovery',
        transitionStartedAt: null,
        lastTransitionMs: transitionMs,
        lastSource: normalizedSource,
        environment: this.#snapshot.environment,
      }));
      return;
    }

    this.#replace(createSnapshot({
      revision: this.#snapshot.revision + 1,
      phase: 'ready',
      currentMode: mode,
      requestedMode: null,
      requestId: this.#snapshot.requestId,
      attempt: 0,
      maxAttempts: this.#maxAttempts,
      announcement: readyAnnouncement(mode),
      errorKind: null,
      transitionStartedAt: null,
      lastTransitionMs: transitionMs,
      lastSource: normalizedSource,
      environment: this.#snapshot.environment,
    }));
  }

  markDispatchRejected(requestId: number): void {
    this.#markFailure(requestId, 'dispatch-rejected');
  }

  markTimeout(requestId: number): void {
    this.#markFailure(requestId, 'timeout');
  }

  retry(): number | null {
    if (this.#disposed || !this.#snapshot.canRetry || this.#snapshot.requestedMode === null) return null;
    return this.requestMode(this.#snapshot.requestedMode);
  }

  cancelPending(): void {
    if (this.#disposed || this.#snapshot.phase !== 'requesting') return;
    this.#replace(createSnapshot({
      revision: this.#snapshot.revision + 1,
      phase: 'ready',
      currentMode: this.#snapshot.currentMode,
      requestedMode: null,
      requestId: this.#snapshot.requestId,
      attempt: 0,
      maxAttempts: this.#maxAttempts,
      announcement: readyAnnouncement(this.#snapshot.currentMode),
      errorKind: null,
      transitionStartedAt: null,
      lastTransitionMs: this.#snapshot.lastTransitionMs,
      lastSource: 'cancelled',
      environment: this.#snapshot.environment,
    }));
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

  #markFailure(requestId: number, kind: MapModeExperienceErrorKind): void {
    if (
      this.#disposed
      || this.#snapshot.phase !== 'requesting'
      || this.#snapshot.requestId !== requestId
      || this.#snapshot.requestedMode === null
    ) return;
    const now = safeNow(this.#now);
    const transitionMs = this.#snapshot.transitionStartedAt === null
      ? this.#snapshot.lastTransitionMs
      : Math.max(0, now - this.#snapshot.transitionStartedAt);
    const canRetry = this.#snapshot.attempt < this.#maxAttempts;
    this.#replace(createSnapshot({
      revision: this.#snapshot.revision + 1,
      phase: 'error',
      currentMode: this.#snapshot.currentMode,
      requestedMode: this.#snapshot.requestedMode,
      requestId: this.#snapshot.requestId,
      attempt: this.#snapshot.attempt,
      maxAttempts: this.#maxAttempts,
      announcement: errorAnnouncement(this.#snapshot.requestedMode, kind, canRetry),
      errorKind: kind,
      transitionStartedAt: null,
      lastTransitionMs: transitionMs,
      lastSource: kind,
      environment: this.#snapshot.environment,
    }));
  }

  #replace(next: MapModeExperienceSnapshot): void {
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
