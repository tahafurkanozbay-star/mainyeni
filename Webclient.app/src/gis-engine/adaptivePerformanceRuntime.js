export const GIS_PERFORMANCE_PROFILE = Object.freeze({
  ECO: 'eco',
  BALANCED: 'balanced',
  QUALITY: 'quality',
});

const DEFAULTS = Object.freeze({
  sampleWindow: 90,
  longFrameMs: 34,
  criticalFrameMs: 80,
  recoveryFrameMs: 20,
  longFrameRatio: 0.18,
  criticalFrameRatio: 0.08,
  recoveryRatio: 0.06,
  minSamples: 24,
  cooldownMs: 5000,
  maxDeviceMemoryGb: 64,
});

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const finite = (value, fallback = null) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const now = () => (typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now());

const percentile = (values, ratio) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = clamp(Math.ceil(sorted.length * ratio) - 1, 0, sorted.length - 1);
  return sorted[index];
};

export const detectGisDeviceCapabilities = (environment = globalThis) => {
  const navigatorLike = environment?.navigator || {};
  const memory = clamp(finite(navigatorLike.deviceMemory, 4), 0.25, DEFAULTS.maxDeviceMemoryGb);
  const cores = clamp(Math.floor(finite(navigatorLike.hardwareConcurrency, 4)), 1, 128);
  const reducedMotion = Boolean(environment?.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches);
  const connection = navigatorLike.connection || navigatorLike.mozConnection || navigatorLike.webkitConnection || null;
  const saveData = Boolean(connection?.saveData);
  const effectiveType = String(connection?.effectiveType || '').toLowerCase();
  const constrainedNetwork = saveData || effectiveType === 'slow-2g' || effectiveType === '2g';
  const lowMemory = memory <= 2;
  const lowCpu = cores <= 2;
  const profile = lowMemory || lowCpu || constrainedNetwork || reducedMotion
    ? GIS_PERFORMANCE_PROFILE.ECO
    : memory >= 8 && cores >= 8 && !saveData
      ? GIS_PERFORMANCE_PROFILE.QUALITY
      : GIS_PERFORMANCE_PROFILE.BALANCED;

  return Object.freeze({
    memoryGb: memory,
    logicalCores: cores,
    reducedMotion,
    saveData,
    effectiveType: effectiveType || null,
    constrainedNetwork,
    profile,
  });
};

export const performanceBudgetForProfile = (profile, capabilities = {}) => {
  const memoryGb = finite(capabilities.memoryGb, 4);
  const base = profile === GIS_PERFORMANCE_PROFILE.ECO
    ? { maxConcurrentLayers: 2, maxResidentLayers: 8, maxQueryCacheBytes: 3 * 1024 * 1024, clusterThreshold: 350, maxVisibleFeatures: 2500, sceneQuality: 0.55, prefetch: false }
    : profile === GIS_PERFORMANCE_PROFILE.QUALITY
      ? { maxConcurrentLayers: 6, maxResidentLayers: 24, maxQueryCacheBytes: 16 * 1024 * 1024, clusterThreshold: 1400, maxVisibleFeatures: 12000, sceneQuality: 1, prefetch: true }
      : { maxConcurrentLayers: 4, maxResidentLayers: 16, maxQueryCacheBytes: 8 * 1024 * 1024, clusterThreshold: 800, maxVisibleFeatures: 6500, sceneQuality: 0.78, prefetch: true };

  const memoryFactor = clamp(memoryGb / 4, 0.5, 2);
  return Object.freeze({
    ...base,
    maxQueryCacheBytes: Math.round(base.maxQueryCacheBytes * memoryFactor),
    maxResidentLayers: Math.max(4, Math.round(base.maxResidentLayers * Math.sqrt(memoryFactor))),
  });
};

export const createAdaptivePerformanceRuntime = (configuration = {}) => {
  const clock = typeof configuration.now === 'function' ? configuration.now : now;
  const settings = { ...DEFAULTS, ...(configuration.settings || {}) };
  const capabilities = configuration.capabilities || detectGisDeviceCapabilities(configuration.environment || globalThis);
  let profile = configuration.profile || capabilities.profile;
  let budget = performanceBudgetForProfile(profile, capabilities);
  let lastTransitionAt = -Infinity;
  let destroyed = false;
  const frameSamples = [];
  const listeners = new Set();
  const metrics = { frames: 0, transitions: 0, droppedSamples: 0, lastFrameMs: null, maxFrameMs: 0 };

  const snapshot = () => {
    const longFrames = frameSamples.filter((value) => value >= settings.longFrameMs).length;
    const criticalFrames = frameSamples.filter((value) => value >= settings.criticalFrameMs).length;
    return Object.freeze({
      profile,
      budget,
      capabilities,
      sampleCount: frameSamples.length,
      averageFrameMs: frameSamples.length ? frameSamples.reduce((sum, value) => sum + value, 0) / frameSamples.length : 0,
      p95FrameMs: percentile(frameSamples, 0.95),
      longFrameRatio: frameSamples.length ? longFrames / frameSamples.length : 0,
      criticalFrameRatio: frameSamples.length ? criticalFrames / frameSamples.length : 0,
      metrics: { ...metrics },
    });
  };

  const emit = (reason) => {
    const state = snapshot();
    listeners.forEach((listener) => {
      try { listener(state, reason); } catch (error) { configuration.onListenerError?.(error); }
    });
    configuration.onChange?.(state, reason);
    return state;
  };

  const transition = (nextProfile, reason) => {
    if (destroyed || nextProfile === profile) return snapshot();
    profile = nextProfile;
    budget = performanceBudgetForProfile(profile, capabilities);
    lastTransitionAt = clock();
    metrics.transitions += 1;
    return emit(reason);
  };

  const evaluate = () => {
    if (frameSamples.length < settings.minSamples || clock() - lastTransitionAt < settings.cooldownMs) return snapshot();
    const state = snapshot();
    if (state.criticalFrameRatio >= settings.criticalFrameRatio || state.longFrameRatio >= settings.longFrameRatio || state.p95FrameMs >= settings.criticalFrameMs) {
      if (profile === GIS_PERFORMANCE_PROFILE.QUALITY) return transition(GIS_PERFORMANCE_PROFILE.BALANCED, 'frame-pressure');
      if (profile === GIS_PERFORMANCE_PROFILE.BALANCED) return transition(GIS_PERFORMANCE_PROFILE.ECO, 'frame-pressure');
      return state;
    }
    if (state.longFrameRatio <= settings.recoveryRatio && state.p95FrameMs <= settings.recoveryFrameMs && !capabilities.constrainedNetwork && !capabilities.reducedMotion) {
      if (profile === GIS_PERFORMANCE_PROFILE.ECO) return transition(GIS_PERFORMANCE_PROFILE.BALANCED, 'recovered');
      if (profile === GIS_PERFORMANCE_PROFILE.BALANCED && capabilities.memoryGb >= 8 && capabilities.logicalCores >= 8) {
        return transition(GIS_PERFORMANCE_PROFILE.QUALITY, 'recovered');
      }
    }
    return state;
  };

  const recordFrame = (durationMs) => {
    if (destroyed) return snapshot();
    const duration = finite(durationMs);
    if (duration === null || duration < 0 || duration > 10000) {
      metrics.droppedSamples += 1;
      return snapshot();
    }
    frameSamples.push(duration);
    if (frameSamples.length > settings.sampleWindow) frameSamples.shift();
    metrics.frames += 1;
    metrics.lastFrameMs = duration;
    metrics.maxFrameMs = Math.max(metrics.maxFrameMs, duration);
    return evaluate();
  };

  const resetSamples = () => { frameSamples.length = 0; };

  return Object.freeze({
    recordFrame,
    evaluate,
    getSnapshot: snapshot,
    getProfile: () => profile,
    getBudget: () => budget,
    setProfile: (nextProfile, reason = 'manual') => {
      if (!Object.values(GIS_PERFORMANCE_PROFILE).includes(nextProfile)) throw new TypeError(`Unknown GIS performance profile: ${nextProfile}`);
      return transition(nextProfile, reason);
    },
    subscribe: (listener) => {
      if (destroyed || typeof listener !== 'function') return () => {};
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    resetSamples,
    destroy: () => { destroyed = true; listeners.clear(); resetSamples(); },
  });
};
