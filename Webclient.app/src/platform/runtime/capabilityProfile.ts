import {
  asFiniteNumber,
  clampNumber,
  type RuntimeCapabilities,
  type RuntimeTier,
} from './contracts';

interface EventTargetLike {
  addEventListener?: (type: string, listener: EventListenerOrEventListenerObject) => void;
  removeEventListener?: (type: string, listener: EventListenerOrEventListenerObject) => void;
}

interface NetworkInformationLike extends EventTargetLike {
  readonly effectiveType?: string;
  readonly downlink?: number;
  readonly rtt?: number;
  readonly saveData?: boolean;
}

interface NavigatorLike {
  readonly hardwareConcurrency?: number;
  readonly deviceMemory?: number;
  readonly onLine?: boolean;
  readonly connection?: NetworkInformationLike;
  readonly mozConnection?: NetworkInformationLike;
  readonly webkitConnection?: NetworkInformationLike;
  readonly scheduling?: { readonly isInputPending?: () => boolean };
}

interface MediaQueryLike extends EventTargetLike {
  readonly matches: boolean;
}

interface WindowLike extends EventTargetLike {
  matchMedia?: (query: string) => MediaQueryLike;
  Worker?: unknown;
  OffscreenCanvas?: unknown;
  IntersectionObserver?: unknown;
  ResizeObserver?: unknown;
  PerformanceObserver?: unknown;
  structuredClone?: unknown;
  scheduler?: { readonly postTask?: (...args: unknown[]) => Promise<unknown> };
  trustedTypes?: unknown;
  document?: Document;
}

export interface CapabilityDependencies {
  readonly navigatorRef?: NavigatorLike | null;
  readonly windowRef?: WindowLike | null;
  readonly documentRef?: Document | null;
  readonly now?: () => number;
  readonly webglProbe?: () => boolean;
  readonly onProbeError?: (error: unknown, probe: string) => void;
}

export interface CapabilityThresholds {
  readonly minimalCpuCores: number;
  readonly enhancedCpuCores: number;
  readonly minimalMemoryGb: number;
  readonly enhancedMemoryGb: number;
  readonly minimalDownlinkMbps: number;
  readonly enhancedDownlinkMbps: number;
  readonly poorRttMs: number;
  readonly enhancedRttMs: number;
}

export interface CapabilityDecision {
  readonly tier: RuntimeTier;
  readonly score: number;
  readonly reasons: readonly string[];
}

export const DEFAULT_CAPABILITY_THRESHOLDS: CapabilityThresholds = Object.freeze({
  minimalCpuCores: 2,
  enhancedCpuCores: 8,
  minimalMemoryGb: 2,
  enhancedMemoryGb: 8,
  minimalDownlinkMbps: 1.5,
  enhancedDownlinkMbps: 10,
  poorRttMs: 600,
  enhancedRttMs: 120,
});

const safeWindow = (): WindowLike | null =>
  typeof window === 'undefined' ? null : (window as unknown as WindowLike);

const safeNavigator = (): NavigatorLike | null =>
  typeof navigator === 'undefined' ? null : (navigator as unknown as NavigatorLike);

const safeDocument = (): Document | null =>
  typeof document === 'undefined' ? null : document;

const mediaMatches = (
  windowRef: WindowLike | null,
  query: string,
  onProbeError?: CapabilityDependencies['onProbeError'],
): boolean => {
  if (typeof windowRef?.matchMedia !== 'function') return false;
  try {
    return windowRef.matchMedia(query).matches;
  } catch (error) {
    onProbeError?.(error, 'match-media');
    return false;
  }
};

const connectionOf = (navigatorRef: NavigatorLike | null): NetworkInformationLike | null =>
  navigatorRef?.connection ?? navigatorRef?.mozConnection ?? navigatorRef?.webkitConnection ?? null;

const safeEffectiveType = (connection: NetworkInformationLike | null): string | null => {
  const value = connection?.effectiveType;
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  return normalized ? normalized.slice(0, 16) : null;
};

const safeHardwareConcurrency = (navigatorRef: NavigatorLike | null): number => {
  const value = asFiniteNumber(navigatorRef?.hardwareConcurrency);
  if (value === null) return 4;
  return Math.trunc(clampNumber(value, 1, 64, 4));
};

const safeDeviceMemory = (navigatorRef: NavigatorLike | null): number | null => {
  const value = asFiniteNumber(navigatorRef?.deviceMemory);
  return value === null ? null : clampNumber(value, 0.25, 64, 4);
};

const createCanvas = (
  documentRef: Document | null,
  onProbeError?: CapabilityDependencies['onProbeError'],
): HTMLCanvasElement | null => {
  try {
    return documentRef?.createElement?.('canvas') ?? null;
  } catch (error) {
    onProbeError?.(error, 'canvas-create');
    return null;
  }
};

export const probeWebGL2 = (
  documentRef: Document | null = safeDocument(),
  onProbeError?: CapabilityDependencies['onProbeError'],
): boolean => {
  const canvas = createCanvas(documentRef, onProbeError);
  if (!canvas || typeof canvas.getContext !== 'function') return false;
  try {
    return Boolean(canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      failIfMajorPerformanceCaveat: true,
    }));
  } catch (error) {
    onProbeError?.(error, 'webgl2-context');
    return false;
  }
};

const hasAbortSignalTimeout = (): boolean =>
  typeof AbortSignal !== 'undefined' && typeof (AbortSignal as typeof AbortSignal & { timeout?: unknown }).timeout === 'function';

const supportsViewTransition = (documentRef: Document | null): boolean =>
  Boolean(documentRef && typeof (documentRef as Document & { startViewTransition?: unknown }).startViewTransition === 'function');

const detectTier = (
  inputs: Pick<RuntimeCapabilities,
    | 'hardwareConcurrency'
    | 'deviceMemoryGb'
    | 'saveData'
    | 'effectiveConnectionType'
    | 'downlinkMbps'
    | 'roundTripTimeMs'
    | 'supportsWebGL2'
  >,
  thresholds: CapabilityThresholds,
): CapabilityDecision => {
  let score = 0;
  const reasons: string[] = [];

  if (inputs.saveData) {
    score -= 4;
    reasons.push('save-data');
  }

  if (inputs.hardwareConcurrency <= thresholds.minimalCpuCores) {
    score -= 2;
    reasons.push('low-cpu');
  } else if (inputs.hardwareConcurrency >= thresholds.enhancedCpuCores) {
    score += 2;
    reasons.push('high-cpu');
  }

  if (inputs.deviceMemoryGb !== null) {
    if (inputs.deviceMemoryGb <= thresholds.minimalMemoryGb) {
      score -= 2;
      reasons.push('low-memory');
    } else if (inputs.deviceMemoryGb >= thresholds.enhancedMemoryGb) {
      score += 2;
      reasons.push('high-memory');
    }
  }

  const effectiveType = inputs.effectiveConnectionType;
  if (effectiveType === 'slow-2g' || effectiveType === '2g') {
    score -= 3;
    reasons.push('slow-network-type');
  } else if (effectiveType === '4g') {
    score += 1;
  }

  if (inputs.downlinkMbps !== null) {
    if (inputs.downlinkMbps < thresholds.minimalDownlinkMbps) {
      score -= 2;
      reasons.push('low-downlink');
    } else if (inputs.downlinkMbps >= thresholds.enhancedDownlinkMbps) {
      score += 1;
    }
  }

  if (inputs.roundTripTimeMs !== null) {
    if (inputs.roundTripTimeMs >= thresholds.poorRttMs) {
      score -= 2;
      reasons.push('high-rtt');
    } else if (inputs.roundTripTimeMs <= thresholds.enhancedRttMs) {
      score += 1;
    }
  }

  if (!inputs.supportsWebGL2) {
    score -= 2;
    reasons.push('no-webgl2');
  } else {
    score += 1;
  }

  const tier: RuntimeTier = score <= -3 ? 'minimal' : score >= 4 ? 'enhanced' : 'balanced';
  return Object.freeze({ tier, score, reasons: Object.freeze(reasons) });
};

export const createCapabilityProfile = (
  dependencies: CapabilityDependencies = {},
  thresholds: CapabilityThresholds = DEFAULT_CAPABILITY_THRESHOLDS,
): RuntimeCapabilities => {
  const navigatorRef = dependencies.navigatorRef === undefined ? safeNavigator() : dependencies.navigatorRef;
  const windowRef = dependencies.windowRef === undefined ? safeWindow() : dependencies.windowRef;
  const documentRef = dependencies.documentRef === undefined ? safeDocument() : dependencies.documentRef;
  const connection = connectionOf(navigatorRef);
  const downlinkMbps = asFiniteNumber(connection?.downlink);
  const roundTripTimeMs = asFiniteNumber(connection?.rtt);
  const hardwareConcurrency = safeHardwareConcurrency(navigatorRef);
  const deviceMemoryGb = safeDeviceMemory(navigatorRef);
  const saveData = connection?.saveData === true;
  const effectiveConnectionType = safeEffectiveType(connection);
  const supportsWebGL2 = dependencies.webglProbe?.() ?? probeWebGL2(documentRef, dependencies.onProbeError);
  const decision = detectTier({
    hardwareConcurrency,
    deviceMemoryGb,
    saveData,
    effectiveConnectionType,
    downlinkMbps,
    roundTripTimeMs,
    supportsWebGL2,
  }, thresholds);

  return Object.freeze({
    tier: decision.tier,
    hardwareConcurrency,
    deviceMemoryGb,
    reducedMotion: mediaMatches(windowRef, '(prefers-reduced-motion: reduce)', dependencies.onProbeError),
    saveData,
    effectiveConnectionType,
    downlinkMbps,
    roundTripTimeMs,
    online: navigatorRef?.onLine !== false,
    supportsWebGL2,
    supportsWorker: typeof windowRef?.Worker === 'function' || typeof Worker === 'function',
    supportsOffscreenCanvas: typeof windowRef?.OffscreenCanvas === 'function' || typeof OffscreenCanvas === 'function',
    supportsAbortSignalTimeout: hasAbortSignalTimeout(),
    supportsStructuredClone: typeof windowRef?.structuredClone === 'function' || typeof structuredClone === 'function',
    supportsIntersectionObserver: typeof windowRef?.IntersectionObserver === 'function' || typeof IntersectionObserver === 'function',
    supportsResizeObserver: typeof windowRef?.ResizeObserver === 'function' || typeof ResizeObserver === 'function',
    supportsPerformanceObserver: typeof windowRef?.PerformanceObserver === 'function' || typeof PerformanceObserver === 'function',
    supportsSchedulerPostTask: typeof windowRef?.scheduler?.postTask === 'function',
    supportsViewTransition: supportsViewTransition(documentRef),
    supportsTrustedTypes: Boolean(windowRef?.trustedTypes),
    measuredAt: dependencies.now?.() ?? Date.now(),
  });
};

export const explainCapabilityTier = (
  capabilities: RuntimeCapabilities,
  thresholds: CapabilityThresholds = DEFAULT_CAPABILITY_THRESHOLDS,
): CapabilityDecision => detectTier(capabilities, thresholds);

export const capabilityChangedMaterially = (
  previous: RuntimeCapabilities,
  current: RuntimeCapabilities,
): boolean => {
  if (previous.tier !== current.tier) return true;
  if (previous.online !== current.online) return true;
  if (previous.saveData !== current.saveData) return true;
  if (previous.reducedMotion !== current.reducedMotion) return true;
  if (previous.effectiveConnectionType !== current.effectiveConnectionType) return true;

  const previousDownlink = previous.downlinkMbps ?? 0;
  const currentDownlink = current.downlinkMbps ?? 0;
  if (Math.abs(previousDownlink - currentDownlink) >= 2) return true;

  const previousRtt = previous.roundTripTimeMs ?? 0;
  const currentRtt = current.roundTripTimeMs ?? 0;
  return Math.abs(previousRtt - currentRtt) >= 100;
};

export interface CapabilityWatcher {
  readonly snapshot: () => RuntimeCapabilities;
  readonly refresh: () => RuntimeCapabilities;
  readonly subscribe: (listener: (next: RuntimeCapabilities, previous: RuntimeCapabilities) => void) => () => void;
  readonly dispose: () => void;
}

export const createCapabilityWatcher = (
  dependencies: CapabilityDependencies = {},
  thresholds: CapabilityThresholds = DEFAULT_CAPABILITY_THRESHOLDS,
): CapabilityWatcher => {
  const navigatorRef = dependencies.navigatorRef === undefined ? safeNavigator() : dependencies.navigatorRef;
  const windowRef = dependencies.windowRef === undefined ? safeWindow() : dependencies.windowRef;
  const connection = connectionOf(navigatorRef);
  const listeners = new Set<(next: RuntimeCapabilities, previous: RuntimeCapabilities) => void>();
  const cleanups: Array<() => void> = [];
  let current = createCapabilityProfile({ ...dependencies, navigatorRef, windowRef }, thresholds);

  const refresh = (): RuntimeCapabilities => {
    const next = createCapabilityProfile({ ...dependencies, navigatorRef, windowRef }, thresholds);
    const previous = current;
    current = next;
    if (capabilityChangedMaterially(previous, next)) {
      for (const listener of Array.from(listeners)) listener(next, previous);
    }
    return next;
  };

  const listen = (target: EventTargetLike | null | undefined, event: string): void => {
    if (!target?.addEventListener) return;
    const handler: EventListener = () => { refresh(); };
    target.addEventListener(event, handler);
    cleanups.push(() => target.removeEventListener?.(event, handler));
  };

  listen(windowRef, 'online');
  listen(windowRef, 'offline');
  listen(connection, 'change');

  if (typeof windowRef?.matchMedia === 'function') {
    try {
      const motion = windowRef.matchMedia('(prefers-reduced-motion: reduce)');
      listen(motion, 'change');
    } catch (error) {
      dependencies.onProbeError?.(error, 'match-media-listener');
    }
  }

  return Object.freeze({
    snapshot: () => current,
    refresh,
    subscribe: (listener: (next: RuntimeCapabilities, previous: RuntimeCapabilities) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose: () => {
      listeners.clear();
      cleanups.splice(0).forEach((cleanup) => cleanup());
    },
  });
};
