export type AsyncSurfacePhase = 'idle' | 'loading' | 'ready' | 'empty' | 'error';

export interface AsyncSurfaceSnapshot {
  readonly revision: number;
  readonly phase: AsyncSurfacePhase;
  readonly busy: boolean;
  readonly message: string | undefined;
  readonly errorMessage: string | undefined;
  /** Presentation fact only: whether the UI may offer an explicit user-initiated recovery action. */
  readonly recoverable: boolean;
  readonly resultCount: number | undefined;
  readonly ariaLive: 'off' | 'polite' | 'assertive';
  readonly reducedMotion: boolean;
  readonly targetSize: number;
}

export interface AsyncSurfaceAnnouncement {
  readonly message: string;
  readonly priority: 'polite' | 'assertive';
}

export interface AsyncSurfaceOptions {
  readonly reducedMotion?: boolean;
  readonly coarsePointer?: boolean;
  readonly onAnnouncement?: (announcement: AsyncSurfaceAnnouncement) => void;
  readonly onObserverError?: (error: unknown) => void;
}

type Listener = (snapshot: AsyncSurfaceSnapshot) => void;

export class AsyncSurfaceState {
  readonly #listeners = new Set<Listener>();
  readonly #onAnnouncement: ((announcement: AsyncSurfaceAnnouncement) => void) | undefined;
  readonly #onObserverError: ((error: unknown) => void) | undefined;
  readonly #reducedMotion: boolean;
  readonly #targetSize: number;
  #phase: AsyncSurfacePhase = 'idle';
  #message: string | undefined;
  #errorMessage: string | undefined;
  #recoverable = false;
  #resultCount: number | undefined;
  #revision = 0;
  #snapshot: AsyncSurfaceSnapshot;

  constructor(options: AsyncSurfaceOptions = {}) {
    this.#reducedMotion = options.reducedMotion ?? false;
    this.#targetSize = options.coarsePointer === true ? 48 : 40;
    this.#onAnnouncement = options.onAnnouncement;
    this.#onObserverError = options.onObserverError;
    this.#snapshot = this.#buildSnapshot();
  }

  get snapshot(): AsyncSurfaceSnapshot { return this.#snapshot; }

  subscribe(listener: Listener): () => void {
    this.#listeners.add(listener);
    this.#notifyOne(listener);
    return () => this.#listeners.delete(listener);
  }

  reset(): void {
    if (this.#phase === 'idle') return;
    this.#phase = 'idle'; this.#message = undefined; this.#errorMessage = undefined; this.#recoverable = false; this.#resultCount = undefined; this.#commit();
  }

  loading(message = 'Yükleniyor…'): void {
    const normalized = message.trim() || 'Yükleniyor…';
    this.#phase = 'loading'; this.#message = normalized; this.#errorMessage = undefined; this.#recoverable = false; this.#resultCount = undefined; this.#commit();
  }

  ready(resultCount?: number, message?: string): void {
    if (resultCount !== undefined && (!Number.isInteger(resultCount) || resultCount < 0)) throw new RangeError('resultCount must be a non-negative integer.');
    if (resultCount === 0) { this.empty(message); return; }
    this.#phase = 'ready'; this.#message = message?.trim() || undefined; this.#errorMessage = undefined; this.#recoverable = false; this.#resultCount = resultCount; this.#commit();
    if (message?.trim()) this.#announce(message.trim(), 'polite');
  }

  empty(message = 'Gösterilecek sonuç bulunamadı.'): void {
    const normalized = message.trim() || 'Gösterilecek sonuç bulunamadı.';
    this.#phase = 'empty'; this.#message = normalized; this.#errorMessage = undefined; this.#recoverable = false; this.#resultCount = 0; this.#commit(); this.#announce(normalized, 'polite');
  }

  error(message: string, recoverable = true): void {
    const normalized = message.trim();
    if (!normalized) throw new Error('Error message must be non-empty.');
    this.#phase = 'error'; this.#message = undefined; this.#errorMessage = normalized; this.#recoverable = recoverable; this.#resultCount = undefined; this.#commit(); this.#announce(normalized, 'assertive');
  }

  #buildSnapshot(): AsyncSurfaceSnapshot {
    return Object.freeze({ revision: this.#revision, phase: this.#phase, busy: this.#phase === 'loading', message: this.#message, errorMessage: this.#errorMessage, recoverable: this.#recoverable, resultCount: this.#resultCount, ariaLive: this.#phase === 'error' ? 'assertive' : this.#phase === 'empty' || this.#phase === 'ready' ? 'polite' : 'off', reducedMotion: this.#reducedMotion, targetSize: this.#targetSize });
  }

  #commit(): void { this.#revision += 1; this.#snapshot = this.#buildSnapshot(); for (const listener of this.#listeners) this.#notifyOne(listener); }
  #notifyOne(listener: Listener): void { try { listener(this.#snapshot); } catch (error) { this.#reportObserverError(error); } }
  #announce(message: string, priority: AsyncSurfaceAnnouncement['priority']): void { if (!this.#onAnnouncement) return; try { this.#onAnnouncement({ message, priority }); } catch (error) { this.#reportObserverError(error); } }
  #reportObserverError(error: unknown): void { if (!this.#onObserverError) return; try { this.#onObserverError(error); } catch (reportingError) { void reportingError; } }
}
