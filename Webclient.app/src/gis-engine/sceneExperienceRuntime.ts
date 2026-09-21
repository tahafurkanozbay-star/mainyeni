import { watchArcgisProperty, type ArcgisAccessorWatch } from './arcgisReactiveRuntime';
import {
  createAdaptivePerformanceRuntime,
  GIS_PERFORMANCE_PROFILE,
  type AdaptivePerformanceRuntime,
  type GisPerformanceBudget,
  type GisPerformanceProfile,
  type GisPerformanceSnapshot,
} from './adaptivePerformanceRuntime';
import type { SceneViewLike } from './sceneRuntime';
import type { SceneBudgetLimits } from './sceneResourceBudget';

export type SceneSdkQualityProfile = 'low' | 'medium' | 'high';
export type SceneRuntimeStatus = 'idle' | 'warming' | 'ready' | 'recovering' | 'degraded' | 'disposed';

export interface SceneEnvironmentLike {
  atmosphereEnabled?: boolean;
  starsEnabled?: boolean;
  lighting?: {
    directShadowsEnabled?: boolean;
    cameraTrackingEnabled?: boolean;
    [key: string]: unknown;
  } | null;
  [key: string]: unknown;
}

export interface SceneExperienceView extends SceneViewLike {
  qualityProfile?: SceneSdkQualityProfile | string;
  destroyed?: boolean;
  environment?: SceneEnvironmentLike | null;
  fatalError?: unknown;
  updating?: boolean;
  stationary?: boolean;
  width?: number;
  height?: number;
  padding?: unknown;
  when?: () => Promise<unknown>;
  tryFatalErrorRecovery?: () => Promise<void>;
}

export interface SceneQualityPolicy {
  profile: GisPerformanceProfile;
  sdkQuality: SceneSdkQualityProfile;
  atmosphereEnabled: boolean;
  starsEnabled: boolean;
  directShadowsEnabled: boolean;
  cameraTrackingEnabled: boolean;
  maximumScreenSpaceError: number;
  pixelRatioCap: number;
  targetFrameMs: number;
  budgetLimits: SceneBudgetLimits;
}

export interface SceneRecoverySnapshot {
  attempts: number;
  successes: number;
  failures: number;
  lastError: unknown;
  lastAttemptAt: number | null;
}

export interface SceneExperienceSnapshot {
  active: boolean;
  status: SceneRuntimeStatus;
  profile: GisPerformanceProfile;
  policy: SceneQualityPolicy;
  performance: GisPerformanceSnapshot;
  recovery: SceneRecoverySnapshot;
  framesObserved: number;
  lastFrameMs: number | null;
  averageFrameMs: number;
  p95FrameMs: number;
  overBudgetFrames: number;
}

export interface SceneExperienceRuntimeOptions {
  adaptiveRuntime?: AdaptivePerformanceRuntime;
  now?: () => number;
  requestFrame?: (callback: FrameRequestCallback) => number;
  cancelFrame?: (handle: number) => void;
  recoveryCooldownMs?: number;
  maximumRecoveryAttempts?: number;
  frameHistorySize?: number;
  onSnapshot?: (snapshot: SceneExperienceSnapshot, reason: string) => void;
  onError?: (error: unknown, context: string) => void;
  accessorWatch?: ArcgisAccessorWatch | undefined;
}

export interface SceneExperienceRuntime {
  setActive: (active: boolean) => SceneExperienceSnapshot;
  recordFrame: (durationMs: unknown) => SceneExperienceSnapshot;
  setProfile: (profile: GisPerformanceProfile, reason?: string) => SceneExperienceSnapshot;
  applyCurrentPolicy: () => SceneExperienceSnapshot;
  recoverFatalError: () => Promise<boolean>;
  getSnapshot: () => SceneExperienceSnapshot;
  subscribe: (listener: (snapshot: SceneExperienceSnapshot, reason: string) => void) => () => boolean;
  dispose: () => void;
}

const MEBIBYTE = 1024 * 1024;
const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));
const finite = (value: unknown, fallback = 0): number => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
};

const runtimeNow = (): number => (
  typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now()
);

const percentile = (values: readonly number[], ratio: number): number => {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = clamp(Math.ceil(sorted.length * ratio) - 1, 0, sorted.length - 1);
  return sorted[index] ?? 0;
};

const defaultRequestFrame = (callback: FrameRequestCallback): number => {
  if (typeof requestAnimationFrame === 'function') return requestAnimationFrame(callback);
  return setTimeout(() => callback(runtimeNow()), 16) as unknown as number;
};

const defaultCancelFrame = (handle: number): void => {
  if (typeof cancelAnimationFrame === 'function') {
    cancelAnimationFrame(handle);
    return;
  }
  clearTimeout(handle);
};

export const sceneBudgetLimitsForProfile = (
  profile: GisPerformanceProfile,
  budget?: Partial<GisPerformanceBudget>,
): SceneBudgetLimits => {
  const visibleFeatures = Math.max(1_000, Math.floor(finite(budget?.maxVisibleFeatures, 6_500)));
  const quality = clamp(finite(budget?.sceneQuality, 0.78), 0.25, 1);

  if (profile === GIS_PERFORMANCE_PROFILE.ECO) {
    return Object.freeze({
      maxCpuBytes: 192 * MEBIBYTE,
      maxGpuBytes: 224 * MEBIBYTE,
      maxDrawCalls: 850,
      maxFeatures: Math.max(20_000, visibleFeatures * 6),
      maxResources: 192,
      maxResourcesPerLayer: 48,
    });
  }

  if (profile === GIS_PERFORMANCE_PROFILE.QUALITY) {
    return Object.freeze({
      maxCpuBytes: Math.round(448 * MEBIBYTE * Math.max(0.9, quality)),
      maxGpuBytes: Math.round(640 * MEBIBYTE * Math.max(0.9, quality)),
      maxDrawCalls: 2_200,
      maxFeatures: Math.max(120_000, visibleFeatures * 10),
      maxResources: 448,
      maxResourcesPerLayer: 112,
    });
  }

  return Object.freeze({
    maxCpuBytes: 320 * MEBIBYTE,
    maxGpuBytes: 416 * MEBIBYTE,
    maxDrawCalls: 1_500,
    maxFeatures: Math.max(70_000, visibleFeatures * 8),
    maxResources: 320,
    maxResourcesPerLayer: 80,
  });
};

export const sceneQualityPolicyForProfile = (
  profile: GisPerformanceProfile,
  budget?: Partial<GisPerformanceBudget>,
): SceneQualityPolicy => {
  if (profile === GIS_PERFORMANCE_PROFILE.ECO) {
    return Object.freeze({
      profile,
      sdkQuality: 'low',
      atmosphereEnabled: false,
      starsEnabled: false,
      directShadowsEnabled: false,
      cameraTrackingEnabled: false,
      maximumScreenSpaceError: 20,
      pixelRatioCap: 1,
      targetFrameMs: 33.34,
      budgetLimits: sceneBudgetLimitsForProfile(profile, budget),
    });
  }

  if (profile === GIS_PERFORMANCE_PROFILE.QUALITY) {
    return Object.freeze({
      profile,
      sdkQuality: 'high',
      atmosphereEnabled: true,
      starsEnabled: false,
      directShadowsEnabled: true,
      cameraTrackingEnabled: false,
      maximumScreenSpaceError: 6,
      pixelRatioCap: 2,
      targetFrameMs: 16.67,
      budgetLimits: sceneBudgetLimitsForProfile(profile, budget),
    });
  }

  return Object.freeze({
    profile,
    sdkQuality: 'medium',
    atmosphereEnabled: true,
    starsEnabled: false,
    directShadowsEnabled: false,
    cameraTrackingEnabled: false,
    maximumScreenSpaceError: 10,
    pixelRatioCap: 1.5,
    targetFrameMs: 20,
    budgetLimits: sceneBudgetLimitsForProfile(profile, budget),
  });
};

export const applySceneQualityPolicy = (
  view: SceneExperienceView,
  policy: SceneQualityPolicy,
): void => {
  if (!view) return;

  try {
    view.qualityProfile = policy.sdkQuality;
  } catch {
    // Older SceneView builds may expose qualityProfile as construction-only.
    // Keeping this assignment best-effort preserves compatibility with the
    // repository's esri-loader runtime while still allowing newer builds to
    // adapt quality live.
  }

  const environment = view.environment;
  if (!environment) return;

  try {
    environment.atmosphereEnabled = policy.atmosphereEnabled;
  } catch {
    // Best effort: environment capabilities vary across ArcGIS SDK versions.
  }

  try {
    environment.starsEnabled = policy.starsEnabled;
  } catch {
    // Best effort.
  }

  const lighting = environment.lighting;
  if (!lighting) return;

  try {
    lighting.directShadowsEnabled = policy.directShadowsEnabled;
  } catch {
    // Best effort.
  }

  try {
    lighting.cameraTrackingEnabled = policy.cameraTrackingEnabled;
  } catch {
    // Sun and virtual lighting do not expose an identical property surface.
  }
};

const createRecoverySnapshot = (): SceneRecoverySnapshot => ({
  attempts: 0,
  successes: 0,
  failures: 0,
  lastError: null,
  lastAttemptAt: null,
});

export const createSceneExperienceRuntime = (
  view: SceneExperienceView,
  options: SceneExperienceRuntimeOptions = {},
): SceneExperienceRuntime => {
  const now = options.now ?? runtimeNow;
  const requestFrame = options.requestFrame ?? defaultRequestFrame;
  const cancelFrame = options.cancelFrame ?? defaultCancelFrame;
  const recoveryCooldownMs = Math.max(250, finite(options.recoveryCooldownMs, 3_000));
  const maximumRecoveryAttempts = Math.max(1, Math.floor(finite(options.maximumRecoveryAttempts, 3)));
  const frameHistorySize = Math.max(12, Math.min(240, Math.floor(finite(options.frameHistorySize, 90))));
  const adaptive = options.adaptiveRuntime ?? createAdaptivePerformanceRuntime({
    onListenerError: (error: unknown) => options.onError?.(error, 'adaptive-listener'),
  });
  const ownsAdaptiveRuntime = !options.adaptiveRuntime;
  const listeners = new Set<(snapshot: SceneExperienceSnapshot, reason: string) => void>();
  const frameHistory: number[] = [];
  const recovery = createRecoverySnapshot();

  let active = false;
  let disposed = false;
  let status: SceneRuntimeStatus = 'idle';
  let frameHandle: number | null = null;
  let previousFrameAt: number | null = null;
  let framesObserved = 0;
  let overBudgetFrames = 0;
  let recoveryInFlight: Promise<boolean> | null = null;

  const buildSnapshot = (): SceneExperienceSnapshot => {
    const performanceSnapshot = adaptive.getSnapshot();
    const policy = sceneQualityPolicyForProfile(performanceSnapshot.profile, performanceSnapshot.budget);
    return Object.freeze({
      active,
      status,
      profile: performanceSnapshot.profile,
      policy,
      performance: performanceSnapshot,
      recovery: Object.freeze({ ...recovery }),
      framesObserved,
      lastFrameMs: frameHistory.length ? frameHistory[frameHistory.length - 1] ?? null : null,
      averageFrameMs: frameHistory.length
        ? frameHistory.reduce((sum, value) => sum + value, 0) / frameHistory.length
        : 0,
      p95FrameMs: percentile(frameHistory, 0.95),
      overBudgetFrames,
    });
  };

  const emit = (reason: string): SceneExperienceSnapshot => {
    const snapshot = buildSnapshot();
    listeners.forEach((listener) => {
      try {
        listener(snapshot, reason);
      } catch (error) {
        options.onError?.(error, 'scene-experience-listener');
      }
    });
    options.onSnapshot?.(snapshot, reason);
    return snapshot;
  };

  const applyPolicy = (reason: string): SceneExperienceSnapshot => {
    const performanceSnapshot = adaptive.getSnapshot();
    const policy = sceneQualityPolicyForProfile(performanceSnapshot.profile, performanceSnapshot.budget);
    applySceneQualityPolicy(view, policy);
    return emit(reason);
  };

  const recordFrame = (durationMs: unknown): SceneExperienceSnapshot => {
    if (disposed) return buildSnapshot();
    const duration = finite(durationMs, -1);
    if (duration <= 0 || duration > 1_000) return buildSnapshot();

    framesObserved += 1;
    frameHistory.push(duration);
    if (frameHistory.length > frameHistorySize) frameHistory.splice(0, frameHistory.length - frameHistorySize);

    const before = adaptive.getProfile();
    const beforePolicy = sceneQualityPolicyForProfile(before, adaptive.getBudget());
    if (duration > beforePolicy.targetFrameMs * 1.75) overBudgetFrames += 1;
    const performanceSnapshot = adaptive.recordFrame(duration);
    if (performanceSnapshot.profile !== before) {
      applySceneQualityPolicy(view, sceneQualityPolicyForProfile(performanceSnapshot.profile, performanceSnapshot.budget));
      return emit('adaptive-profile');
    }
    return buildSnapshot();
  };

  const onAnimationFrame = (timestamp: number): void => {
    frameHandle = null;
    if (disposed || !active) return;

    if (previousFrameAt !== null) recordFrame(timestamp - previousFrameAt);
    previousFrameAt = timestamp;
    frameHandle = requestFrame(onAnimationFrame);
  };

  const stopSampler = (): void => {
    if (frameHandle !== null) cancelFrame(frameHandle);
    frameHandle = null;
    previousFrameAt = null;
  };

  const startSampler = (): void => {
    if (frameHandle !== null || disposed || !active) return;
    previousFrameAt = null;
    frameHandle = requestFrame(onAnimationFrame);
  };

  const setActive = (nextActive: boolean): SceneExperienceSnapshot => {
    if (disposed) return buildSnapshot();
    if (active === nextActive) return buildSnapshot();
    active = nextActive;
    if (active) {
      status = status === 'recovering' ? status : 'ready';
      applyPolicy('activated');
      startSampler();
    } else {
      stopSampler();
      if (status !== 'recovering') status = 'idle';
    }
    return emit(active ? 'active' : 'inactive');
  };

  const setProfile = (profile: GisPerformanceProfile, reason = 'manual'): SceneExperienceSnapshot => {
    if (disposed) return buildSnapshot();
    adaptive.setProfile(profile, reason);
    return applyPolicy(reason);
  };

  const recoverFatalError = async (): Promise<boolean> => {
    if (disposed) return false;
    if (recoveryInFlight) return recoveryInFlight;
    if (typeof view.tryFatalErrorRecovery !== 'function') return false;

    const elapsed = recovery.lastAttemptAt === null ? Number.POSITIVE_INFINITY : now() - recovery.lastAttemptAt;
    if (elapsed < recoveryCooldownMs || recovery.attempts >= maximumRecoveryAttempts) {
      if (recovery.attempts >= maximumRecoveryAttempts) status = 'degraded';
      emit('recovery-suppressed');
      return false;
    }

    recoveryInFlight = (async () => {
      recovery.attempts += 1;
      recovery.lastAttemptAt = now();
      status = 'recovering';
      stopSampler();
      emit('recovery-start');

      try {
        await view.tryFatalErrorRecovery();
        recovery.successes += 1;
        recovery.lastError = null;
        status = active ? 'ready' : 'idle';
        applyPolicy('recovery-policy');
        if (active) startSampler();
        emit('recovery-success');
        return true;
      } catch (error) {
        recovery.failures += 1;
        recovery.lastError = error;
        status = recovery.attempts >= maximumRecoveryAttempts ? 'degraded' : (active ? 'ready' : 'idle');
        options.onError?.(error, 'fatal-error-recovery');
        if (active && status !== 'degraded') startSampler();
        emit('recovery-failure');
        return false;
      } finally {
        recoveryInFlight = null;
      }
    })();

    return recoveryInFlight;
  };

  const fatalHandle = watchArcgisProperty(view, 'fatalError', (error: unknown) => {
    if (!error || disposed) return;
    void recoverFatalError();
  }, options.accessorWatch);

  const performanceUnsubscribe = adaptive.subscribe((snapshot, reason) => {
    if (disposed) return;
    applySceneQualityPolicy(view, sceneQualityPolicyForProfile(snapshot.profile, snapshot.budget));
    emit(`performance:${reason}`);
  });

  status = 'warming';
  applyPolicy('initialized');
  status = 'idle';

  const subscribe = (listener: (snapshot: SceneExperienceSnapshot, reason: string) => void): (() => boolean) => {
    if (disposed) return () => false;
    listeners.add(listener);
    return () => listeners.delete(listener);
  };

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    active = false;
    stopSampler();
    try {
      fatalHandle?.remove?.();
    } catch {
      // Idempotent teardown.
    }
    performanceUnsubscribe?.();
    listeners.clear();
    if (ownsAdaptiveRuntime) adaptive.destroy();
    status = 'disposed';
  };

  return Object.freeze({
    setActive,
    recordFrame,
    setProfile,
    applyCurrentPolicy: () => applyPolicy('policy-refresh'),
    recoverFatalError,
    getSnapshot: buildSnapshot,
    subscribe,
    dispose,
  });
};
