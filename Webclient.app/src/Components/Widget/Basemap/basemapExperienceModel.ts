import { normalizeWidgetError } from '../_shared/MapWidgetRuntime';

export type BasemapExperiencePhase = 'idle' | 'loading' | 'ready' | 'error';

export interface BasemapExperienceSnapshot {
  readonly revision: number;
  readonly phase: BasemapExperiencePhase;
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly readyCount: number;
  readonly error: string | null;
  readonly canReload: boolean;
  readonly busy: boolean;
  readonly announcement: string;
}

export interface BasemapExperienceDiagnostics {
  readonly observerFailureCount: number;
  readonly activeObserverCount: number;
  readonly rejectedObserverCount: number;
  readonly lastFailureKind: string | null;
  readonly disposed: boolean;
}

export interface BasemapExperienceModelOptions {
  readonly maxAttempts?: number;
  readonly maxObservers?: number;
}

type Listener = () => void;

const DEFAULT_MAX_ATTEMPTS = 3;
const MAX_ATTEMPTS_LIMIT = 5;
const DEFAULT_MAX_OBSERVERS = 24;
const MAX_OBSERVERS_LIMIT = 96;

const clampInteger = (value: number | undefined, fallback: number, min: number, max: number): number => {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(value ?? fallback)));
};

const announcementFor = (
  phase: BasemapExperiencePhase,
  attempt: number,
  maxAttempts: number,
  readyCount: number,
  error: string | null,
): string => {
  switch (phase) {
    case 'idle':
      return 'Altlık harita galerisi hazır olduğunda yükleme başlayacak.';
    case 'loading':
      return `Altlık haritalar hazırlanıyor. Deneme ${attempt}/${maxAttempts}.`;
    case 'ready':
      return `${readyCount} altlık harita kullanıma hazır.`;
    case 'error':
      return error
        ? `Altlık harita galerisi açılamadı. ${error}`
        : 'Altlık harita galerisi açılamadı.';
  }
};

const createSnapshot = (
  revision: number,
  phase: BasemapExperiencePhase,
  attempt: number,
  maxAttempts: number,
  readyCount: number,
  error: string | null,
): BasemapExperienceSnapshot => Object.freeze({
  revision,
  phase,
  attempt,
  maxAttempts,
  readyCount,
  error,
  canReload: phase === 'error' && attempt < maxAttempts,
  busy: phase === 'loading',
  announcement: announcementFor(phase, attempt, maxAttempts, readyCount, error),
});

const classifyFailure = (error: unknown): string => {
  if (error instanceof Error) return error.name || 'Error';
  if (error === null) return 'null';
  return typeof error;
};

export class BasemapExperienceModel {
  readonly #listeners = new Set<Listener>();
  readonly #maxAttempts: number;
  readonly #maxObservers: number;
  #snapshot: BasemapExperienceSnapshot;
  #diagnostics: BasemapExperienceDiagnostics;
  #disposed = false;

  constructor(options: BasemapExperienceModelOptions = {}) {
    this.#maxAttempts = clampInteger(options.maxAttempts, DEFAULT_MAX_ATTEMPTS, 1, MAX_ATTEMPTS_LIMIT);
    this.#maxObservers = clampInteger(options.maxObservers, DEFAULT_MAX_OBSERVERS, 1, MAX_OBSERVERS_LIMIT);
    this.#snapshot = createSnapshot(0, 'idle', 0, this.#maxAttempts, 0, null);
    this.#diagnostics = Object.freeze({
      observerFailureCount: 0,
      activeObserverCount: 0,
      rejectedObserverCount: 0,
      lastFailureKind: null,
      disposed: false,
    });
  }

  readonly getSnapshot = (): BasemapExperienceSnapshot => this.#snapshot;
  readonly getDiagnostics = (): BasemapExperienceDiagnostics => this.#diagnostics;

  readonly subscribe = (listener: Listener): (() => void) => {
    if (this.#disposed) {
      this.#diagnostics = Object.freeze({
        ...this.#diagnostics,
        rejectedObserverCount: this.#diagnostics.rejectedObserverCount + 1,
      });
      return () => undefined;
    }
    if (this.#listeners.has(listener)) return () => undefined;
    if (this.#listeners.size >= this.#maxObservers) {
      this.#diagnostics = Object.freeze({
        ...this.#diagnostics,
        rejectedObserverCount: this.#diagnostics.rejectedObserverCount + 1,
      });
      return () => undefined;
    }
    this.#listeners.add(listener);
    this.#diagnostics = Object.freeze({
      ...this.#diagnostics,
      activeObserverCount: this.#listeners.size,
    });
    return () => {
      this.#listeners.delete(listener);
      this.#diagnostics = Object.freeze({
        ...this.#diagnostics,
        activeObserverCount: this.#listeners.size,
      });
    };
  };

  beginLoad(): boolean {
    if (this.#disposed || this.#snapshot.phase === 'loading') return false;
    if (this.#snapshot.attempt >= this.#maxAttempts && this.#snapshot.phase === 'error') return false;
    this.#publish(createSnapshot(
      this.#snapshot.revision + 1,
      'loading',
      this.#snapshot.attempt + 1,
      this.#maxAttempts,
      this.#snapshot.readyCount,
      null,
    ));
    return true;
  }

  succeed(readyCount: number): void {
    if (this.#disposed) return;
    const count = Number.isFinite(readyCount) ? Math.max(0, Math.trunc(readyCount)) : 0;
    this.#publish(createSnapshot(
      this.#snapshot.revision + 1,
      'ready',
      this.#snapshot.attempt,
      this.#maxAttempts,
      count,
      null,
    ));
  }

  fail(error: unknown): void {
    if (this.#disposed) return;
    const message = normalizeWidgetError(error, 'Altlık haritalar yüklenemedi.');
    this.#publish(createSnapshot(
      this.#snapshot.revision + 1,
      'error',
      this.#snapshot.attempt,
      this.#maxAttempts,
      0,
      message,
    ));
  }

  cancel(): void {
    if (this.#disposed) return;
    this.#publish(createSnapshot(
      this.#snapshot.revision + 1,
      'idle',
      this.#snapshot.attempt,
      this.#maxAttempts,
      0,
      null,
    ));
  }

  resetAttempts(): void {
    if (this.#disposed) return;
    this.#publish(createSnapshot(
      this.#snapshot.revision + 1,
      'idle',
      0,
      this.#maxAttempts,
      0,
      null,
    ));
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

  #publish(next: BasemapExperienceSnapshot): void {
    if (this.#disposed || next === this.#snapshot) return;
    this.#snapshot = next;
    for (const listener of this.#listeners) {
      try {
        listener();
      } catch (error) {
        this.#diagnostics = Object.freeze({
          ...this.#diagnostics,
          observerFailureCount: this.#diagnostics.observerFailureCount + 1,
          lastFailureKind: classifyFailure(error),
        });
      }
    }
  }
}

export const createBasemapExperienceModel = (
  options: BasemapExperienceModelOptions = {},
): BasemapExperienceModel => new BasemapExperienceModel(options);
