export const GIS_PERFORMANCE_PROFILE = Object.freeze({
  ECO: 'eco',
  BALANCED: 'balanced',
  QUALITY: 'quality',
});

export type GisPerformanceProfile = typeof GIS_PERFORMANCE_PROFILE[keyof typeof GIS_PERFORMANCE_PROFILE];

export interface GisNetworkInformationLike {
  saveData?: boolean;
  effectiveType?: string;
}

export interface GisNavigatorLike {
  deviceMemory?: number;
  hardwareConcurrency?: number;
  connection?: GisNetworkInformationLike;
  mozConnection?: GisNetworkInformationLike;
  webkitConnection?: GisNetworkInformationLike;
}

export interface GisEnvironmentLike {
  navigator?: GisNavigatorLike;
  matchMedia?: (query: string) => { matches?: boolean };
}

export interface GisDeviceCapabilities {
  memoryGb: number;
  logicalCores: number;
  reducedMotion: boolean;
  saveData: boolean;
  effectiveType: string | null;
  constrainedNetwork: boolean;
  profile: GisPerformanceProfile;
}

export interface GisPerformanceBudget {
  maxConcurrentLayers: number;
  maxResidentLayers: number;
  maxQueryCacheBytes: number;
  clusterThreshold: number;
  maxVisibleFeatures: number;
  sceneQuality: number;
  prefetch: boolean;
}

export interface GisPerformanceSettings {
  sampleWindow: number;
  longFrameMs: number;
  criticalFrameMs: number;
  recoveryFrameMs: number;
  longFrameRatio: number;
  criticalFrameRatio: number;
  recoveryRatio: number;
  minSamples: number;
  cooldownMs: number;
  maxDeviceMemoryGb: number;
}

export interface GisPerformanceMetrics {
  frames: number;
  transitions: number;
  droppedSamples: number;
  lastFrameMs: number | null;
  maxFrameMs: number;
}

export interface GisPerformanceSnapshot {
  profile: GisPerformanceProfile;
  budget: GisPerformanceBudget;
  capabilities: GisDeviceCapabilities;
  sampleCount: number;
  averageFrameMs: number;
  p95FrameMs: number;
  longFrameRatio: number;
  criticalFrameRatio: number;
  metrics: GisPerformanceMetrics;
}

export type GisPerformanceTransitionReason = 'frame-pressure' | 'recovered' | 'manual' | string;
export type GisPerformanceListener = (state: GisPerformanceSnapshot, reason: GisPerformanceTransitionReason) => void;

export interface AdaptivePerformanceConfiguration {
  now?: () => number;
  settings?: Partial<GisPerformanceSettings>;
  capabilities?: GisDeviceCapabilities;
  environment?: GisEnvironmentLike;
  profile?: GisPerformanceProfile;
  onListenerError?: (error: unknown) => void;
  onChange?: GisPerformanceListener;
}

export interface AdaptivePerformanceRuntime {
  recordFrame: (durationMs: unknown) => GisPerformanceSnapshot;
  evaluate: () => GisPerformanceSnapshot;
  getSnapshot: () => GisPerformanceSnapshot;
  getProfile: () => GisPerformanceProfile;
  getBudget: () => GisPerformanceBudget;
  setProfile: (nextProfile: GisPerformanceProfile, reason?: GisPerformanceTransitionReason) => GisPerformanceSnapshot;
  subscribe: (listener: GisPerformanceListener) => () => boolean | void;
  resetSamples: () => void;
  destroy: () => void;
}

const DEFAULTS: GisPerformanceSettings = Object.freeze({
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

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

const finite = (value: unknown, fallback: number | null = null): number | null => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
};

const runtimeNow = (): number => (
  typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now()
);

const percentile = (values: number[], ratio: number): number => {
  if (!values.length) return 0;
  const sorted = values.slice().sort((left, right) => left - right);
  const index = clamp(Math.ceil(sorted.length * ratio) - 1, 0, sorted.length - 1);
  return sorted[index];
};

const defaultEnvironment = (): GisEnvironmentLike => globalThis as unknown as GisEnvironmentLike;

export const detectGisDeviceCapabilities = (
  environment: GisEnvironmentLike = defaultEnvironment(),
): GisDeviceCapabilities => {
  const navigatorLike = environment.navigator || {};
  const memory = clamp(finite(navigatorLike.deviceMemory, 4) as number, 0.25, DEFAULTS.maxDeviceMemoryGb);
  const cores = clamp(Math.floor(finite(navigatorLike.hardwareConcurrency, 4) as number), 1, 128);
  const reducedMotion = Boolean(environment.matchMedia && environment.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const connection = navigatorLike.connection || navigatorLike.mozConnection || navigatorLike.webkitConnection || null;
  const saveData = Boolean(connection && connection.saveData);
  const effectiveType = String((connection && connection.effectiveType) || '').toLowerCase();
  const constrainedNetwork = saveData || effectiveType === 'slow-2g' || effectiveType === '2g';
  const lowMemory = memory <= 2;
  const lowCpu = cores <= 2;
  const profile: GisPerformanceProfile = lowMemory || lowCpu || constrainedNetwork || reducedMotion
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

export const performanceBudgetForProfile = (
  profile: GisPerformanceProfile,
  capabilities: Partial<GisDeviceCapabilities> = {},
): GisPerformanceBudget => {
  const memoryGb = finite(capabilities.memoryGb, 4) as number;
  const base: GisPerformanceBudget = profile === GIS_PERFORMANCE_PROFILE.ECO
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

export const createAdaptivePerformanceRuntime = (
  configuration: AdaptivePerformanceConfiguration = {},
): AdaptivePerformanceRuntime => {
  const clock = typeof configuration.now === 'function' ? configuration.now : runtimeNow;
  const settings: GisPerformanceSettings = { ...DEFAULTS, ...configuration.settings };
  const capabilities = configuration.capabilities || detectGisDeviceCapabilities(configuration.environment || defaultEnvironment());
  let profile: GisPerformanceProfile = configuration.profile || capabilities.profile;
  let budget = performanceBudgetForProfile(profile, capabilities);
  let lastTransitionAt = -Infinity;
  let destroyed = false;
  const frameSamples: number[] = [];
  const listeners = new Set<GisPerformanceListener>();
  const metrics: GisPerformanceMetrics = {
    frames: 0,
    transitions: 0,
    droppedSamples: 0,
    lastFrameMs: null,
    maxFrameMs: 0,
  };

  const snapshot = (): GisPerformanceSnapshot => {
    const longFrames = frameSamples.filter((value) => value >= settings.longFrameMs).length;
    const criticalFrames = frameSamples.filter((value) => value >= settings.criticalFrameMs).length;
    return Object.freeze({
      profile,
      budget,
      capabilities,
      sampleCount: frameSamples.length,
      averageFrameMs: frameSamples.length
        ? frameSamples.reduce((sum, value) => sum + value, 0) / frameSamples.length
        : 0,
      p95FrameMs: percentile(frameSamples, 0.95),
      longFrameRatio: frameSamples.length ? longFrames / frameSamples.length : 0,
      criticalFrameRatio: frameSamples.length ? criticalFrames / frameSamples.length : 0,
      metrics: { ...metrics },
    });
  };

  const emit = (reason: GisPerformanceTransitionReason): GisPerformanceSnapshot => {
    const state = snapshot();
    listeners.forEach((listener) => {
      try {
        listener(state, reason);
      } catch (error) {
        if (configuration.onListenerError) configuration.onListenerError(error);
      }
    });
    if (configuration.onChange) configuration.onChange(state, reason);
    return state;
  };

  const transition = (
    nextProfile: GisPerformanceProfile,
    reason: GisPerformanceTransitionReason,
  ): GisPerformanceSnapshot => {
    if (destroyed || nextProfile === profile) return snapshot();
    profile = nextProfile;
    budget = performanceBudgetForProfile(profile, capabilities);
    lastTransitionAt = clock();
    metrics.transitions += 1;
    return emit(reason);
  };

  const evaluate = (): GisPerformanceSnapshot => {
    if (frameSamples.length < settings.minSamples || clock() - lastTransitionAt < settings.cooldownMs) {
      return snapshot();
    }
    const state = snapshot();
    if (
      state.criticalFrameRatio >= settings.criticalFrameRatio ||
      state.longFrameRatio >= settings.longFrameRatio ||
      state.p95FrameMs >= settings.criticalFrameMs
    ) {
      if (profile === GIS_PERFORMANCE_PROFILE.QUALITY) {
        return transition(GIS_PERFORMANCE_PROFILE.BALANCED, 'frame-pressure');
      }
      if (profile === GIS_PERFORMANCE_PROFILE.BALANCED) {
        return transition(GIS_PERFORMANCE_PROFILE.ECO, 'frame-pressure');
      }
      return state;
    }
    if (
      state.longFrameRatio <= settings.recoveryRatio &&
      state.p95FrameMs <= settings.recoveryFrameMs &&
      !capabilities.constrainedNetwork &&
      !capabilities.reducedMotion
    ) {
      if (profile === GIS_PERFORMANCE_PROFILE.ECO) {
        return transition(GIS_PERFORMANCE_PROFILE.BALANCED, 'recovered');
      }
      if (
        profile === GIS_PERFORMANCE_PROFILE.BALANCED &&
        capabilities.memoryGb >= 8 &&
        capabilities.logicalCores >= 8
      ) {
        return transition(GIS_PERFORMANCE_PROFILE.QUALITY, 'recovered');
      }
    }
    return state;
  };

  const recordFrame = (durationMs: unknown): GisPerformanceSnapshot => {
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

  const resetSamples = (): void => {
    frameSamples.length = 0;
  };

  return Object.freeze({
    recordFrame,
    evaluate,
    getSnapshot: snapshot,
    getProfile: () => profile,
    getBudget: () => budget,
    setProfile: (nextProfile: GisPerformanceProfile, reason: GisPerformanceTransitionReason = 'manual') => {
      if (!(Object.values(GIS_PERFORMANCE_PROFILE) as string[]).includes(nextProfile)) {
        throw new TypeError(`Unknown GIS performance profile: ${nextProfile}`);
      }
      return transition(nextProfile, reason);
    },
    subscribe: (listener: GisPerformanceListener) => {
      if (destroyed || typeof listener !== 'function') return () => undefined;
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    resetSamples,
    destroy: () => {
      destroyed = true;
      listeners.clear();
      resetSamples();
    },
  });
};
