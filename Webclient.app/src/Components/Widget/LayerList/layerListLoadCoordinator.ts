export type LayerListLoadStatus = 'idle' | 'loading' | 'ready' | 'partial' | 'cancelled' | 'error';

export interface LayerListLoadItem<TSource> {
  readonly key: string;
  readonly source: TSource;
}

export interface LayerListLoadSuccess<TSource, TResult> {
  readonly key: string;
  readonly source: TSource;
  readonly result: TResult;
}

export interface LayerListLoadFailure<TSource> {
  readonly key: string;
  readonly source: TSource;
  readonly failureKind: string;
}

export interface LayerListLoadSnapshot {
  readonly revision: number;
  readonly generation: number;
  readonly status: LayerListLoadStatus;
  readonly queued: number;
  readonly active: number;
  readonly completed: number;
  readonly failed: number;
  readonly total: number;
  readonly progressPercent: number;
  readonly announcement: string;
}

export interface LayerListLoadObserverDiagnostics {
  readonly activeObserverCount: number;
  readonly rejectedObserverCount: number;
  readonly failureCount: number;
  readonly lastFailureKind: string | null;
  readonly lastFailureRevision: number | null;
  readonly disposed: boolean;
}

export interface LayerListLoadCoordinatorOptions {
  readonly concurrency?: number;
  readonly maxItems?: number;
  readonly maxObservers?: number;
  readonly onObserverError?: (error: unknown) => void;
}

const DEFAULT_CONCURRENCY = 4;
const DEFAULT_MAX_ITEMS = 512;
const DEFAULT_MAX_OBSERVERS = 24;

const clampInteger = (value: number | undefined, fallback: number, min: number, max: number): number => {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(value ?? fallback)));
};

const failureKind = (error: unknown): string => {
  if (error instanceof Error) return error.name || 'Error';
  if (error === null) return 'null';
  return typeof error;
};

const progress = (completed: number, failed: number, total: number): number => {
  if (total <= 0) return 100;
  return Math.max(0, Math.min(100, Math.round(((completed + failed) / total) * 100)));
};

const announcementFor = (snapshot: Omit<LayerListLoadSnapshot, 'announcement'>): string => {
  if (snapshot.status === 'idle') return 'Katman yükleyici hazır.';
  if (snapshot.status === 'cancelled') return 'Katman yükleme iptal edildi.';
  if (snapshot.status === 'error') return 'Katmanlar yüklenemedi.';
  if (snapshot.status === 'ready') return `${snapshot.completed} katman hazır.`;
  if (snapshot.status === 'partial') return `${snapshot.completed} katman hazır, ${snapshot.failed} katman yüklenemedi.`;
  return `Katmanlar yükleniyor: yüzde ${snapshot.progressPercent}.`;
};

export class LayerListLoadCoordinator<TSource, TResult> {
  readonly #concurrency: number;
  readonly #maxItems: number;
  readonly #maxObservers: number;
  readonly #onObserverError: ((error: unknown) => void) | undefined;
  readonly #listeners = new Set<() => void>();
  #generation = 0;
  #disposed = false;
  #diagnostics: LayerListLoadObserverDiagnostics = Object.freeze({
    activeObserverCount: 0,
    rejectedObserverCount: 0,
    failureCount: 0,
    lastFailureKind: null,
    lastFailureRevision: null,
    disposed: false,
  });
  #snapshot: LayerListLoadSnapshot = Object.freeze({
    revision: 0,
    generation: 0,
    status: 'idle',
    queued: 0,
    active: 0,
    completed: 0,
    failed: 0,
    total: 0,
    progressPercent: 100,
    announcement: 'Katman yükleyici hazır.',
  });

  constructor(options: LayerListLoadCoordinatorOptions = {}) {
    this.#concurrency = clampInteger(options.concurrency, DEFAULT_CONCURRENCY, 1, 12);
    this.#maxItems = clampInteger(options.maxItems, DEFAULT_MAX_ITEMS, 1, 2048);
    this.#maxObservers = clampInteger(options.maxObservers, DEFAULT_MAX_OBSERVERS, 1, 128);
    this.#onObserverError = options.onObserverError;
  }

  readonly getSnapshot = (): LayerListLoadSnapshot => this.#snapshot;
  readonly getObserverDiagnostics = (): LayerListLoadObserverDiagnostics => this.#diagnostics;

  readonly subscribe = (listener: () => void): (() => void) => {
    if (this.#disposed) {
      this.#recordRejectedObserver();
      return () => undefined;
    }
    if (this.#listeners.has(listener)) {
      return () => {
        this.#listeners.delete(listener);
        this.#refreshObserverCount();
      };
    }
    if (this.#listeners.size >= this.#maxObservers) {
      this.#recordRejectedObserver();
      return () => undefined;
    }
    this.#listeners.add(listener);
    this.#refreshObserverCount();
    return () => {
      this.#listeners.delete(listener);
      this.#refreshObserverCount();
    };
  };

  cancel(): void {
    if (this.#disposed) return;
    this.#generation += 1;
    if (this.#snapshot.status === 'loading') {
      this.#publish({
        generation: this.#generation,
        status: 'cancelled',
        queued: 0,
        active: 0,
      });
    }
  }

  async load(
    items: readonly LayerListLoadItem<TSource>[],
    worker: (item: LayerListLoadItem<TSource>) => Promise<TResult>,
    disposeResult?: (result: TResult) => void,
  ): Promise<Readonly<{
    successes: readonly LayerListLoadSuccess<TSource, TResult>[];
    failures: readonly LayerListLoadFailure<TSource>[];
    cancelled: boolean;
    generation: number;
  }>> {
    if (this.#disposed) {
      return Object.freeze({ successes: Object.freeze([]), failures: Object.freeze([]), cancelled: true, generation: this.#generation });
    }

    const generation = ++this.#generation;
    const boundedItems = items.slice(0, this.#maxItems);
    const queue = boundedItems.map((item, index) => Object.freeze({
      key: item.key.trim() || `layer-${index + 1}`,
      source: item.source,
    }));
    const successes: LayerListLoadSuccess<TSource, TResult>[] = [];
    const failures: LayerListLoadFailure<TSource>[] = [];
    let cursor = 0;
    let active = 0;

    this.#publish({
      generation,
      status: queue.length === 0 ? 'ready' : 'loading',
      queued: queue.length,
      active: 0,
      completed: 0,
      failed: 0,
      total: queue.length,
    });

    if (queue.length === 0) {
      return Object.freeze({
        successes: Object.freeze([]),
        failures: Object.freeze([]),
        cancelled: false,
        generation,
      });
    }

    const runWorker = async (): Promise<void> => {
      while (!this.#disposed && generation === this.#generation) {
        const item = queue[cursor];
        if (!item) return;
        cursor += 1;
        active += 1;
        this.#publish({
          generation,
          status: 'loading',
          queued: Math.max(0, queue.length - cursor),
          active,
          completed: successes.length,
          failed: failures.length,
          total: queue.length,
        });

        try {
          const result = await worker(item);
          if (this.#disposed || generation !== this.#generation) {
            if (disposeResult) {
              try {
                disposeResult(result);
              } catch (error) {
                globalThis.reportError?.(error);
              }
            }
            return;
          }
          successes.push(Object.freeze({ key: item.key, source: item.source, result }));
        } catch (error) {
          if (this.#disposed || generation !== this.#generation) return;
          failures.push(Object.freeze({ key: item.key, source: item.source, failureKind: failureKind(error) }));
        } finally {
          active = Math.max(0, active - 1);
          if (!this.#disposed && generation === this.#generation) {
            const done = successes.length + failures.length;
            this.#publish({
              generation,
              status: done >= queue.length ? (failures.length > 0 ? 'partial' : 'ready') : 'loading',
              queued: Math.max(0, queue.length - cursor),
              active,
              completed: successes.length,
              failed: failures.length,
              total: queue.length,
            });
          }
        }
      }
    };

    const workerCount = Math.min(this.#concurrency, queue.length);
    await Promise.all(Array.from({ length: workerCount }, () => runWorker()));

    const cancelled = this.#disposed || generation !== this.#generation;
    return Object.freeze({
      successes: Object.freeze([...successes]),
      failures: Object.freeze([...failures]),
      cancelled,
      generation,
    });
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#generation += 1;
    this.#listeners.clear();
    this.#diagnostics = Object.freeze({
      ...this.#diagnostics,
      activeObserverCount: 0,
      disposed: true,
    });
    this.#snapshot = Object.freeze({
      ...this.#snapshot,
      revision: this.#snapshot.revision + 1,
      generation: this.#generation,
      status: 'cancelled',
      queued: 0,
      active: 0,
      announcement: 'Katman yükleme iptal edildi.',
    });
  }

  #publish(input: Readonly<{
    generation: number;
    status: LayerListLoadStatus;
    queued: number;
    active: number;
    completed?: number;
    failed?: number;
    total?: number;
  }>): void {
    if (this.#disposed) return;
    const completed = input.completed ?? this.#snapshot.completed;
    const failed = input.failed ?? this.#snapshot.failed;
    const total = input.total ?? this.#snapshot.total;
    const base = Object.freeze({
      revision: this.#snapshot.revision + 1,
      generation: input.generation,
      status: input.status,
      queued: Math.max(0, input.queued),
      active: Math.max(0, input.active),
      completed: Math.max(0, completed),
      failed: Math.max(0, failed),
      total: Math.max(0, total),
      progressPercent: progress(completed, failed, total),
    });
    this.#snapshot = Object.freeze({
      ...base,
      announcement: announcementFor(base),
    });
    for (const listener of Array.from(this.#listeners)) {
      try {
        listener();
      } catch (error) {
        this.#reportObserverError(error);
      }
    }
  }

  #reportObserverError(error: unknown): void {
    this.#recordObserverFailure(error);
    try {
      if (this.#onObserverError) this.#onObserverError(error);
      else globalThis.reportError?.(error);
    } catch (reporterError) {
      this.#recordObserverFailure(reporterError);
      globalThis.console?.warn?.('LayerListLoadCoordinator observer reporter failed.');
    }
  }

  #recordObserverFailure(error: unknown): void {
    this.#diagnostics = Object.freeze({
      ...this.#diagnostics,
      failureCount: this.#diagnostics.failureCount + 1,
      lastFailureKind: failureKind(error),
      lastFailureRevision: this.#snapshot.revision,
    });
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
}
