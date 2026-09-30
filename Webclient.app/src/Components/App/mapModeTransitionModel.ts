import type { ExperienceMapMode } from '../../experience/experienceRuntime';

export type MapModeTransitionPhase = 'idle' | 'queued' | 'transitioning' | 'ready' | 'error';
export type MapModeTransitionSource = 'control' | 'command' | 'preference' | 'runtime' | 'recovery';

export interface MapModeTransitionPresentation {
  readonly minimumTargetSizePx: 44 | 48;
  readonly motionDurationMs: number;
  readonly forcedColors: boolean;
  readonly reducedMotion: boolean;
  readonly coarsePointer: boolean;
}

export interface MapModeTransitionSnapshot {
  readonly revision: number;
  readonly activeMode: ExperienceMapMode;
  readonly desiredMode: ExperienceMapMode;
  readonly phase: MapModeTransitionPhase;
  readonly busy: boolean;
  readonly queued: boolean;
  readonly canRequest2d: boolean;
  readonly canRequest3d: boolean;
  readonly requestId: number;
  readonly activeRequestId: number | null;
  readonly source: MapModeTransitionSource;
  readonly startedAtMs: number | null;
  readonly completedAtMs: number | null;
  readonly lastDurationMs: number | null;
  readonly lastErrorKind: string | null;
  readonly failureCount: number;
  readonly coalescedRequestCount: number;
  readonly supersededRequestCount: number;
  readonly announcement: string;
  readonly presentation: MapModeTransitionPresentation;
}

export interface MapModeTransitionDiagnostics {
  readonly listenerCount: number;
  readonly rejectedListenerCount: number;
  readonly listenerFailureCount: number;
  readonly lastListenerFailureRevision: number | null;
  readonly lastListenerFailureKind: string | null;
  readonly transitionFailureCount: number;
  readonly completedTransitionCount: number;
  readonly maximumObservedDurationMs: number;
  readonly recentDurationsMs: readonly number[];
  readonly disposed: boolean;
}

export interface MapModeTransitionRequest {
  readonly requestId: number;
  readonly targetMode: ExperienceMapMode;
  readonly source: MapModeTransitionSource;
  readonly queuedAtMs: number;
}

export interface MapModeTransitionModelOptions {
  readonly initialMode?: ExperienceMapMode;
  readonly maxListeners?: number;
  readonly maxDurationSamples?: number;
  readonly now?: () => number;
  readonly reducedMotion?: boolean;
  readonly forcedColors?: boolean;
  readonly coarsePointer?: boolean;
}

type Listener = () => void;

const DEFAULT_MAX_LISTENERS = 32;
const MAX_LISTENERS_LIMIT = 100;
const DEFAULT_DURATION_SAMPLES = 12;
const MAX_DURATION_SAMPLES = 32;
const MAX_ERROR_KIND_LENGTH = 48;

const clampInteger = (value: number | undefined, fallback: number, min: number, max: number): number => {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(value ?? fallback)));
};

const sanitizeKind = (value: unknown): string => {
  const raw = value instanceof Error ? value.name : typeof value === 'string' ? value : typeof value;
  let result = '';
  for (const character of raw) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined || codePoint < 32 || codePoint === 127) continue;
    if (/^[A-Za-z0-9_.:-]$/u.test(character)) result += character;
    if (result.length >= MAX_ERROR_KIND_LENGTH) break;
  }
  return result || 'Error';
};

const freezePresentation = (
  reducedMotion: boolean,
  forcedColors: boolean,
  coarsePointer: boolean,
): MapModeTransitionPresentation => Object.freeze({
  minimumTargetSizePx: coarsePointer ? 48 : 44,
  motionDurationMs: reducedMotion ? 0 : 320,
  forcedColors,
  reducedMotion,
  coarsePointer,
});

const modeLabel = (mode: ExperienceMapMode): string => mode === '3d' ? '3B' : '2B';

const announcementFor = (
  phase: MapModeTransitionPhase,
  activeMode: ExperienceMapMode,
  desiredMode: ExperienceMapMode,
  lastErrorKind: string | null,
): string => {
  if (phase === 'queued') return `${modeLabel(desiredMode)} görünüm geçişi sıraya alındı.`;
  if (phase === 'transitioning') return `${modeLabel(desiredMode)} görünüm hazırlanıyor.`;
  if (phase === 'ready') return `${modeLabel(activeMode)} görünüm kullanıma hazır.`;
  if (phase === 'error') {
    const suffix = lastErrorKind ? ` Teknik sınıf: ${lastErrorKind}.` : '';
    return `${modeLabel(activeMode)} görünüm korunuyor; ${modeLabel(desiredMode)} geçişi tamamlanamadı.${suffix}`;
  }
  return `${modeLabel(activeMode)} görünüm etkin.`;
};

const createSnapshot = (input: Omit<MapModeTransitionSnapshot, 'busy' | 'queued' | 'canRequest2d' | 'canRequest3d' | 'announcement'>): MapModeTransitionSnapshot => {
  const busy = input.phase === 'queued' || input.phase === 'transitioning';
  const queued = input.phase === 'queued';
  return Object.freeze({
    ...input,
    busy,
    queued,
    canRequest2d: !(busy && input.desiredMode === '2d') && input.activeMode !== '2d',
    canRequest3d: !(busy && input.desiredMode === '3d') && input.activeMode !== '3d',
    announcement: announcementFor(input.phase, input.activeMode, input.desiredMode, input.lastErrorKind),
  });
};

const initialSnapshot = (
  mode: ExperienceMapMode,
  presentation: MapModeTransitionPresentation,
): MapModeTransitionSnapshot => createSnapshot({
  revision: 0,
  activeMode: mode,
  desiredMode: mode,
  phase: 'idle',
  requestId: 0,
  activeRequestId: null,
  source: 'runtime',
  startedAtMs: null,
  completedAtMs: null,
  lastDurationMs: null,
  lastErrorKind: null,
  failureCount: 0,
  coalescedRequestCount: 0,
  supersededRequestCount: 0,
  presentation,
});

export class MapModeTransitionModel {
  readonly #listeners = new Set<Listener>();
  readonly #maxListeners: number;
  readonly #maxDurationSamples: number;
  readonly #now: () => number;
  #snapshot: MapModeTransitionSnapshot;
  #diagnostics: MapModeTransitionDiagnostics;
  #disposed = false;

  constructor(options: MapModeTransitionModelOptions = {}) {
    const presentation = freezePresentation(
      options.reducedMotion === true,
      options.forcedColors === true,
      options.coarsePointer === true,
    );
    this.#snapshot = initialSnapshot(options.initialMode ?? '2d', presentation);
    this.#maxListeners = clampInteger(options.maxListeners, DEFAULT_MAX_LISTENERS, 1, MAX_LISTENERS_LIMIT);
    this.#maxDurationSamples = clampInteger(options.maxDurationSamples, DEFAULT_DURATION_SAMPLES, 1, MAX_DURATION_SAMPLES);
    this.#now = options.now ?? (() => Date.now());
    this.#diagnostics = Object.freeze({
      listenerCount: 0,
      rejectedListenerCount: 0,
      listenerFailureCount: 0,
      lastListenerFailureRevision: null,
      lastListenerFailureKind: null,
      transitionFailureCount: 0,
      completedTransitionCount: 0,
      maximumObservedDurationMs: 0,
      recentDurationsMs: Object.freeze([]),
      disposed: false,
    });
  }

  readonly getSnapshot = (): MapModeTransitionSnapshot => this.#snapshot;
  readonly getDiagnostics = (): MapModeTransitionDiagnostics => this.#diagnostics;

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

  request(targetMode: ExperienceMapMode, source: MapModeTransitionSource = 'control'): MapModeTransitionRequest | null {
    if (this.#disposed) return null;
    const now = this.#safeNow();

    if (targetMode === this.#snapshot.desiredMode && this.#snapshot.busy) {
      this.#replace({
        coalescedRequestCount: this.#snapshot.coalescedRequestCount + 1,
        source,
      });
      return Object.freeze({
        requestId: this.#snapshot.requestId,
        targetMode,
        source,
        queuedAtMs: now,
      });
    }

    if (targetMode === this.#snapshot.activeMode && !this.#snapshot.busy) {
      this.#replace({
        desiredMode: targetMode,
        phase: 'ready',
        source,
        lastErrorKind: null,
      });
      return null;
    }

    const requestId = this.#snapshot.requestId + 1;
    const superseded = this.#snapshot.busy && this.#snapshot.desiredMode !== targetMode
      ? this.#snapshot.supersededRequestCount + 1
      : this.#snapshot.supersededRequestCount;

    this.#replace({
      requestId,
      desiredMode: targetMode,
      phase: 'queued',
      source,
      activeRequestId: this.#snapshot.activeRequestId,
      completedAtMs: null,
      lastErrorKind: null,
      supersededRequestCount: superseded,
    });

    return Object.freeze({ requestId, targetMode, source, queuedAtMs: now });
  }

  begin(request: MapModeTransitionRequest): boolean {
    if (this.#disposed) return false;
    if (request.requestId !== this.#snapshot.requestId || request.targetMode !== this.#snapshot.desiredMode) return false;
    this.#replace({
      phase: 'transitioning',
      activeRequestId: request.requestId,
      startedAtMs: this.#safeNow(),
      completedAtMs: null,
      source: request.source,
      lastErrorKind: null,
    });
    return true;
  }

  complete(request: MapModeTransitionRequest, activeMode = request.targetMode): boolean {
    if (this.#disposed) return false;
    if (request.requestId !== this.#snapshot.activeRequestId) return false;
    const completedAtMs = this.#safeNow();
    const duration = this.#snapshot.startedAtMs === null
      ? null
      : Math.max(0, Math.round(completedAtMs - this.#snapshot.startedAtMs));
    this.#recordDuration(duration);
    this.#replace({
      activeMode,
      desiredMode: this.#snapshot.requestId === request.requestId ? activeMode : this.#snapshot.desiredMode,
      phase: this.#snapshot.requestId === request.requestId ? 'ready' : 'queued',
      activeRequestId: null,
      completedAtMs,
      lastDurationMs: duration,
      lastErrorKind: null,
    });
    return true;
  }

  fail(request: MapModeTransitionRequest, error: unknown, fallbackMode: ExperienceMapMode): boolean {
    if (this.#disposed) return false;
    if (request.requestId !== this.#snapshot.activeRequestId) return false;
    const completedAtMs = this.#safeNow();
    const duration = this.#snapshot.startedAtMs === null
      ? null
      : Math.max(0, Math.round(completedAtMs - this.#snapshot.startedAtMs));
    this.#recordDuration(duration);
    this.#patchDiagnostics({ transitionFailureCount: this.#diagnostics.transitionFailureCount + 1 });
    this.#replace({
      activeMode: fallbackMode,
      desiredMode: this.#snapshot.requestId === request.requestId ? request.targetMode : this.#snapshot.desiredMode,
      phase: this.#snapshot.requestId === request.requestId ? 'error' : 'queued',
      activeRequestId: null,
      completedAtMs,
      lastDurationMs: duration,
      lastErrorKind: sanitizeKind(error),
      failureCount: this.#snapshot.failureCount + 1,
    });
    return true;
  }

  acknowledge(mode: ExperienceMapMode, source: MapModeTransitionSource = 'runtime'): void {
    if (this.#disposed) return;
    this.#replace({
      activeMode: mode,
      desiredMode: mode,
      phase: 'ready',
      activeRequestId: null,
      source,
      startedAtMs: null,
      completedAtMs: this.#safeNow(),
      lastErrorKind: null,
    });
  }

  setPresentation(input: Partial<Pick<MapModeTransitionPresentation, 'reducedMotion' | 'forcedColors' | 'coarsePointer'>>): void {
    if (this.#disposed) return;
    const next = freezePresentation(
      input.reducedMotion ?? this.#snapshot.presentation.reducedMotion,
      input.forcedColors ?? this.#snapshot.presentation.forcedColors,
      input.coarsePointer ?? this.#snapshot.presentation.coarsePointer,
    );
    if (
      next.reducedMotion === this.#snapshot.presentation.reducedMotion
      && next.forcedColors === this.#snapshot.presentation.forcedColors
      && next.coarsePointer === this.#snapshot.presentation.coarsePointer
    ) return;
    this.#replace({ presentation: next });
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#listeners.clear();
    this.#diagnostics = Object.freeze({ ...this.#diagnostics, listenerCount: 0, disposed: true });
  }

  #safeNow(): number {
    const value = this.#now();
    return Number.isFinite(value) ? value : Date.now();
  }

  #unsubscribe(listener: Listener): void {
    if (!this.#listeners.delete(listener)) return;
    this.#patchDiagnostics({ listenerCount: this.#listeners.size });
  }

  #replace(patch: Partial<MapModeTransitionSnapshot>): void {
    if (this.#disposed) return;
    const base = this.#snapshot;
    const next = createSnapshot({
      revision: base.revision + 1,
      activeMode: patch.activeMode ?? base.activeMode,
      desiredMode: patch.desiredMode ?? base.desiredMode,
      phase: patch.phase ?? base.phase,
      requestId: patch.requestId ?? base.requestId,
      activeRequestId: patch.activeRequestId === undefined ? base.activeRequestId : patch.activeRequestId,
      source: patch.source ?? base.source,
      startedAtMs: patch.startedAtMs === undefined ? base.startedAtMs : patch.startedAtMs,
      completedAtMs: patch.completedAtMs === undefined ? base.completedAtMs : patch.completedAtMs,
      lastDurationMs: patch.lastDurationMs === undefined ? base.lastDurationMs : patch.lastDurationMs,
      lastErrorKind: patch.lastErrorKind === undefined ? base.lastErrorKind : patch.lastErrorKind,
      failureCount: patch.failureCount ?? base.failureCount,
      coalescedRequestCount: patch.coalescedRequestCount ?? base.coalescedRequestCount,
      supersededRequestCount: patch.supersededRequestCount ?? base.supersededRequestCount,
      presentation: patch.presentation ?? base.presentation,
    });
    this.#snapshot = next;
    this.#notify();
  }

  #notify(): void {
    for (const listener of this.#listeners) {
      try {
        listener();
      } catch (error) {
        this.#recordListenerFailure(error);
      }
    }
  }

  #recordListenerFailure(error: unknown): void {
    this.#patchDiagnostics({
      listenerFailureCount: this.#diagnostics.listenerFailureCount + 1,
      lastListenerFailureRevision: this.#snapshot.revision,
      lastListenerFailureKind: sanitizeKind(error),
    });
  }

  #recordDuration(duration: number | null): void {
    if (duration === null) return;
    const samples = this.#diagnostics.recentDurationsMs.slice();
    samples.push(duration);
    this.#patchDiagnostics({
      completedTransitionCount: this.#diagnostics.completedTransitionCount + 1,
      maximumObservedDurationMs: Math.max(this.#diagnostics.maximumObservedDurationMs, duration),
      recentDurationsMs: Object.freeze(samples.slice(-this.#maxDurationSamples)),
    });
  }

  #patchDiagnostics(patch: Partial<MapModeTransitionDiagnostics>): void {
    this.#diagnostics = Object.freeze({ ...this.#diagnostics, ...patch });
  }
}

export const createMapModeTransitionModel = (options: MapModeTransitionModelOptions = {}): MapModeTransitionModel => (
  new MapModeTransitionModel(options)
);
