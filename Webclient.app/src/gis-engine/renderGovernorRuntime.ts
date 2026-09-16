import {
  average,
  clampNumber,
  classifyFramePressure,
  classifyMemoryPressure,
  finiteNumber,
  normalizeIdentifier,
  percentile,
  positiveInteger,
  type GisDeviceSnapshot,
  type GisFramePressure,
  type GisLayerDescriptor,
  type GisMemoryPressure,
  type GisQualityTier,
  type GisRenderBudget,
  type GisViewSnapshot,
} from './runtimeContracts';

export interface GisRenderGovernorSettings {
  readonly sampleWindow?: number;
  readonly minSamples?: number;
  readonly transitionCooldownMs?: number;
  readonly recoveryCooldownMs?: number;
  readonly longFrameMs?: number;
  readonly criticalFrameMs?: number;
  readonly targetFrameMs2d?: number;
  readonly targetFrameMs3d?: number;
  readonly maxResidentBytes?: number;
  readonly maxDevicePixelRatio?: number;
}

export interface GisRenderGovernorConfiguration {
  readonly now?: () => number;
  readonly device?: GisDeviceSnapshot;
  readonly settings?: GisRenderGovernorSettings;
  readonly initialTier?: GisQualityTier;
  readonly onChange?: (snapshot: GisRenderGovernorSnapshot, reason: string) => void;
  readonly onListenerError?: (error: unknown) => void;
}

export interface GisLayerRenderInput {
  readonly layer: GisLayerDescriptor;
  readonly featureCount?: number | null;
  readonly visibleFeatureCount?: number | null;
  readonly pointCount?: number | null;
  readonly labelCandidateCount?: number | null;
  readonly sceneNodeCount?: number | null;
  readonly estimatedResidentBytes?: number | null;
  readonly selected?: boolean;
  readonly hovered?: boolean;
  readonly editing?: boolean;
  readonly allowCluster?: boolean;
  readonly allowLabels?: boolean;
  readonly allowExtrusion?: boolean;
  readonly allowShadows?: boolean;
  readonly minRequiredFeatures?: number | null;
}

export interface GisLayerRenderPlan {
  readonly layerId: string;
  readonly viewKind: '2d' | '3d';
  readonly tier: GisQualityTier;
  readonly visible: boolean;
  readonly reason: string;
  readonly maxFeatures: number;
  readonly maxPointSymbols: number;
  readonly maxLabels: number;
  readonly maxSceneNodes: number;
  readonly labelDensity: number;
  readonly geometryDetail: number;
  readonly sceneQuality: number;
  readonly cluster: boolean;
  readonly labels: boolean;
  readonly extrusion: boolean;
  readonly shadows: boolean;
  readonly defer: boolean;
  readonly priority: number;
  readonly generalization: Readonly<{
    recommended: boolean;
    tolerance: null;
    reason: string;
  }>;
  readonly diagnostics: Readonly<{
    scaleVisible: boolean;
    interactionPressure: boolean;
    framePressure: GisFramePressure;
    memoryPressure: GisMemoryPressure;
    featurePressure: number;
    pointPressure: number;
    labelPressure: number;
    scenePressure: number;
  }>;
}

export interface GisRenderGovernorSnapshot {
  readonly tier: GisQualityTier;
  readonly budget: GisRenderBudget;
  readonly view: GisViewSnapshot;
  readonly sampleCount: number;
  readonly averageFrameMs: number;
  readonly p95FrameMs: number;
  readonly longFrameRatio: number;
  readonly criticalFrameRatio: number;
  readonly lastTransitionAt: number | null;
  readonly transitionCount: number;
  readonly droppedSamples: number;
  readonly maxFrameMs: number;
}

const DEFAULT_SETTINGS: Required<GisRenderGovernorSettings> = Object.freeze({
  sampleWindow: 120,
  minSamples: 24,
  transitionCooldownMs: 4000,
  recoveryCooldownMs: 12000,
  longFrameMs: 34,
  criticalFrameMs: 80,
  targetFrameMs2d: 16.7,
  targetFrameMs3d: 22,
  maxResidentBytes: 256 * 1024 * 1024,
  maxDevicePixelRatio: 2,
});

const TIER_ORDER: readonly GisQualityTier[] = Object.freeze(['economy', 'balanced', 'quality', 'ultra']);

const BASE_BUDGETS: Readonly<Record<GisQualityTier, Omit<GisRenderBudget, 'framePressure' | 'memoryPressure'>>> = Object.freeze({
  economy: Object.freeze({
    tier: 'economy', maxVisibleFeatures: 2500, maxPointSymbols: 1800, maxLabels: 220, maxSceneNodes: 750,
    maxResidentBytes: 64 * 1024 * 1024, maxConcurrentRequests: 2, maxConcurrentLayerLoads: 2,
    sceneQuality: 0.48, labelDensity: 0.34, enableShadows: false, enableExtrusion: false,
    allowPrefetch: false, geometryDetail: 0.45,
  }),
  balanced: Object.freeze({
    tier: 'balanced', maxVisibleFeatures: 6500, maxPointSymbols: 4800, maxLabels: 700, maxSceneNodes: 1900,
    maxResidentBytes: 128 * 1024 * 1024, maxConcurrentRequests: 4, maxConcurrentLayerLoads: 4,
    sceneQuality: 0.72, labelDensity: 0.62, enableShadows: false, enableExtrusion: true,
    allowPrefetch: true, geometryDetail: 0.7,
  }),
  quality: Object.freeze({
    tier: 'quality', maxVisibleFeatures: 12000, maxPointSymbols: 9000, maxLabels: 1500, maxSceneNodes: 4200,
    maxResidentBytes: 256 * 1024 * 1024, maxConcurrentRequests: 6, maxConcurrentLayerLoads: 6,
    sceneQuality: 0.9, labelDensity: 0.82, enableShadows: true, enableExtrusion: true,
    allowPrefetch: true, geometryDetail: 0.9,
  }),
  ultra: Object.freeze({
    tier: 'ultra', maxVisibleFeatures: 20000, maxPointSymbols: 15000, maxLabels: 2600, maxSceneNodes: 7500,
    maxResidentBytes: 384 * 1024 * 1024, maxConcurrentRequests: 8, maxConcurrentLayerLoads: 7,
    sceneQuality: 1, labelDensity: 1, enableShadows: true, enableExtrusion: true,
    allowPrefetch: true, geometryDetail: 1,
  }),
});

const normalizeSettings = (input: GisRenderGovernorSettings = {}): Required<GisRenderGovernorSettings> => Object.freeze({
  sampleWindow: positiveInteger(input.sampleWindow, DEFAULT_SETTINGS.sampleWindow, 1000),
  minSamples: positiveInteger(input.minSamples, DEFAULT_SETTINGS.minSamples, 500),
  transitionCooldownMs: positiveInteger(input.transitionCooldownMs, DEFAULT_SETTINGS.transitionCooldownMs, 120000),
  recoveryCooldownMs: positiveInteger(input.recoveryCooldownMs, DEFAULT_SETTINGS.recoveryCooldownMs, 600000),
  longFrameMs: positiveInteger(input.longFrameMs, DEFAULT_SETTINGS.longFrameMs, 1000),
  criticalFrameMs: positiveInteger(input.criticalFrameMs, DEFAULT_SETTINGS.criticalFrameMs, 5000),
  targetFrameMs2d: clampNumber(input.targetFrameMs2d, 8, 100, DEFAULT_SETTINGS.targetFrameMs2d),
  targetFrameMs3d: clampNumber(input.targetFrameMs3d, 8, 100, DEFAULT_SETTINGS.targetFrameMs3d),
  maxResidentBytes: positiveInteger(input.maxResidentBytes, DEFAULT_SETTINGS.maxResidentBytes, 4 * 1024 * 1024 * 1024),
  maxDevicePixelRatio: clampNumber(input.maxDevicePixelRatio, 1, 4, DEFAULT_SETTINGS.maxDevicePixelRatio),
});

const detectInitialTier = (device: GisDeviceSnapshot = {}): GisQualityTier => {
  const memory = finiteNumber(device.memoryGb, 4) ?? 4;
  const cores = finiteNumber(device.logicalCores, 4) ?? 4;
  if (device.reducedMotion || device.saveData || memory <= 2 || cores <= 2) return 'economy';
  if (memory >= 16 && cores >= 12 && device.networkClass !== 'constrained') return 'ultra';
  if (memory >= 8 && cores >= 8 && device.networkClass !== 'constrained') return 'quality';
  return 'balanced';
};

const tierIndex = (tier: GisQualityTier): number => Math.max(0, TIER_ORDER.indexOf(tier));
const lowerTier = (tier: GisQualityTier): GisQualityTier => TIER_ORDER[Math.max(0, tierIndex(tier) - 1)] ?? 'economy';
const higherTier = (tier: GisQualityTier): GisQualityTier => TIER_ORDER[Math.min(TIER_ORDER.length - 1, tierIndex(tier) + 1)] ?? 'ultra';

const normalizeView = (view: GisViewSnapshot | null | undefined): GisViewSnapshot => Object.freeze({
  kind: view?.kind === '3d' ? '3d' : '2d',
  scale: finiteNumber(view?.scale),
  cameraDistance: finiteNumber(view?.cameraDistance),
  stationary: view?.stationary !== false,
  interacting: view?.interacting === true,
  width: finiteNumber(view?.width),
  height: finiteNumber(view?.height),
  devicePixelRatio: finiteNumber(view?.devicePixelRatio),
  extent: view?.extent ?? null,
  timestamp: finiteNumber(view?.timestamp, Date.now()) ?? Date.now(),
});

const scaledBudget = (
  tier: GisQualityTier,
  device: GisDeviceSnapshot,
  framePressure: GisFramePressure,
  memoryPressure: GisMemoryPressure,
  settings: Required<GisRenderGovernorSettings>,
  view: GisViewSnapshot,
): GisRenderBudget => {
  const base = BASE_BUDGETS[tier];
  const memoryGb = clampNumber(device.memoryGb, 0.5, 64, 4);
  const cores = clampNumber(device.logicalCores, 1, 128, 4);
  const memoryFactor = clampNumber(Math.sqrt(memoryGb / 4), 0.55, 1.7, 1);
  const cpuFactor = clampNumber(Math.sqrt(cores / 4), 0.65, 1.5, 1);
  const dpr = clampNumber(view.devicePixelRatio ?? device.devicePixelRatio, 1, settings.maxDevicePixelRatio, 1);
  const pixelPenalty = 1 / Math.sqrt(dpr);
  const viewPenalty = view.kind === '3d' ? 0.82 : 1;
  const pressurePenalty = framePressure === 'critical' ? 0.48 : framePressure === 'high' ? 0.66 : framePressure === 'mild' ? 0.84 : 1;
  const memoryPenalty = memoryPressure === 'critical' ? 0.42 : memoryPressure === 'high' ? 0.65 : memoryPressure === 'moderate' ? 0.84 : 1;
  const interactionPenalty = view.interacting ? 0.78 : 1;
  const featureFactor = memoryFactor * cpuFactor * pixelPenalty * viewPenalty * pressurePenalty * memoryPenalty * interactionPenalty;
  const residentFactor = Math.min(memoryFactor, memoryPenalty);
  const residentLimit = Math.min(
    settings.maxResidentBytes,
    Math.max(32 * 1024 * 1024, Math.round(base.maxResidentBytes * residentFactor)),
  );
  return Object.freeze({
    ...base,
    tier,
    maxVisibleFeatures: Math.max(750, Math.round(base.maxVisibleFeatures * featureFactor)),
    maxPointSymbols: Math.max(500, Math.round(base.maxPointSymbols * featureFactor)),
    maxLabels: Math.max(80, Math.round(base.maxLabels * featureFactor)),
    maxSceneNodes: Math.max(300, Math.round(base.maxSceneNodes * featureFactor)),
    maxResidentBytes: residentLimit,
    maxConcurrentRequests: Math.max(1, Math.round(base.maxConcurrentRequests * Math.min(cpuFactor, pressurePenalty))),
    maxConcurrentLayerLoads: Math.max(1, Math.round(base.maxConcurrentLayerLoads * Math.min(cpuFactor, pressurePenalty))),
    sceneQuality: clampNumber(base.sceneQuality * pressurePenalty * interactionPenalty, 0.25, 1, 0.5),
    labelDensity: clampNumber(base.labelDensity * pressurePenalty * interactionPenalty, 0.15, 1, 0.5),
    enableShadows: base.enableShadows && framePressure === 'none' && memoryPressure !== 'critical' && !view.interacting,
    enableExtrusion: base.enableExtrusion && framePressure !== 'critical' && memoryPressure !== 'critical',
    allowPrefetch: base.allowPrefetch
      && !device.saveData
      && device.networkClass !== 'constrained'
      && framePressure !== 'critical'
      && memoryPressure !== 'critical'
      && view.stationary !== false,
    geometryDetail: clampNumber(base.geometryDetail * pressurePenalty * memoryPenalty, 0.25, 1, 0.5),
    framePressure,
    memoryPressure,
  });
};

const scaleVisible = (layer: GisLayerDescriptor, view: GisViewSnapshot): boolean => {
  const scale = finiteNumber(view.scale);
  if (scale === null || scale <= 0) return true;
  const minScale = Math.max(0, finiteNumber(layer.minScale, 0) ?? 0);
  const maxScale = Math.max(0, finiteNumber(layer.maxScale, 0) ?? 0);
  if (minScale > 0 && scale > minScale) return false;
  if (maxScale > 0 && scale < maxScale) return false;
  return true;
};

const pressureRatio = (value: unknown, maximum: number): number => {
  const count = Math.max(0, finiteNumber(value, 0) ?? 0);
  return maximum > 0 ? count / maximum : count > 0 ? Number.POSITIVE_INFINITY : 0;
};

const choosePriority = (input: GisLayerRenderInput, visible: boolean, view: GisViewSnapshot): number => {
  if (!visible) return 100;
  if (input.editing) return 0;
  if (input.selected) return 2;
  if (input.hovered) return 4;
  const importance = clampNumber(input.layer.importance, 0, 100, 50);
  const interactionBonus = view.interacting ? -5 : 0;
  return Math.max(5, Math.round(60 - (importance * 0.45) + interactionBonus));
};

export const createRenderGovernor = (configuration: GisRenderGovernorConfiguration = {}) => {
  const clock = typeof configuration.now === 'function' ? configuration.now : () => Date.now();
  const settings = normalizeSettings(configuration.settings);
  const device = Object.freeze({ ...(configuration.device || {}) });
  let tier: GisQualityTier = configuration.initialTier || detectInitialTier(device);
  if (!TIER_ORDER.includes(tier)) tier = 'balanced';
  let view = normalizeView({ kind: '2d', stationary: true, interacting: false });
  const frameSamples: number[] = [];
  const listeners = new Set<(snapshot: GisRenderGovernorSnapshot, reason: string) => void>();
  let lastTransitionAt: number | null = null;
  let transitionCount = 0;
  let droppedSamples = 0;
  let maxFrameMs = 0;
  let residentBytes = 0;
  let destroyed = false;

  const frameStats = () => {
    const longFrames = frameSamples.filter((sample) => sample >= settings.longFrameMs).length;
    const criticalFrames = frameSamples.filter((sample) => sample >= settings.criticalFrameMs).length;
    const p95FrameMs = percentile(frameSamples, 0.95);
    const longFrameRatio = frameSamples.length ? longFrames / frameSamples.length : 0;
    return {
      averageFrameMs: average(frameSamples),
      p95FrameMs,
      longFrameRatio,
      criticalFrameRatio: frameSamples.length ? criticalFrames / frameSamples.length : 0,
      framePressure: classifyFramePressure(p95FrameMs, longFrameRatio),
    };
  };

  const currentBudget = (): GisRenderBudget => {
    const stats = frameStats();
    const base = BASE_BUDGETS[tier];
    const preliminaryMax = Math.min(settings.maxResidentBytes, base.maxResidentBytes);
    const memoryPressure = classifyMemoryPressure(residentBytes, preliminaryMax);
    return scaledBudget(tier, device, stats.framePressure, memoryPressure, settings, view);
  };

  const snapshot = (): GisRenderGovernorSnapshot => {
    const stats = frameStats();
    return Object.freeze({
      tier,
      budget: currentBudget(),
      view,
      sampleCount: frameSamples.length,
      averageFrameMs: Math.round(stats.averageFrameMs * 100) / 100,
      p95FrameMs: Math.round(stats.p95FrameMs * 100) / 100,
      longFrameRatio: stats.longFrameRatio,
      criticalFrameRatio: stats.criticalFrameRatio,
      lastTransitionAt,
      transitionCount,
      droppedSamples,
      maxFrameMs,
    });
  };

  const emit = (reason: string): GisRenderGovernorSnapshot => {
    const state = snapshot();
    for (const listener of [...listeners]) {
      try { listener(state, reason); } catch (error) { configuration.onListenerError?.(error); }
    }
    try { configuration.onChange?.(state, reason); } catch (error) { configuration.onListenerError?.(error); }
    return state;
  };

  const transition = (nextTier: GisQualityTier, reason: string): GisRenderGovernorSnapshot => {
    if (destroyed || nextTier === tier) return snapshot();
    tier = nextTier;
    lastTransitionAt = clock();
    transitionCount += 1;
    return emit(reason);
  };

  const evaluate = (reason = 'evaluate'): GisRenderGovernorSnapshot => {
    if (destroyed) return snapshot();
    if (frameSamples.length < settings.minSamples) return snapshot();
    const state = snapshot();
    const elapsed = lastTransitionAt === null ? Number.POSITIVE_INFINITY : clock() - lastTransitionAt;
    const hardPressure = state.budget.framePressure === 'critical' || state.budget.memoryPressure === 'critical';
    const highPressure = state.budget.framePressure === 'high' || state.budget.memoryPressure === 'high';
    if ((hardPressure || highPressure) && elapsed >= settings.transitionCooldownMs && tier !== 'economy') {
      return transition(lowerTier(tier), `${reason}:pressure`);
    }
    const target = view.kind === '3d' ? settings.targetFrameMs3d : settings.targetFrameMs2d;
    const recoverable = state.budget.framePressure === 'none'
      && state.budget.memoryPressure === 'low'
      && state.p95FrameMs <= target * 1.22
      && state.longFrameRatio <= 0.05
      && !device.saveData
      && device.networkClass !== 'constrained'
      && view.stationary !== false;
    if (recoverable && elapsed >= settings.recoveryCooldownMs && tier !== 'ultra') {
      const candidate = higherTier(tier);
      const memory = finiteNumber(device.memoryGb, 4) ?? 4;
      const cores = finiteNumber(device.logicalCores, 4) ?? 4;
      if (candidate === 'ultra' && (memory < 12 || cores < 10)) return state;
      if (candidate === 'quality' && (memory < 6 || cores < 6)) return state;
      return transition(candidate, `${reason}:recovery`);
    }
    return state;
  };

  const recordFrame = (durationMs: unknown): GisRenderGovernorSnapshot => {
    if (destroyed) return snapshot();
    const duration = finiteNumber(durationMs);
    if (duration === null || duration < 0 || duration > 10000) {
      droppedSamples += 1;
      return snapshot();
    }
    frameSamples.push(duration);
    if (frameSamples.length > settings.sampleWindow) frameSamples.shift();
    maxFrameMs = Math.max(maxFrameMs, duration);
    return evaluate('frame-sample');
  };

  const updateView = (next: GisViewSnapshot): GisRenderGovernorSnapshot => {
    if (destroyed) return snapshot();
    view = normalizeView(next);
    return evaluate('view-update');
  };

  const setResidentBytes = (value: unknown): GisRenderGovernorSnapshot => {
    residentBytes = Math.max(0, Math.floor(finiteNumber(value, 0) ?? 0));
    return evaluate('resident-memory-update');
  };

  const planLayer = (input: GisLayerRenderInput): GisLayerRenderPlan => {
    if (destroyed) throw new Error('GIS render governor has been destroyed.');
    if (!input?.layer) throw new TypeError('A GIS layer descriptor is required.');
    const layerId = normalizeIdentifier(input.layer.id, 'layerId');
    const budget = currentBudget();
    const scaleIsVisible = scaleVisible(input.layer, view);
    const requestedVisible = input.layer.visible !== false;
    const visible = requestedVisible && scaleIsVisible;
    const interactionPressure = view.interacting === true;
    const featurePressure = pressureRatio(
      input.visibleFeatureCount ?? input.featureCount ?? input.layer.estimatedFeatureCount,
      budget.maxVisibleFeatures,
    );
    const pointPressure = pressureRatio(input.pointCount, budget.maxPointSymbols);
    const labelPressure = pressureRatio(input.labelCandidateCount, budget.maxLabels);
    const scenePressure = pressureRatio(input.sceneNodeCount, budget.maxSceneNodes);
    const extremeContentPressure = Math.max(featurePressure, pointPressure, labelPressure, scenePressure) >= 2.5;
    const minRequiredFeatures = positiveInteger(input.minRequiredFeatures, 1, budget.maxVisibleFeatures);
    const maxFeatures = Math.max(
      minRequiredFeatures,
      input.editing || input.selected
        ? Math.min(budget.maxVisibleFeatures, Math.round(budget.maxVisibleFeatures * 1.2))
        : budget.maxVisibleFeatures,
    );
    const cluster = visible
      && input.allowCluster !== false
      && !input.editing
      && (pointPressure > 0.92 || (interactionPressure && pointPressure > 0.55));
    const labels = visible
      && input.allowLabels !== false
      && !extremeContentPressure
      && budget.maxLabels > 0;
    const extrusion = visible
      && view.kind === '3d'
      && input.allowExtrusion !== false
      && budget.enableExtrusion
      && !interactionPressure;
    const shadows = extrusion && input.allowShadows !== false && budget.enableShadows;
    const defer = !visible
      || (!input.selected && !input.editing && (
        budget.framePressure === 'critical'
        || budget.memoryPressure === 'critical'
        || (interactionPressure && extremeContentPressure)
      ));
    const generalizationRecommended = visible
      && !input.editing
      && !input.selected
      && (featurePressure > 1.1 || budget.framePressure !== 'none');
    const reason = !requestedVisible
      ? 'layer-hidden'
      : !scaleIsVisible
        ? 'outside-scale-range'
        : defer
          ? 'deferred-under-pressure'
          : cluster
            ? 'clustered-under-point-pressure'
            : 'render';
    return Object.freeze({
      layerId,
      viewKind: view.kind,
      tier,
      visible,
      reason,
      maxFeatures,
      maxPointSymbols: budget.maxPointSymbols,
      maxLabels: labels ? budget.maxLabels : 0,
      maxSceneNodes: view.kind === '3d' ? budget.maxSceneNodes : 0,
      labelDensity: labels ? budget.labelDensity : 0,
      geometryDetail: budget.geometryDetail,
      sceneQuality: view.kind === '3d' ? budget.sceneQuality : 1,
      cluster,
      labels,
      extrusion,
      shadows,
      defer,
      priority: choosePriority(input, visible, view),
      generalization: Object.freeze({
        recommended: generalizationRecommended,
        tolerance: null,
        reason: generalizationRecommended
          ? 'coordinate units intentionally unresolved; caller must provide verified tolerance'
          : 'not-required',
      }),
      diagnostics: Object.freeze({
        scaleVisible: scaleIsVisible,
        interactionPressure,
        framePressure: budget.framePressure,
        memoryPressure: budget.memoryPressure,
        featurePressure,
        pointPressure,
        labelPressure,
        scenePressure,
      }),
    });
  };

  const setTier = (nextTier: GisQualityTier, reason = 'manual'): GisRenderGovernorSnapshot => {
    if (!TIER_ORDER.includes(nextTier)) throw new TypeError(`Unknown GIS quality tier: ${String(nextTier)}`);
    return transition(nextTier, reason);
  };

  const resetFrameSamples = (): GisRenderGovernorSnapshot => {
    frameSamples.length = 0;
    maxFrameMs = 0;
    droppedSamples = 0;
    return emit('frame-samples-reset');
  };

  const subscribe = (listener: (snapshot: GisRenderGovernorSnapshot, reason: string) => void): (() => void) => {
    if (destroyed || typeof listener !== 'function') return () => {};
    listeners.add(listener);
    return () => listeners.delete(listener);
  };

  const destroy = (): void => {
    destroyed = true;
    frameSamples.length = 0;
    listeners.clear();
  };

  return Object.freeze({
    recordFrame,
    updateView,
    setResidentBytes,
    planLayer,
    evaluate,
    setTier,
    resetFrameSamples,
    getSnapshot: snapshot,
    getBudget: currentBudget,
    getTier: () => tier,
    subscribe,
    destroy,
    isDestroyed: () => destroyed,
  });
};
