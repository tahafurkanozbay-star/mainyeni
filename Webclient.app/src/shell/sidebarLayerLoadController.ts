export type SidebarLayerLoadPhase = 'idle' | 'loading' | 'ready' | 'degraded' | 'cancelled';

export interface SidebarLoadedLayer<TLayer> {
  readonly serviceKey: string;
  readonly layer: TLayer;
}

export interface SidebarLayerLoadFailure {
  readonly serviceKey: string;
  readonly kind: string;
  readonly attempt: number;
}

export interface SidebarLayerLoadSnapshot<TLayer> {
  readonly phase: SidebarLayerLoadPhase;
  readonly totalCount: number;
  readonly completedCount: number;
  readonly loadedCount: number;
  readonly failedCount: number;
  readonly pendingCount: number;
  readonly activeCount: number;
  readonly attempt: number;
  readonly loadedLayers: readonly SidebarLoadedLayer<TLayer>[];
  readonly failures: readonly SidebarLayerLoadFailure[];
  readonly canRetry: boolean;
  readonly announcement: string;
  readonly revision: number;
}

export interface SidebarLayerLoadDiagnostics {
  readonly loaderFailureCount: number;
  readonly observerFailureCount: number;
  readonly lastLoaderFailureKind: string | null;
  readonly lastObserverFailureKind: string | null;
}

export interface SidebarLayerLoadControllerOptions<TLayer> {
  readonly serviceKeys: readonly string[];
  readonly concurrency?: number;
  readonly loadLayer: (serviceKey: string) => Promise<TLayer | null>;
}

export interface SidebarLayerLoadController<TLayer> {
  readonly getSnapshot: () => SidebarLayerLoadSnapshot<TLayer>;
  readonly getDiagnostics: () => SidebarLayerLoadDiagnostics;
  readonly subscribe: (listener: () => void) => () => void;
  readonly start: () => Promise<void>;
  readonly retryFailed: () => Promise<void>;
  readonly cancel: () => void;
}

const MAX_SERVICE_KEYS = 128;
const MAX_CONCURRENCY = 8;
const DEFAULT_CONCURRENCY = 4;

const freezeArray = <T>(values: readonly T[]): readonly T[] => Object.freeze([...values]);

const classifyFailure = (error: unknown): string => {
  if (error instanceof Error) return error.name || 'Error';
  if (error === null) return 'null';
  return typeof error;
};

const normalizeServiceKeys = (values: readonly string[]): readonly string[] => {
  if (!Array.isArray(values)) throw new TypeError('Sidebar layer loader requires a service-key array.');
  if (values.length > MAX_SERVICE_KEYS) {
    throw new RangeError(`Sidebar layer loader supports at most ${MAX_SERVICE_KEYS} service keys.`);
  }

  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (typeof value !== 'string') throw new TypeError('Sidebar layer service keys must be strings.');
    const key = value.trim();
    if (!key) throw new TypeError('Sidebar layer service key cannot be empty.');
    if (key.length > 160) throw new RangeError('Sidebar layer service key exceeds 160 characters.');
    if (seen.has(key)) throw new Error(`Duplicate sidebar layer service key: ${key}`);
    seen.add(key);
    normalized.push(key);
  }
  return freezeArray(normalized);
};

const resolveConcurrency = (value: number | undefined): number => {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_CONCURRENCY;
  return Math.min(MAX_CONCURRENCY, Math.max(1, Math.trunc(value)));
};

export const createSidebarLayerLoadController = <TLayer>(
  options: SidebarLayerLoadControllerOptions<TLayer>,
): SidebarLayerLoadController<TLayer> => {
  if (!options || typeof options.loadLayer !== 'function') {
    throw new TypeError('Sidebar layer loader requires a loadLayer function.');
  }

  const serviceKeys = normalizeServiceKeys(options.serviceKeys);
  const concurrency = resolveConcurrency(options.concurrency);
  const loaded = new Map<string, TLayer>();
  const failures = new Map<string, SidebarLayerLoadFailure>();
  const listeners = new Set<() => void>();
  let phase: SidebarLayerLoadPhase = 'idle';
  let activeCount = 0;
  let attempt = 0;
  let revision = 0;
  let cancelled = false;
  let currentRun: Promise<void> | null = null;
  let queue: string[] = [];
  let diagnostics: SidebarLayerLoadDiagnostics = Object.freeze({
    loaderFailureCount: 0,
    observerFailureCount: 0,
    lastLoaderFailureKind: null,
    lastObserverFailureKind: null,
  });

  const recordLoaderFailure = (kind: string): void => {
    diagnostics = Object.freeze({
      loaderFailureCount: diagnostics.loaderFailureCount + 1,
      observerFailureCount: diagnostics.observerFailureCount,
      lastLoaderFailureKind: kind,
      lastObserverFailureKind: diagnostics.lastObserverFailureKind,
    });
  };

  const recordObserverFailure = (error: unknown): void => {
    diagnostics = Object.freeze({
      loaderFailureCount: diagnostics.loaderFailureCount,
      observerFailureCount: diagnostics.observerFailureCount + 1,
      lastLoaderFailureKind: diagnostics.lastLoaderFailureKind,
      lastObserverFailureKind: classifyFailure(error),
    });
  };

  const announcementFor = (): string => {
    const completedCount = loaded.size + failures.size;
    if (phase === 'idle') return 'Harita katmanları henüz hazırlanmadı.';
    if (phase === 'cancelled') return 'Harita katmanı hazırlama işlemi durduruldu.';
    if (phase === 'loading') {
      return `${completedCount}/${serviceKeys.length} harita katmanı hazırlandı.`;
    }
    if (phase === 'degraded') {
      return `${loaded.size} harita katmanı hazır, ${failures.size} katman hazırlanamadı.`;
    }
    return `${loaded.size} harita katmanı hazır.`;
  };

  const buildSnapshot = (): SidebarLayerLoadSnapshot<TLayer> => {
    const loadedLayerEntries: SidebarLoadedLayer<TLayer>[] = [];
    const failureEntries: SidebarLayerLoadFailure[] = [];
    for (const serviceKey of serviceKeys) {
      if (loaded.has(serviceKey)) {
        const layer = loaded.get(serviceKey) as TLayer;
        loadedLayerEntries.push(Object.freeze({ serviceKey, layer }));
      }
      const failure = failures.get(serviceKey);
      if (failure !== undefined) failureEntries.push(failure);
    }
    const loadedLayers = freezeArray(loadedLayerEntries);
    const failureList = freezeArray(failureEntries);
    const completedCount = loaded.size + failures.size;
    const pendingCount = Math.max(0, serviceKeys.length - completedCount - activeCount);
    return Object.freeze({
      phase,
      totalCount: serviceKeys.length,
      completedCount,
      loadedCount: loaded.size,
      failedCount: failures.size,
      pendingCount,
      activeCount,
      attempt,
      loadedLayers,
      failures: failureList,
      canRetry: phase === 'degraded' && failures.size > 0,
      announcement: announcementFor(),
      revision,
    });
  };

  let snapshot = buildSnapshot();

  const publish = (): void => {
    revision += 1;
    snapshot = buildSnapshot();
    for (const listener of listeners) {
      try {
        listener();
      } catch (error) {
        recordObserverFailure(error);
      }
    }
  };

  const getSnapshot = (): SidebarLayerLoadSnapshot<TLayer> => snapshot;
  const getDiagnostics = (): SidebarLayerLoadDiagnostics => diagnostics;

  const subscribe = (listener: () => void): (() => void) => {
    if (typeof listener !== 'function') throw new TypeError('Sidebar layer listener must be a function.');
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  const loadOne = async (serviceKey: string, runAttempt: number): Promise<void> => {
    activeCount += 1;
    publish();
    try {
      const layer = await options.loadLayer(serviceKey);
      if (cancelled || runAttempt !== attempt) return;
      if (layer === null) {
        const failure = Object.freeze({ serviceKey, kind: 'empty-result', attempt: runAttempt });
        failures.set(serviceKey, failure);
        recordLoaderFailure('empty-result');
        return;
      }
      loaded.set(serviceKey, layer);
      failures.delete(serviceKey);
    } catch (error) {
      if (cancelled || runAttempt !== attempt) return;
      const kind = classifyFailure(error);
      failures.set(serviceKey, Object.freeze({ serviceKey, kind, attempt: runAttempt }));
      recordLoaderFailure(kind);
    } finally {
      activeCount = Math.max(0, activeCount - 1);
      if (!cancelled && runAttempt === attempt) publish();
    }
  };

  const worker = async (runAttempt: number): Promise<void> => {
    while (!cancelled && runAttempt === attempt) {
      const serviceKey = queue.shift();
      if (serviceKey === undefined) return;
      await loadOne(serviceKey, runAttempt);
    }
  };

  const run = async (keys: readonly string[]): Promise<void> => {
    if (keys.length === 0) {
      phase = failures.size > 0 ? 'degraded' : 'ready';
      publish();
      return;
    }

    cancelled = false;
    attempt += 1;
    const runAttempt = attempt;
    queue = [...keys];
    for (const key of keys) failures.delete(key);
    phase = 'loading';
    publish();

    const workerCount = Math.min(concurrency, queue.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker(runAttempt)));

    if (cancelled || runAttempt !== attempt) return;
    phase = failures.size > 0 ? 'degraded' : 'ready';
    publish();
  };

  const start = (): Promise<void> => {
    if (currentRun !== null) return currentRun;
    if (phase === 'ready' && loaded.size === serviceKeys.length) return Promise.resolve();
    const keys = serviceKeys.filter((key) => !loaded.has(key));
    const runPromise = run(keys).finally(() => {
      if (currentRun === runPromise) currentRun = null;
    });
    currentRun = runPromise;
    return runPromise;
  };

  const retryFailed = (): Promise<void> => {
    if (currentRun !== null) return currentRun;
    const keys = serviceKeys.filter((key) => failures.has(key));
    if (keys.length === 0) return Promise.resolve();
    const runPromise = run(keys).finally(() => {
      if (currentRun === runPromise) currentRun = null;
    });
    currentRun = runPromise;
    return runPromise;
  };

  const cancel = (): void => {
    if (phase !== 'loading') return;
    cancelled = true;
    queue = [];
    phase = 'cancelled';
    publish();
  };

  return Object.freeze({
    getSnapshot,
    getDiagnostics,
    subscribe,
    start,
    retryFailed,
    cancel,
  });
};
