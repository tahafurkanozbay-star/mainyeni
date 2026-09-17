export type WebVitalRating = 'good' | 'needs-improvement' | 'poor' | 'unknown';

interface Threshold {
  readonly good: number;
  readonly needsImprovement: number;
}

interface MemoryInfoLike {
  readonly usedJSHeapSize?: number;
  readonly totalJSHeapSize?: number;
  readonly jsHeapSizeLimit?: number;
}

interface PerformanceLike {
  readonly memory?: MemoryInfoLike;
  now?: () => number;
  getEntriesByType?: (type: string) => PerformanceEntry[];
}

interface NetworkInfoLike {
  readonly effectiveType?: string;
  readonly downlink?: number;
  readonly rtt?: number;
  readonly saveData?: boolean;
}

interface NavigatorLike {
  readonly connection?: NetworkInfoLike;
  readonly mozConnection?: NetworkInfoLike;
  readonly webkitConnection?: NetworkInfoLike;
}

interface ResourceLike extends PerformanceEntry {
  readonly transferSize?: number;
  readonly encodedBodySize?: number;
  readonly decodedBodySize?: number;
}

interface LayoutShiftLike extends PerformanceEntry {
  readonly hadRecentInput?: boolean;
  readonly value?: number;
}

interface EventTimingLike extends PerformanceEntry {
  readonly interactionId?: number;
}

interface PerformanceMonitorState {
  firstContentfulPaintMs: number | null;
  largestContentfulPaintMs: number | null;
  cumulativeLayoutShift: number;
  interactionToNextPaintMs: number | null;
  firstRenderMs: number | null;
  navigation: {
    ttfbMs: number | null;
    domContentLoadedMs: number | null;
    loadMs: number | null;
  };
  longTasks: {
    count: number;
    totalDurationMs: number;
    maxDurationMs: number;
  };
  resources: {
    count: number;
    transferBytes: number;
    encodedBytes: number;
    decodedBytes: number;
    zeroTransferCount: number;
    durationMs: number;
  };
}

export interface PerformanceMonitorDependencies {
  readonly performanceRef?: PerformanceLike | null;
  readonly PerformanceObserverRef?: typeof PerformanceObserver | null;
  readonly navigatorRef?: NavigatorLike | null;
  readonly now?: () => number;
}

export interface PerformanceSnapshot {
  readonly timestamp: number;
  readonly startup: Readonly<{
    firstRenderMs: number | null;
    firstContentfulPaintMs: number | null;
    ttfbMs: number | null;
    domContentLoadedMs: number | null;
    loadMs: number | null;
  }>;
  readonly coreWebVitals: Readonly<{
    lcp: Readonly<{ value: number | null; rating: WebVitalRating }>;
    cls: Readonly<{ value: number | null; rating: WebVitalRating }>;
    inp: Readonly<{ value: number | null; rating: WebVitalRating }>;
  }>;
  readonly longTasks: Readonly<{
    count: number;
    totalDurationMs: number | null;
    maxDurationMs: number | null;
  }>;
  readonly resources: Readonly<{
    count: number;
    transferBytes: number;
    encodedBytes: number;
    decodedBytes: number;
    totalDurationMs: number | null;
    zeroTransferCount: number;
    cacheLikeRatio: number | null;
  }>;
  readonly memory: Readonly<{
    usedBytes: number | null;
    totalBytes: number | null;
    limitBytes: number | null;
    utilization: number | null;
  }> | null;
  readonly network: Readonly<{
    effectiveType: string | null;
    downlinkMbps: number | null;
    rttMs: number | null;
    saveData: boolean;
  }> | null;
}

export interface PerformanceMonitor {
  readonly start: () => boolean;
  readonly stop: () => void;
  readonly markRenderComplete: () => number;
  readonly snapshot: () => PerformanceSnapshot;
  readonly isStarted: () => boolean;
  readonly reset: () => void;
}

const VITAL_THRESHOLDS: Readonly<Record<string, Threshold>> = Object.freeze({
  lcp: Object.freeze({ good: 2500, needsImprovement: 4000 }),
  cls: Object.freeze({ good: 0.1, needsImprovement: 0.25 }),
  inp: Object.freeze({ good: 200, needsImprovement: 500 }),
});

const round = (value: unknown, digits = 1): number | null => {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  const scale = 10 ** digits;
  return Math.round(numeric * scale) / scale;
};

const finiteOrNull = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
};

export const rateWebVital = (name: unknown, value: unknown): WebVitalRating => {
  const metric = String(name || '').toLowerCase();
  const thresholds = VITAL_THRESHOLDS[metric];
  if (!thresholds || value === null || value === undefined || value === '') return 'unknown';
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 'unknown';
  if (numeric <= thresholds.good) return 'good';
  if (numeric <= thresholds.needsImprovement) return 'needs-improvement';
  return 'poor';
};

const safeConnectionSnapshot = (navigatorRef: NavigatorLike | null): PerformanceSnapshot['network'] => {
  const connection = navigatorRef?.connection ?? navigatorRef?.mozConnection ?? navigatorRef?.webkitConnection;
  if (!connection) return null;
  return Object.freeze({
    effectiveType: typeof connection.effectiveType === 'string' ? connection.effectiveType.slice(0, 16) : null,
    downlinkMbps: finiteOrNull(connection.downlink),
    rttMs: finiteOrNull(connection.rtt),
    saveData: connection.saveData === true,
  });
};

const safeMemorySnapshot = (performanceRef: PerformanceLike | null): PerformanceSnapshot['memory'] => {
  const memory = performanceRef?.memory;
  if (!memory) return null;
  const used = finiteOrNull(memory.usedJSHeapSize);
  const total = finiteOrNull(memory.totalJSHeapSize);
  const limit = finiteOrNull(memory.jsHeapSizeLimit);
  if (used === null && total === null && limit === null) return null;
  return Object.freeze({
    usedBytes: used,
    totalBytes: total,
    limitBytes: limit,
    utilization: used !== null && limit !== null && limit > 0 ? round(used / limit, 4) : null,
  });
};

const createInitialState = (): PerformanceMonitorState => ({
  firstContentfulPaintMs: null,
  largestContentfulPaintMs: null,
  cumulativeLayoutShift: 0,
  interactionToNextPaintMs: null,
  firstRenderMs: null,
  navigation: { ttfbMs: null, domContentLoadedMs: null, loadMs: null },
  longTasks: { count: 0, totalDurationMs: 0, maxDurationMs: 0 },
  resources: {
    count: 0,
    transferBytes: 0,
    encodedBytes: 0,
    decodedBytes: 0,
    zeroTransferCount: 0,
    durationMs: 0,
  },
});

const addResourceEntry = (state: PerformanceMonitorState, entry: ResourceLike): void => {
  state.resources.count += 1;
  state.resources.transferBytes += Math.max(0, Number(entry.transferSize) || 0);
  state.resources.encodedBytes += Math.max(0, Number(entry.encodedBodySize) || 0);
  state.resources.decodedBytes += Math.max(0, Number(entry.decodedBodySize) || 0);
  state.resources.durationMs += Math.max(0, Number(entry.duration) || 0);
  if ((Number(entry.transferSize) || 0) === 0 && (Number(entry.decodedBodySize) || 0) > 0) {
    state.resources.zeroTransferCount += 1;
  }
};

const applyEntry = (state: PerformanceMonitorState, type: string, entry: PerformanceEntry): void => {
  if (type === 'paint' && entry.name === 'first-contentful-paint') {
    state.firstContentfulPaintMs = Math.max(state.firstContentfulPaintMs ?? 0, Number(entry.startTime) || 0);
    return;
  }
  if (type === 'largest-contentful-paint') {
    state.largestContentfulPaintMs = Math.max(state.largestContentfulPaintMs ?? 0, Number(entry.startTime) || 0);
    return;
  }
  if (type === 'layout-shift') {
    const shift = entry as LayoutShiftLike;
    if (shift.hadRecentInput !== true) state.cumulativeLayoutShift += Math.max(0, Number(shift.value) || 0);
    return;
  }
  if (type === 'event') {
    const event = entry as EventTimingLike;
    if ((Number(event.interactionId) || 0) > 0) {
      state.interactionToNextPaintMs = Math.max(state.interactionToNextPaintMs ?? 0, Number(event.duration) || 0);
    }
    return;
  }
  if (type === 'longtask') {
    const duration = Math.max(0, Number(entry.duration) || 0);
    state.longTasks.count += 1;
    state.longTasks.totalDurationMs += duration;
    state.longTasks.maxDurationMs = Math.max(state.longTasks.maxDurationMs, duration);
    return;
  }
  if (type === 'resource') addResourceEntry(state, entry as ResourceLike);
};

const collectExistingEntries = (performanceRef: PerformanceLike | null, state: PerformanceMonitorState): void => {
  if (!performanceRef?.getEntriesByType) return;
  const navigation = performanceRef.getEntriesByType('navigation')?.[0] as PerformanceNavigationTiming | undefined;
  if (navigation) {
    state.navigation.ttfbMs = Math.max(0, Number(navigation.responseStart) || 0);
    state.navigation.domContentLoadedMs = Math.max(0, Number(navigation.domContentLoadedEventEnd) || 0);
    state.navigation.loadMs = Math.max(0, Number(navigation.loadEventEnd) || 0);
  }
  for (const entry of performanceRef.getEntriesByType('paint') || []) applyEntry(state, 'paint', entry);
};

export const createPerformanceMonitor = (dependencies: PerformanceMonitorDependencies = {}): PerformanceMonitor => {
  const performanceRef: PerformanceLike | null = dependencies.performanceRef === undefined
    ? (typeof performance !== 'undefined' ? performance as unknown as PerformanceLike : null)
    : dependencies.performanceRef;
  const PerformanceObserverRef = dependencies.PerformanceObserverRef === undefined
    ? (typeof PerformanceObserver !== 'undefined' ? PerformanceObserver : null)
    : dependencies.PerformanceObserverRef;
  const navigatorRef: NavigatorLike | null = dependencies.navigatorRef === undefined
    ? (typeof navigator !== 'undefined' ? navigator as unknown as NavigatorLike : null)
    : dependencies.navigatorRef;
  const wallTime = dependencies.now ?? Date.now;
  let state = createInitialState();
  const observers: PerformanceObserver[] = [];
  let started = false;
  let startedAt: number | null = null;

  const observe = (type: string, options: { buffered?: boolean; observe?: Readonly<Record<string, unknown>> } = {}): void => {
    if (!PerformanceObserverRef) return;
    try {
      const observer = new PerformanceObserverRef((list) => {
        const entries = typeof list?.getEntries === 'function' ? list.getEntries() : [];
        for (const entry of entries) applyEntry(state, type, entry);
      });
      const init = { type, buffered: options.buffered !== false, ...options.observe } as PerformanceObserverInit;
      observer.observe(init);
      observers.push(observer);
    } catch {
      // Entry support differs by browser; unsupported observers are non-fatal.
    }
  };

  const start = (): boolean => {
    if (started) return false;
    started = true;
    startedAt = typeof performanceRef?.now === 'function' ? performanceRef.now() : 0;
    collectExistingEntries(performanceRef, state);
    observe('paint');
    observe('largest-contentful-paint');
    observe('layout-shift');
    observe('event', { observe: { durationThreshold: 40 } });
    observe('longtask');
    observe('resource');
    return true;
  };

  const markRenderComplete = (): number => {
    if (state.firstRenderMs !== null) return state.firstRenderMs;
    const current = typeof performanceRef?.now === 'function' ? performanceRef.now() : 0;
    state.firstRenderMs = Math.max(0, current - (startedAt ?? 0));
    return state.firstRenderMs;
  };

  const snapshot = (): PerformanceSnapshot => {
    const resources = state.resources;
    const cacheLikeRatio = resources.count > 0 ? round(resources.zeroTransferCount / resources.count, 4) : null;
    return Object.freeze({
      timestamp: wallTime(),
      startup: Object.freeze({
        firstRenderMs: round(state.firstRenderMs),
        firstContentfulPaintMs: round(state.firstContentfulPaintMs),
        ttfbMs: round(state.navigation.ttfbMs),
        domContentLoadedMs: round(state.navigation.domContentLoadedMs),
        loadMs: round(state.navigation.loadMs),
      }),
      coreWebVitals: Object.freeze({
        lcp: Object.freeze({ value: round(state.largestContentfulPaintMs), rating: rateWebVital('lcp', state.largestContentfulPaintMs) }),
        cls: Object.freeze({ value: round(state.cumulativeLayoutShift, 4), rating: rateWebVital('cls', state.cumulativeLayoutShift) }),
        inp: Object.freeze({ value: round(state.interactionToNextPaintMs), rating: rateWebVital('inp', state.interactionToNextPaintMs) }),
      }),
      longTasks: Object.freeze({
        count: state.longTasks.count,
        totalDurationMs: round(state.longTasks.totalDurationMs),
        maxDurationMs: round(state.longTasks.maxDurationMs),
      }),
      resources: Object.freeze({
        count: resources.count,
        transferBytes: resources.transferBytes,
        encodedBytes: resources.encodedBytes,
        decodedBytes: resources.decodedBytes,
        totalDurationMs: round(resources.durationMs),
        zeroTransferCount: resources.zeroTransferCount,
        cacheLikeRatio,
      }),
      memory: safeMemorySnapshot(performanceRef),
      network: safeConnectionSnapshot(navigatorRef),
    });
  };

  const stop = (): void => {
    observers.splice(0).forEach((observer) => {
      try { observer.disconnect(); } catch { /* optional observer cleanup */ }
    });
    started = false;
  };

  const reset = (): void => {
    stop();
    state = createInitialState();
    startedAt = null;
  };

  return Object.freeze({ start, stop, markRenderComplete, snapshot, isStarted: () => started, reset });
};

export const performanceMonitor = createPerformanceMonitor();

export const performanceHealth = (snapshot: PerformanceSnapshot): Readonly<Record<string, WebVitalRating>> => Object.freeze({
  lcp: snapshot.coreWebVitals.lcp.rating,
  cls: snapshot.coreWebVitals.cls.rating,
  inp: snapshot.coreWebVitals.inp.rating,
});

export const hasPoorCoreWebVital = (snapshot: PerformanceSnapshot): boolean =>
  Object.values(performanceHealth(snapshot)).some((rating) => rating === 'poor');
