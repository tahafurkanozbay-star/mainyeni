export type ViewportResultFeatureId = string | number;

export interface ViewportResultFeature<TPayload = unknown> {
  readonly id: ViewportResultFeatureId;
  readonly payload: TPayload;
  readonly estimatedBytes?: number;
}

export interface ViewportResultWindowConfiguration {
  readonly maximumWindows: number;
  readonly maximumPagesPerWindow: number;
  readonly maximumFeaturesPerWindow: number;
  readonly maximumBytesPerWindow: number;
  readonly maximumTotalFeatures: number;
  readonly maximumTotalBytes: number;
  readonly maximumWindowAgeMs: number;
}

export interface ViewportResultPageInput<TPayload = unknown> {
  readonly windowKey: string;
  readonly generation: number;
  readonly pageIndex: number;
  readonly features: readonly ViewportResultFeature<TPayload>[];
  readonly complete?: boolean;
  readonly timestamp?: number;
}

export interface ViewportResultCommit {
  readonly windowKey: string;
  readonly generation: number;
  readonly pageIndex: number;
  readonly accepted: number;
  readonly replaced: number;
  readonly duplicatePage: boolean;
  readonly stale: boolean;
  readonly featureCount: number;
  readonly estimatedBytes: number;
  readonly complete: boolean;
  readonly evictedWindows: readonly string[];
}

export interface ViewportResultWindowSnapshot {
  readonly key: string;
  readonly generation: number;
  readonly pages: number;
  readonly featureCount: number;
  readonly estimatedBytes: number;
  readonly complete: boolean;
  readonly pinned: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly lastAccessAt: number;
}

export interface ViewportResultRuntimeSnapshot {
  readonly windows: number;
  readonly totalFeatures: number;
  readonly totalEstimatedBytes: number;
  readonly acceptedFeatures: number;
  readonly replacedFeatures: number;
  readonly staleCommits: number;
  readonly duplicatePages: number;
  readonly evictions: number;
  readonly windowsSnapshot: readonly ViewportResultWindowSnapshot[];
}

export class ViewportResultWindowError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = 'ViewportResultWindowError';
    this.code = code;
  }
}

interface StoredFeature<TPayload> {
  readonly id: ViewportResultFeatureId;
  payload: TPayload;
  estimatedBytes: number;
  firstPage: number;
  lastPage: number;
  sequence: number;
}

interface WindowState<TPayload> {
  key: string;
  generation: number;
  pages: Set<number>;
  features: Map<string, StoredFeature<TPayload>>;
  complete: boolean;
  pinned: boolean;
  createdAt: number;
  updatedAt: number;
  lastAccessAt: number;
  estimatedBytes: number;
  sequence: number;
}

const DEFAULTS: ViewportResultWindowConfiguration = Object.freeze({
  maximumWindows: 16,
  maximumPagesPerWindow: 64,
  maximumFeaturesPerWindow: 10_000,
  maximumBytesPerWindow: 24 * 1024 * 1024,
  maximumTotalFeatures: 40_000,
  maximumTotalBytes: 96 * 1024 * 1024,
  maximumWindowAgeMs: 5 * 60_000,
});

const boundedInteger = (value: number, label: string, maximum: number): number => {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new RangeError(`${label} must be a positive safe integer <= ${maximum}`);
  }
  return value;
};

const normalizeConfiguration = (
  input: Partial<ViewportResultWindowConfiguration> = {},
): ViewportResultWindowConfiguration => {
  const value = { ...DEFAULTS, ...input };
  const maximumWindows = boundedInteger(value.maximumWindows, 'maximumWindows', 1_024);
  const maximumPagesPerWindow = boundedInteger(value.maximumPagesPerWindow, 'maximumPagesPerWindow', 10_000);
  const maximumFeaturesPerWindow = boundedInteger(value.maximumFeaturesPerWindow, 'maximumFeaturesPerWindow', 1_000_000);
  const maximumBytesPerWindow = boundedInteger(value.maximumBytesPerWindow, 'maximumBytesPerWindow', 2_147_483_647);
  const maximumTotalFeatures = boundedInteger(value.maximumTotalFeatures, 'maximumTotalFeatures', 5_000_000);
  const maximumTotalBytes = boundedInteger(value.maximumTotalBytes, 'maximumTotalBytes', 2_147_483_647);
  const maximumWindowAgeMs = boundedInteger(value.maximumWindowAgeMs, 'maximumWindowAgeMs', 24 * 60 * 60_000);
  if (maximumFeaturesPerWindow > maximumTotalFeatures) {
    throw new RangeError('maximumFeaturesPerWindow cannot exceed maximumTotalFeatures');
  }
  if (maximumBytesPerWindow > maximumTotalBytes) {
    throw new RangeError('maximumBytesPerWindow cannot exceed maximumTotalBytes');
  }
  return Object.freeze({
    maximumWindows,
    maximumPagesPerWindow,
    maximumFeaturesPerWindow,
    maximumBytesPerWindow,
    maximumTotalFeatures,
    maximumTotalBytes,
    maximumWindowAgeMs,
  });
};

const normalizeKey = (value: unknown): string => {
  const key = String(value ?? '').trim();
  if (!key) throw new TypeError('result window key is required');
  if (key.length > 1024) throw new RangeError('result window key exceeds 1024 characters');
  return key;
};

const normalizeGeneration = (value: number): number => {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError('generation must be a non-negative safe integer');
  return value;
};

const normalizePage = (value: number): number => {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError('pageIndex must be a non-negative safe integer');
  return value;
};

const normalizeTimestamp = (value: number): number => {
  if (!Number.isFinite(value) || value < 0) throw new RangeError('timestamp must be finite and non-negative');
  return value;
};

const canonicalId = (value: ViewportResultFeatureId): string => {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('numeric feature id must be finite');
    return `number:${Object.is(value, -0) ? 0 : value}`;
  }
  const normalized = value.trim();
  if (!normalized) throw new TypeError('string feature id cannot be empty');
  if (normalized.length > 512) throw new RangeError('feature id exceeds 512 characters');
  return `string:${normalized}`;
};

const estimatePayloadBytes = (payload: unknown): number => {
  if (payload === null || payload === undefined) return 4;
  if (typeof payload === 'string') return Math.max(2, payload.length * 2);
  if (typeof payload === 'number' || typeof payload === 'boolean') return 8;
  if (payload instanceof ArrayBuffer) return payload.byteLength;
  if (ArrayBuffer.isView(payload)) return payload.byteLength;
  try {
    const serialized = JSON.stringify(payload);
    return Math.max(8, serialized.length * 2);
  } catch {
    return 4096;
  }
};

const featureBytes = <TPayload>(feature: ViewportResultFeature<TPayload>): number => {
  if (feature.estimatedBytes !== undefined) {
    if (!Number.isSafeInteger(feature.estimatedBytes) || feature.estimatedBytes < 0) {
      throw new RangeError('feature estimatedBytes must be a non-negative safe integer');
    }
    return feature.estimatedBytes;
  }
  return estimatePayloadBytes(feature.payload);
};

const snapshotWindow = <TPayload>(window: WindowState<TPayload>): ViewportResultWindowSnapshot => Object.freeze({
  key: window.key,
  generation: window.generation,
  pages: window.pages.size,
  featureCount: window.features.size,
  estimatedBytes: window.estimatedBytes,
  complete: window.complete,
  pinned: window.pinned,
  createdAt: window.createdAt,
  updatedAt: window.updatedAt,
  lastAccessAt: window.lastAccessAt,
});

export class ViewportResultWindowRuntime<TPayload = unknown> {
  readonly #configuration: ViewportResultWindowConfiguration;
  readonly #now: () => number;
  readonly #windows = new Map<string, WindowState<TPayload>>();
  #sequence = 0;
  #acceptedFeatures = 0;
  #replacedFeatures = 0;
  #staleCommits = 0;
  #duplicatePages = 0;
  #evictions = 0;
  #disposed = false;

  constructor(
    configuration: Partial<ViewportResultWindowConfiguration> = {},
    now: () => number = () => Date.now(),
  ) {
    this.#configuration = normalizeConfiguration(configuration);
    this.#now = now;
  }

  get configuration(): ViewportResultWindowConfiguration {
    return this.#configuration;
  }

  begin(windowKey: string, generation: number, options: Readonly<{ pinned?: boolean; timestamp?: number }> = {}): ViewportResultWindowSnapshot {
    this.#assertActive();
    const key = normalizeKey(windowKey);
    const normalizedGeneration = normalizeGeneration(generation);
    const timestamp = normalizeTimestamp(options.timestamp ?? this.#now());
    this.#expire(timestamp);
    const existing = this.#windows.get(key);
    if (existing && normalizedGeneration < existing.generation) return snapshotWindow(existing);
    if (existing && normalizedGeneration === existing.generation) {
      existing.pinned = options.pinned ?? existing.pinned;
      existing.lastAccessAt = timestamp;
      return snapshotWindow(existing);
    }
    if (existing) this.#windows.delete(key);
    const state: WindowState<TPayload> = {
      key,
      generation: normalizedGeneration,
      pages: new Set(),
      features: new Map(),
      complete: false,
      pinned: options.pinned === true,
      createdAt: timestamp,
      updatedAt: timestamp,
      lastAccessAt: timestamp,
      estimatedBytes: 0,
      sequence: this.#sequence++,
    };
    this.#windows.set(key, state);
    this.#enforceGlobalBudgets(new Set([key]));
    return snapshotWindow(state);
  }

  commitPage(input: ViewportResultPageInput<TPayload>): ViewportResultCommit {
    this.#assertActive();
    const key = normalizeKey(input.windowKey);
    const generation = normalizeGeneration(input.generation);
    const pageIndex = normalizePage(input.pageIndex);
    const timestamp = normalizeTimestamp(input.timestamp ?? this.#now());
    this.#expire(timestamp);

    let window = this.#windows.get(key);
    if (window && generation < window.generation) {
      this.#staleCommits += 1;
      return Object.freeze({
        windowKey: key,
        generation,
        pageIndex,
        accepted: 0,
        replaced: 0,
        duplicatePage: false,
        stale: true,
        featureCount: window.features.size,
        estimatedBytes: window.estimatedBytes,
        complete: window.complete,
        evictedWindows: Object.freeze([]),
      });
    }
    if (!window || generation > window.generation) {
      this.begin(key, generation, { timestamp });
      window = this.#windows.get(key);
    }
    if (!window) throw new ViewportResultWindowError('result window allocation failed', 'WINDOW_ALLOCATION_FAILED');

    if (window.pages.has(pageIndex)) {
      this.#duplicatePages += 1;
      window.lastAccessAt = timestamp;
      return Object.freeze({
        windowKey: key,
        generation,
        pageIndex,
        accepted: 0,
        replaced: 0,
        duplicatePage: true,
        stale: false,
        featureCount: window.features.size,
        estimatedBytes: window.estimatedBytes,
        complete: window.complete,
        evictedWindows: Object.freeze([]),
      });
    }
    if (window.pages.size >= this.#configuration.maximumPagesPerWindow) {
      throw new ViewportResultWindowError(
        `result window page budget exceeded (${this.#configuration.maximumPagesPerWindow})`,
        'PAGE_BUDGET_EXCEEDED',
      );
    }

    const staged = new Map<string, Readonly<{ feature: ViewportResultFeature<TPayload>; bytes: number }>>();
    for (const feature of input.features) {
      const id = canonicalId(feature.id);
      staged.set(id, Object.freeze({ feature, bytes: featureBytes(feature) }));
    }

    let projectedCount = window.features.size;
    let projectedBytes = window.estimatedBytes;
    for (const [id, entry] of staged) {
      const existing = window.features.get(id);
      if (existing) projectedBytes -= existing.estimatedBytes;
      else projectedCount += 1;
      projectedBytes += entry.bytes;
    }

    if (projectedCount > this.#configuration.maximumFeaturesPerWindow) {
      throw new ViewportResultWindowError(
        `result window feature budget exceeded (${this.#configuration.maximumFeaturesPerWindow})`,
        'FEATURE_BUDGET_EXCEEDED',
      );
    }
    if (projectedBytes > this.#configuration.maximumBytesPerWindow) {
      throw new ViewportResultWindowError(
        `result window byte budget exceeded (${this.#configuration.maximumBytesPerWindow})`,
        'BYTE_BUDGET_EXCEEDED',
      );
    }

    let accepted = 0;
    let replaced = 0;
    for (const [id, entry] of staged) {
      const existing = window.features.get(id);
      if (existing) {
        window.estimatedBytes -= existing.estimatedBytes;
        existing.payload = entry.feature.payload;
        existing.estimatedBytes = entry.bytes;
        existing.lastPage = pageIndex;
        window.estimatedBytes += entry.bytes;
        replaced += 1;
      } else {
        window.features.set(id, {
          id: entry.feature.id,
          payload: entry.feature.payload,
          estimatedBytes: entry.bytes,
          firstPage: pageIndex,
          lastPage: pageIndex,
          sequence: this.#sequence++,
        });
        window.estimatedBytes += entry.bytes;
        accepted += 1;
      }
    }

    window.pages.add(pageIndex);
    window.complete = window.complete || input.complete === true;
    window.updatedAt = timestamp;
    window.lastAccessAt = timestamp;
    this.#acceptedFeatures += accepted;
    this.#replacedFeatures += replaced;

    const evictedWindows = this.#enforceGlobalBudgets(new Set([key]));
    return Object.freeze({
      windowKey: key,
      generation,
      pageIndex,
      accepted,
      replaced,
      duplicatePage: false,
      stale: false,
      featureCount: window.features.size,
      estimatedBytes: window.estimatedBytes,
      complete: window.complete,
      evictedWindows,
    });
  }

  read(windowKey: string, generation?: number): readonly ViewportResultFeature<TPayload>[] {
    this.#assertActive();
    const key = normalizeKey(windowKey);
    const timestamp = normalizeTimestamp(this.#now());
    this.#expire(timestamp);
    const window = this.#windows.get(key);
    if (!window) return Object.freeze([]);
    if (generation !== undefined && normalizeGeneration(generation) !== window.generation) {
      return Object.freeze([]);
    }
    window.lastAccessAt = timestamp;
    return Object.freeze([...window.features.values()]
      .sort((left, right) => left.sequence - right.sequence)
      .map((feature) => Object.freeze({ id: feature.id, payload: feature.payload, estimatedBytes: feature.estimatedBytes })));
  }

  pin(windowKey: string, pinned = true): boolean {
    this.#assertActive();
    const window = this.#windows.get(normalizeKey(windowKey));
    if (!window) return false;
    window.pinned = pinned;
    window.lastAccessAt = normalizeTimestamp(this.#now());
    return true;
  }

  drop(windowKey: string, generation?: number): boolean {
    this.#assertActive();
    const key = normalizeKey(windowKey);
    const window = this.#windows.get(key);
    if (!window) return false;
    if (generation !== undefined && normalizeGeneration(generation) !== window.generation) return false;
    return this.#windows.delete(key);
  }

  clear(): number {
    this.#assertActive();
    const count = this.#windows.size;
    this.#windows.clear();
    return count;
  }

  snapshot(): ViewportResultRuntimeSnapshot {
    this.#assertActive();
    const timestamp = normalizeTimestamp(this.#now());
    this.#expire(timestamp);
    const windows = [...this.#windows.values()]
      .sort((left, right) => left.sequence - right.sequence)
      .map(snapshotWindow);
    let totalFeatures = 0;
    let totalEstimatedBytes = 0;
    for (const window of this.#windows.values()) {
      totalFeatures += window.features.size;
      totalEstimatedBytes += window.estimatedBytes;
    }
    return Object.freeze({
      windows: this.#windows.size,
      totalFeatures,
      totalEstimatedBytes,
      acceptedFeatures: this.#acceptedFeatures,
      replacedFeatures: this.#replacedFeatures,
      staleCommits: this.#staleCommits,
      duplicatePages: this.#duplicatePages,
      evictions: this.#evictions,
      windowsSnapshot: Object.freeze(windows),
    });
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#windows.clear();
  }

  #expire(timestamp: number): void {
    for (const [key, window] of this.#windows) {
      if (window.pinned) continue;
      if (timestamp - window.lastAccessAt > this.#configuration.maximumWindowAgeMs) {
        this.#windows.delete(key);
        this.#evictions += 1;
      }
    }
  }

  #totals(): Readonly<{ features: number; bytes: number }> {
    let features = 0;
    let bytes = 0;
    for (const window of this.#windows.values()) {
      features += window.features.size;
      bytes += window.estimatedBytes;
    }
    return Object.freeze({ features, bytes });
  }

  #enforceGlobalBudgets(protectedKeys: ReadonlySet<string>): readonly string[] {
    const evicted: string[] = [];
    let totals = this.#totals();
    const exceeded = (): boolean => (
      this.#windows.size > this.#configuration.maximumWindows
      || totals.features > this.#configuration.maximumTotalFeatures
      || totals.bytes > this.#configuration.maximumTotalBytes
    );

    while (exceeded()) {
      const candidate = [...this.#windows.values()]
        .filter((window) => !window.pinned && !protectedKeys.has(window.key))
        .sort((left, right) => (
          left.lastAccessAt - right.lastAccessAt
          || left.updatedAt - right.updatedAt
          || left.sequence - right.sequence
          || left.key.localeCompare(right.key)
        ))[0];
      if (!candidate) {
        throw new ViewportResultWindowError(
          'global result-window budget cannot be satisfied without evicting protected or pinned data',
          'GLOBAL_BUDGET_EXCEEDED',
        );
      }
      this.#windows.delete(candidate.key);
      evicted.push(candidate.key);
      this.#evictions += 1;
      totals = this.#totals();
    }
    return Object.freeze(evicted);
  }

  #assertActive(): void {
    if (this.#disposed) {
      throw new ViewportResultWindowError('viewport result window runtime is disposed', 'DISPOSED');
    }
  }
}

export const createViewportResultWindowRuntime = <TPayload = unknown>(
  configuration: Partial<ViewportResultWindowConfiguration> = {},
  now: () => number = () => Date.now(),
): ViewportResultWindowRuntime<TPayload> => new ViewportResultWindowRuntime(configuration, now);
