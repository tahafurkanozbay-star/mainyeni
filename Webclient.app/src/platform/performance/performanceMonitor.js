const VITAL_THRESHOLDS = Object.freeze({
  lcp: Object.freeze({ good: 2500, needsImprovement: 4000 }),
  cls: Object.freeze({ good: 0.1, needsImprovement: 0.25 }),
  inp: Object.freeze({ good: 200, needsImprovement: 500 })
});

const round = (value, digits = 1) => {
  if (!Number.isFinite(value)) return null;
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
};

const finiteOrNull = (value) => Number.isFinite(Number(value)) ? Number(value) : null;

export const rateWebVital = (name, value) => {
  const metric = String(name || '').toLowerCase();
  const numeric = Number(value);
  const thresholds = VITAL_THRESHOLDS[metric];
  if (!thresholds || !Number.isFinite(numeric)) return 'unknown';
  if (numeric <= thresholds.good) return 'good';
  if (numeric <= thresholds.needsImprovement) return 'needs-improvement';
  return 'poor';
};

const safeConnectionSnapshot = (navigatorRef) => {
  const connection = navigatorRef?.connection ||
    navigatorRef?.mozConnection ||
    navigatorRef?.webkitConnection;
  if (!connection) return null;

  return Object.freeze({
    effectiveType: typeof connection.effectiveType === 'string'
      ? connection.effectiveType.slice(0, 16)
      : null,
    downlinkMbps: finiteOrNull(connection.downlink),
    rttMs: finiteOrNull(connection.rtt),
    saveData: connection.saveData === true
  });
};

const safeMemorySnapshot = (performanceRef) => {
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
    utilization: used !== null && limit > 0 ? round(used / limit, 4) : null
  });
};

const createInitialState = () => ({
  firstContentfulPaintMs: null,
  largestContentfulPaintMs: null,
  cumulativeLayoutShift: 0,
  interactionToNextPaintMs: null,
  firstRenderMs: null,
  navigation: {
    ttfbMs: null,
    domContentLoadedMs: null,
    loadMs: null
  },
  longTasks: {
    count: 0,
    totalDurationMs: 0,
    maxDurationMs: 0
  },
  resources: {
    count: 0,
    transferBytes: 0,
    encodedBytes: 0,
    decodedBytes: 0,
    zeroTransferCount: 0,
    durationMs: 0
  }
});

const addResourceEntry = (state, entry) => {
  state.resources.count += 1;
  state.resources.transferBytes += Math.max(0, Number(entry.transferSize) || 0);
  state.resources.encodedBytes += Math.max(0, Number(entry.encodedBodySize) || 0);
  state.resources.decodedBytes += Math.max(0, Number(entry.decodedBodySize) || 0);
  state.resources.durationMs += Math.max(0, Number(entry.duration) || 0);
  if ((Number(entry.transferSize) || 0) === 0 && (Number(entry.decodedBodySize) || 0) > 0) {
    state.resources.zeroTransferCount += 1;
  }
};

const applyEntry = (state, type, entry) => {
  if (!entry) return;

  if (type === 'paint' && entry.name === 'first-contentful-paint') {
    state.firstContentfulPaintMs = Math.max(
      state.firstContentfulPaintMs || 0,
      Number(entry.startTime) || 0
    );
    return;
  }

  if (type === 'largest-contentful-paint') {
    state.largestContentfulPaintMs = Math.max(
      state.largestContentfulPaintMs || 0,
      Number(entry.startTime) || 0
    );
    return;
  }

  if (type === 'layout-shift') {
    if (entry.hadRecentInput !== true) {
      state.cumulativeLayoutShift += Math.max(0, Number(entry.value) || 0);
    }
    return;
  }

  if (type === 'event') {
    if ((Number(entry.interactionId) || 0) > 0) {
      state.interactionToNextPaintMs = Math.max(
        state.interactionToNextPaintMs || 0,
        Number(entry.duration) || 0
      );
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

  if (type === 'resource') addResourceEntry(state, entry);
};

const collectExistingEntries = (performanceRef, state) => {
  if (!performanceRef?.getEntriesByType) return;

  const navigation = performanceRef.getEntriesByType('navigation')?.[0];
  if (navigation) {
    state.navigation.ttfbMs = Math.max(0, Number(navigation.responseStart) || 0);
    state.navigation.domContentLoadedMs = Math.max(
      0,
      Number(navigation.domContentLoadedEventEnd) || 0
    );
    state.navigation.loadMs = Math.max(0, Number(navigation.loadEventEnd) || 0);
  }

  (performanceRef.getEntriesByType('paint') || [])
    .forEach((entry) => applyEntry(state, 'paint', entry));
  (performanceRef.getEntriesByType('resource') || [])
    .forEach((entry) => addResourceEntry(state, entry));
};

export const createPerformanceMonitor = (dependencies = {}) => {
  const performanceRef = dependencies.performanceRef ||
    (typeof performance !== 'undefined' ? performance : null);
  const PerformanceObserverRef = dependencies.PerformanceObserverRef ||
    (typeof PerformanceObserver !== 'undefined' ? PerformanceObserver : null);
  const navigatorRef = dependencies.navigatorRef ||
    (typeof navigator !== 'undefined' ? navigator : null);
  const state = createInitialState();
  const observers = [];
  let started = false;
  let startedAt = null;

  const observe = (type, options = {}) => {
    if (!PerformanceObserverRef) return;
    try {
      const observer = new PerformanceObserverRef((list) => {
        const entries = typeof list?.getEntries === 'function' ? list.getEntries() : [];
        entries.forEach((entry) => applyEntry(state, type, entry));
      });
      observer.observe({ type, buffered: options.buffered !== false, ...options.observe });
      observers.push(observer);
    } catch (error) {
      // Browser support differs across entry types. Unsupported observers are optional and should
      // never prevent the application from rendering.
    }
  };

  const start = () => {
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

  const markRenderComplete = () => {
    if (state.firstRenderMs !== null) return state.firstRenderMs;
    const now = typeof performanceRef?.now === 'function' ? performanceRef.now() : 0;
    state.firstRenderMs = Math.max(0, now - (startedAt || 0));
    return state.firstRenderMs;
  };

  const snapshot = () => {
    const resources = state.resources;
    const cacheLikeRatio = resources.count > 0
      ? round(resources.zeroTransferCount / resources.count, 4)
      : null;

    return Object.freeze({
      timestamp: Date.now(),
      startup: Object.freeze({
        firstRenderMs: round(state.firstRenderMs),
        firstContentfulPaintMs: round(state.firstContentfulPaintMs),
        ttfbMs: round(state.navigation.ttfbMs),
        domContentLoadedMs: round(state.navigation.domContentLoadedMs),
        loadMs: round(state.navigation.loadMs)
      }),
      coreWebVitals: Object.freeze({
        lcp: Object.freeze({
          value: round(state.largestContentfulPaintMs),
          rating: rateWebVital('lcp', state.largestContentfulPaintMs)
        }),
        cls: Object.freeze({
          value: round(state.cumulativeLayoutShift, 4),
          rating: rateWebVital('cls', state.cumulativeLayoutShift)
        }),
        inp: Object.freeze({
          value: round(state.interactionToNextPaintMs),
          rating: rateWebVital('inp', state.interactionToNextPaintMs)
        })
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
        cacheLikeRatio
      }),
      memory: safeMemorySnapshot(performanceRef),
      network: safeConnectionSnapshot(navigatorRef)
    });
  };

  const stop = () => {
    observers.splice(0).forEach((observer) => {
      try { observer.disconnect(); } catch (error) { /* optional observer cleanup */ }
    });
    started = false;
  };

  return Object.freeze({
    start,
    stop,
    markRenderComplete,
    snapshot,
    isStarted: () => started
  });
};

export const performanceMonitor = createPerformanceMonitor();
