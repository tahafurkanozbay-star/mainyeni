import { deriveRuntimeBudget } from './runtimeBudget';
import type { RuntimeBudget, RuntimeCapabilitySample, RuntimeBudgetProfile } from './runtimeBudget';

export type VitalRating = 'good' | 'needs-improvement' | 'poor' | 'unknown';

export interface PerformanceMonitorDependencies {
  performanceRef?: Performance | null;
  PerformanceObserverRef?: typeof PerformanceObserver | null;
  navigatorRef?: Navigator | null;
  clock?: () => number;
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
    lcp: Readonly<{ value: number | null; rating: VitalRating }>;
    cls: Readonly<{ value: number | null; rating: VitalRating }>;
    inp: Readonly<{ value: number | null; rating: VitalRating }>;
  }>;
  readonly longTasks: Readonly<{ count: number; totalDurationMs: number | null; maxDurationMs: number | null }>;
  readonly resources: Readonly<{
    count: number;
    transferBytes: number;
    encodedBytes: number;
    decodedBytes: number;
    totalDurationMs: number | null;
    zeroTransferCount: number;
    cacheLikeRatio: number | null;
  }>;
  readonly memory: Readonly<Record<string, number | null>> | null;
  readonly network: Readonly<Record<string, string | number | boolean | null>> | null;
}

interface MonitorState {
  firstContentfulPaintMs: number | null;
  largestContentfulPaintMs: number | null;
  cumulativeLayoutShift: number;
  interactionToNextPaintMs: number | null;
  firstRenderMs: number | null;
  navigation: { ttfbMs: number | null; domContentLoadedMs: number | null; loadMs: number | null };
  longTasks: { count: number; totalDurationMs: number; maxDurationMs: number };
  resources: {
    count: number; transferBytes: number; encodedBytes: number; decodedBytes: number;
    zeroTransferCount: number; durationMs: number;
  };
}

const VITAL_THRESHOLDS = Object.freeze({
  lcp: Object.freeze({ good: 2500, needsImprovement: 4000 }),
  cls: Object.freeze({ good: 0.1, needsImprovement: 0.25 }),
  inp: Object.freeze({ good: 200, needsImprovement: 500 })
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

export const rateWebVital = (name: unknown, value: unknown): VitalRating => {
  const metric = String(name || '').toLowerCase() as keyof typeof VITAL_THRESHOLDS;
  const thresholds = VITAL_THRESHOLDS[metric];
  const numeric = finiteOrNull(value);
  if (!thresholds || numeric === null) return 'unknown';
  if (numeric <= thresholds.good) return 'good';
  if (numeric <= thresholds.needsImprovement) return 'needs-improvement';
  return 'poor';
};

const connectionOf = (navigatorRef: Navigator | null): Record<string, unknown> | null => {
  const candidate = navigatorRef as Navigator & {
    connection?: Record<string, unknown>;
    mozConnection?: Record<string, unknown>;
    webkitConnection?: Record<string, unknown>;
    deviceMemory?: number;
  };
  return candidate?.connection || candidate?.mozConnection || candidate?.webkitConnection || null;
};

const safeConnectionSnapshot = (navigatorRef: Navigator | null) => {
  const connection = connectionOf(navigatorRef);
  if (!connection) return null;
  return Object.freeze({
    effectiveType: typeof connection.effectiveType === 'string' ? connection.effectiveType.slice(0, 16) : null,
    downlinkMbps: finiteOrNull(connection.downlink),
    rttMs: finiteOrNull(connection.rtt),
    saveData: connection.saveData === true
  });
};

const safeMemorySnapshot = (performanceRef: Performance | null) => {
  const performanceWithMemory = performanceRef as Performance & {
    memory?: { usedJSHeapSize?: number; totalJSHeapSize?: number; jsHeapSizeLimit?: number };
  };
  const memory = performanceWithMemory?.memory;
  if (!memory) return null;
  const used = finiteOrNull(memory.usedJSHeapSize);
  const total = finiteOrNull(memory.totalJSHeapSize);
  const limit = finiteOrNull(memory.jsHeapSizeLimit);
  if (used === null && total === null && limit === null) return null;
  return Object.freeze({
    usedBytes: used,
    totalBytes: total,
    limitBytes: limit,
    utilization: used !== null && limit !== null && limit > 0 ? round(used / limit, 4) : null
  });
};

const createInitialState = (): MonitorState => ({
  firstContentfulPaintMs: null,
  largestContentfulPaintMs: null,
  cumulativeLayoutShift: 0,
  interactionToNextPaintMs: null,
  firstRenderMs: null,
  navigation: { ttfbMs: null, domContentLoadedMs: null, loadMs: null },
  longTasks: { count: 0, totalDurationMs: 0, maxDurationMs: 0 },
  resources: { count: 0, transferBytes: 0, encodedBytes: 0, decodedBytes: 0, zeroTransferCount: 0, durationMs: 0 }
});

const applyEntry = (state: MonitorState, type: string, entry: PerformanceEntry & Record<string, unknown>): void => {
  if (!entry) return;
  if (type === 'paint' && entry.name === 'first-contentful-paint') {
    state.firstContentfulPaintMs = Math.max(state.firstContentfulPaintMs || 0, Number(entry.startTime) || 0);
  } else if (type === 'largest-contentful-paint') {
    state.largestContentfulPaintMs = Math.max(state.largestContentfulPaintMs || 0, Number(entry.startTime) || 0);
  } else if (type === 'layout-shift' && entry.hadRecentInput !== true) {
    state.cumulativeLayoutShift += Math.max(0, Number(entry.value) || 0);
  } else if (type === 'event' && (Number(entry.interactionId) || 0) > 0) {
    state.interactionToNextPaintMs = Math.max(state.interactionToNextPaintMs || 0, Number(entry.duration) || 0);
  } else if (type === 'longtask') {
    const duration = Math.max(0, Number(entry.duration) || 0);
    state.longTasks.count += 1;
    state.longTasks.totalDurationMs += duration;
    state.longTasks.maxDurationMs = Math.max(state.longTasks.maxDurationMs, duration);
  } else if (type === 'resource') {
    const transfer = Math.max(0, Number(entry.transferSize) || 0);
    const decoded = Math.max(0, Number(entry.decodedBodySize) || 0);
    state.resources.count += 1;
    state.resources.transferBytes += transfer;
    state.resources.encodedBytes += Math.max(0, Number(entry.encodedBodySize) || 0);
    state.resources.decodedBytes += decoded;
    state.resources.durationMs += Math.max(0, Number(entry.duration) || 0);
    if (transfer === 0 && decoded > 0) state.resources.zeroTransferCount += 1;
  }
};

export const capabilitySampleFromSnapshot = (
  snapshot: PerformanceSnapshot,
  navigatorRef: Navigator | null = typeof navigator !== 'undefined' ? navigator : null
): RuntimeCapabilitySample => {
  const connection = snapshot.network;
  const memory = snapshot.memory;
  const nav = navigatorRef as Navigator & { deviceMemory?: number };
  return Object.freeze({
    hardwareConcurrency: finiteOrNull(nav?.hardwareConcurrency),
    deviceMemoryGb: finiteOrNull(nav?.deviceMemory),
    effectiveType: typeof connection?.effectiveType === 'string' ? connection.effectiveType : null,
    saveData: connection?.saveData === true,
    downlinkMbps: finiteOrNull(connection?.downlinkMbps),
    rttMs: finiteOrNull(connection?.rttMs),
    heapUtilization: finiteOrNull(memory?.utilization),
    longTaskCount: snapshot.longTasks.count,
    longTaskMaxMs: finiteOrNull(snapshot.longTasks.maxDurationMs)
  });
};

export const createPerformanceMonitor = (dependencies: PerformanceMonitorDependencies = {}) => {
  const performanceRef = dependencies.performanceRef || (typeof performance !== 'undefined' ? performance : null);
  const PerformanceObserverRef = dependencies.PerformanceObserverRef ||
    (typeof PerformanceObserver !== 'undefined' ? PerformanceObserver : null);
  const navigatorRef = dependencies.navigatorRef || (typeof navigator !== 'undefined' ? navigator : null);
  const clock = typeof dependencies.clock === 'function' ? dependencies.clock : () => Date.now();
  const state = createInitialState();
  const observers: PerformanceObserver[] = [];
  let started = false;
  let startedAt: number | null = null;

  const observe = (type: string, options: { buffered?: boolean; observe?: Record<string, unknown> } = {}): void => {
    if (!PerformanceObserverRef) return;
    try {
      const observer = new PerformanceObserverRef((list) => {
        const entries = typeof list?.getEntries === 'function' ? list.getEntries() : [];
        entries.forEach((entry) => applyEntry(state, type, entry as PerformanceEntry & Record<string, unknown>));
      });
      observer.observe({ type, buffered: options.buffered !== false, ...(options.observe || {}) } as PerformanceObserverInit);
      observers.push(observer);
    } catch (_error) {
      // Entry-type support is browser specific and optional.
    }
  };

  const start = (): boolean => {
    if (started) return false;
    started = true;
    startedAt = typeof performanceRef?.now === 'function' ? performanceRef.now() : 0;
    const navigation = performanceRef?.getEntriesByType?.('navigation')?.[0] as PerformanceEntry & Record<string, unknown> | undefined;
    if (navigation) {
      state.navigation.ttfbMs = Math.max(0, Number(navigation.responseStart) || 0);
      state.navigation.domContentLoadedMs = Math.max(0, Number(navigation.domContentLoadedEventEnd) || 0);
      state.navigation.loadMs = Math.max(0, Number(navigation.loadEventEnd) || 0);
    }
    (performanceRef?.getEntriesByType?.('paint') || []).forEach((entry) =>
      applyEntry(state, 'paint', entry as PerformanceEntry & Record<string, unknown>));
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
    state.firstRenderMs = Math.max(0, current - (startedAt || 0));
    return state.firstRenderMs;
  };

  const snapshot = (): PerformanceSnapshot => {
    const resources = state.resources;
    return Object.freeze({
      timestamp: clock(),
      startup: Object.freeze({
        firstRenderMs: round(state.firstRenderMs),
        firstContentfulPaintMs: round(state.firstContentfulPaintMs),
        ttfbMs: round(state.navigation.ttfbMs),
        domContentLoadedMs: round(state.navigation.domContentLoadedMs),
        loadMs: round(state.navigation.loadMs)
      }),
      coreWebVitals: Object.freeze({
        lcp: Object.freeze({ value: round(state.largestContentfulPaintMs), rating: rateWebVital('lcp', state.largestContentfulPaintMs) }),
        cls: Object.freeze({ value: round(state.cumulativeLayoutShift, 4), rating: rateWebVital('cls', state.cumulativeLayoutShift) }),
        inp: Object.freeze({ value: round(state.interactionToNextPaintMs), rating: rateWebVital('inp', state.interactionToNextPaintMs) })
      }),
      longTasks: Object.freeze({
        count: state.longTasks.count,
        totalDurationMs: round(state.longTasks.totalDurationMs),
        maxDurationMs: round(state.longTasks.maxDurationMs)
      }),
      resources: Object.freeze({
        count: resources.count,
        transferBytes: resources.transferBytes,
        encodedBytes: resources.encodedBytes,
        decodedBytes: resources.decodedBytes,
        totalDurationMs: round(resources.durationMs),
        zeroTransferCount: resources.zeroTransferCount,
        cacheLikeRatio: resources.count > 0 ? round(resources.zeroTransferCount / resources.count, 4) : null
      }),
      memory: safeMemorySnapshot(performanceRef),
      network: safeConnectionSnapshot(navigatorRef)
    });
  };

  const budget = (profile: RuntimeBudgetProfile = 'balanced'): RuntimeBudget =>
    deriveRuntimeBudget(capabilitySampleFromSnapshot(snapshot(), navigatorRef), profile);

  const stop = (): void => {
    observers.splice(0).forEach((observer) => {
      try { observer.disconnect(); } catch (_error) { /* optional observer cleanup */ }
    });
    started = false;
  };

  return Object.freeze({ start, stop, markRenderComplete, snapshot, budget, isStarted: () => started });
};

export const performanceMonitor = createPerformanceMonitor();
