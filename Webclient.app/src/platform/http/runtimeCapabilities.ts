import { AppError } from '../errors/appError';
import {
  toBoundedInteger,
  toFiniteNumber
} from './contracts';
import type {
  CoarseConnectionProfile,
  NetworkQuality,
  RuntimeCapabilityReport,
  RuntimeTuningProfile
} from './contracts';

const REQUIRED_CAPABILITIES = Object.freeze([
  'Promise',
  'fetch',
  'AbortController',
  'URL',
  'URLSearchParams'
]);

const OPTIONAL_CAPABILITIES = Object.freeze([
  'FormData',
  'Blob',
  'ArrayBuffer',
  'structuredClone',
  'cryptoSubtle',
  'requestIdleCallback',
  'performanceNow',
  'connectionInfo'
]);

export type RuntimeLike = Record<string, unknown> & {
  navigator?: NavigatorLike | undefined;
  crypto?: { subtle?: unknown } | undefined;
  performance?: { now?: unknown } | undefined;
};

export interface ConnectionLike {
  saveData?: unknown;
  effectiveType?: unknown;
  downlink?: unknown;
  rtt?: unknown;
}

export interface NavigatorLike {
  onLine?: unknown;
  hardwareConcurrency?: unknown;
  deviceMemory?: unknown;
  connection?: ConnectionLike | undefined;
  mozConnection?: ConnectionLike | undefined;
  webkitConnection?: ConnectionLike | undefined;
}

const hasFunction = (runtime: RuntimeLike, key: string): boolean =>
  typeof runtime[key] === 'function';

const getRuntime = (runtime?: RuntimeLike | null): RuntimeLike => {
  if (runtime) return runtime;
  if (typeof globalThis !== 'undefined') return globalThis as unknown as RuntimeLike;
  return {};
};

const readNavigator = (runtime: RuntimeLike): NavigatorLike => {
  const candidate = runtime.navigator;
  return candidate && typeof candidate === 'object' ? candidate : {};
};

const readConnection = (navigatorLike: NavigatorLike): ConnectionLike => {
  const candidate =
    navigatorLike.connection ||
    navigatorLike.mozConnection ||
    navigatorLike.webkitConnection;
  return candidate && typeof candidate === 'object' ? candidate : {};
};

const normalizeEffectiveType = (
  value: unknown
): CoarseConnectionProfile['effectiveType'] => {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (normalized === 'slow-2g') return 'slow-2g';
  if (normalized === '2g') return '2g';
  if (normalized === '3g') return '3g';
  if (normalized === '4g') return '4g';
  return 'unknown';
};

const bucketDownlink = (value: unknown): CoarseConnectionProfile['downlinkBucket'] => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return 'unknown';
  if (numeric < 1) return 'lt-1';
  if (numeric < 4) return '1-4';
  if (numeric < 10) return '4-10';
  return 'gte-10';
};

const bucketRtt = (value: unknown): CoarseConnectionProfile['rttBucket'] => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return 'unknown';
  if (numeric < 100) return 'lt-100';
  if (numeric < 300) return '100-299';
  if (numeric < 1000) return '300-999';
  return 'gte-1000';
};

const deriveNetworkQuality = (
  online: boolean,
  saveData: boolean,
  effectiveType: CoarseConnectionProfile['effectiveType'],
  downlinkBucket: CoarseConnectionProfile['downlinkBucket'],
  rttBucket: CoarseConnectionProfile['rttBucket']
): NetworkQuality => {
  if (!online) return 'offline';
  if (saveData || effectiveType === 'slow-2g' || effectiveType === '2g') return 'constrained';
  if (effectiveType === '3g' || downlinkBucket === 'lt-1' || rttBucket === 'gte-1000') {
    return 'limited';
  }
  if (
    effectiveType === '4g' &&
    (downlinkBucket === '4-10' || downlinkBucket === 'gte-10') &&
    (rttBucket === 'lt-100' || rttBucket === '100-299')
  ) {
    return 'fast';
  }
  return 'normal';
};

export const getCoarseConnectionProfile = (
  runtime?: RuntimeLike | null
): CoarseConnectionProfile => {
  const resolved = getRuntime(runtime);
  const navigatorLike = readNavigator(resolved);
  const connection = readConnection(navigatorLike);
  const online = navigatorLike.onLine !== false;
  const saveData = connection.saveData === true;
  const effectiveType = normalizeEffectiveType(connection.effectiveType);
  const downlinkBucket = bucketDownlink(connection.downlink);
  const rttBucket = bucketRtt(connection.rtt);
  const quality = deriveNetworkQuality(
    online,
    saveData,
    effectiveType,
    downlinkBucket,
    rttBucket
  );

  return Object.freeze({
    quality,
    saveData,
    effectiveType,
    downlinkBucket,
    rttBucket,
    online
  });
};

const getMemoryClass = (value: unknown): RuntimeTuningProfile['memoryClass'] => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return 'unknown';
  if (numeric <= 2) return 'low';
  if (numeric <= 4) return 'medium';
  return 'high';
};

const deriveBaseConcurrency = (
  hardwareConcurrency: number,
  memoryClass: RuntimeTuningProfile['memoryClass']
): number => {
  let concurrency = Math.max(4, Math.min(12, Math.ceil(hardwareConcurrency * 0.75)));
  if (memoryClass === 'low') concurrency = Math.min(concurrency, 5);
  if (memoryClass === 'medium') concurrency = Math.min(concurrency, 8);
  return concurrency;
};

const tuneConcurrencyForNetwork = (
  base: number,
  network: CoarseConnectionProfile
): number => {
  if (network.quality === 'offline') return 1;
  if (network.quality === 'constrained') return Math.min(base, 3);
  if (network.quality === 'limited') return Math.min(base, 5);
  if (network.quality === 'fast') return Math.min(16, Math.max(base, 8));
  return base;
};

const getTimeoutMultiplier = (quality: NetworkQuality): number => {
  if (quality === 'offline') return 0.5;
  if (quality === 'constrained') return 1.8;
  if (quality === 'limited') return 1.4;
  if (quality === 'fast') return 0.9;
  return 1;
};

export const createRuntimeTuningProfile = (
  runtime?: RuntimeLike | null
): RuntimeTuningProfile => {
  const resolved = getRuntime(runtime);
  const navigatorLike = readNavigator(resolved);
  const network = getCoarseConnectionProfile(resolved);
  const hardwareConcurrency = toBoundedInteger(
    navigatorLike.hardwareConcurrency,
    4,
    1,
    64
  );
  const memoryClass = getMemoryClass(navigatorLike.deviceMemory);
  const baseConcurrency = deriveBaseConcurrency(hardwareConcurrency, memoryClass);
  const maxConcurrent = tuneConcurrencyForNetwork(baseConcurrency, network);
  const maxConcurrentPerGroup = Math.max(1, Math.min(6, Math.ceil(maxConcurrent / 2)));
  const highPriorityReserve = maxConcurrent >= 4 ? Math.min(2, maxConcurrent - 1) : 1;
  const queueMultiplier = network.quality === 'constrained' || network.quality === 'limited'
    ? 12
    : 18;
  const maxQueued = Math.max(48, Math.min(256, maxConcurrent * queueMultiplier));
  const prefetchAllowed =
    network.online &&
    !network.saveData &&
    network.quality !== 'constrained' &&
    network.quality !== 'limited';
  const backgroundWorkAllowed =
    prefetchAllowed &&
    memoryClass !== 'low' &&
    hardwareConcurrency >= 4;

  return Object.freeze({
    network,
    hardwareConcurrency,
    memoryClass,
    scheduler: Object.freeze({
      maxConcurrent,
      maxConcurrentPerGroup,
      maxQueued,
      highPriorityReserve,
      agingIntervalMs: network.quality === 'constrained' ? 1000 : 1500,
      starvationThresholdMs: network.quality === 'constrained' ? 6000 : 8000
    }),
    prefetchAllowed,
    backgroundWorkAllowed,
    timeoutMultiplier: getTimeoutMultiplier(network.quality)
  });
};

const capabilityBoolean = (value: unknown): boolean => value === true;

export const createRuntimeCapabilityReport = (
  runtime?: RuntimeLike | null,
  now: () => number = () => Date.now()
): RuntimeCapabilityReport => {
  const resolved = getRuntime(runtime);
  const navigatorLike = readNavigator(resolved);
  const connection = readConnection(navigatorLike);

  const essential = Object.freeze({
    Promise: hasFunction(resolved, 'Promise'),
    fetch: hasFunction(resolved, 'fetch'),
    AbortController: hasFunction(resolved, 'AbortController'),
    URL: hasFunction(resolved, 'URL'),
    URLSearchParams: hasFunction(resolved, 'URLSearchParams')
  });

  const optional = Object.freeze({
    FormData: hasFunction(resolved, 'FormData'),
    Blob: hasFunction(resolved, 'Blob'),
    ArrayBuffer: hasFunction(resolved, 'ArrayBuffer'),
    structuredClone: hasFunction(resolved, 'structuredClone'),
    cryptoSubtle: Boolean(resolved.crypto && typeof resolved.crypto.subtle === 'object'),
    requestIdleCallback: hasFunction(resolved, 'requestIdleCallback'),
    performanceNow: Boolean(resolved.performance && typeof resolved.performance.now === 'function'),
    connectionInfo: Object.keys(connection).length > 0
  });

  const missingEssential = REQUIRED_CAPABILITIES.filter(
    (key) => !capabilityBoolean(essential[key as keyof typeof essential])
  );

  const generated = Number(now());
  return Object.freeze({
    generatedAt: Number.isFinite(generated) ? generated : Date.now(),
    essential,
    optional,
    missingEssential: Object.freeze([...missingEssential]),
    supported: missingEssential.length === 0
  });
};

export const assertRequiredNetworkCapabilities = (
  report: RuntimeCapabilityReport = createRuntimeCapabilityReport()
): RuntimeCapabilityReport => {
  if (report.supported) return report;
  throw new AppError('Browser network capabilities are insufficient.', {
    code: 'UNSUPPORTED_BROWSER_RUNTIME',
    retryable: false,
    details: {
      missing: [...report.missingEssential]
    }
  });
};

export const createRuntimeSupportSummary = (
  report: RuntimeCapabilityReport = createRuntimeCapabilityReport(),
  tuning: RuntimeTuningProfile = createRuntimeTuningProfile()
) => Object.freeze({
  supported: report.supported,
  missingEssential: Object.freeze([...report.missingEssential]),
  essentialCount: REQUIRED_CAPABILITIES.length,
  optionalSupported: OPTIONAL_CAPABILITIES.filter(
    (key) => capabilityBoolean(report.optional[key])
  ).length,
  networkQuality: tuning.network.quality,
  saveData: tuning.network.saveData,
  prefetchAllowed: tuning.prefetchAllowed,
  backgroundWorkAllowed: tuning.backgroundWorkAllowed,
  maxConcurrent: tuning.scheduler.maxConcurrent,
  maxConcurrentPerGroup: tuning.scheduler.maxConcurrentPerGroup
});

export const scaleTimeoutForRuntime = (
  timeoutMs: unknown,
  tuning: RuntimeTuningProfile = createRuntimeTuningProfile()
): number => {
  const base = toFiniteNumber(timeoutMs, 15000, 1000, 60000);
  if (!tuning.network.online) return Math.max(1000, Math.round(base * 0.5));
  return Math.max(1000, Math.min(60000, Math.round(base * tuning.timeoutMultiplier)));
};

export const RuntimeCapabilityPolicy = Object.freeze({
  required: REQUIRED_CAPABILITIES,
  optional: OPTIONAL_CAPABILITIES,
  createRuntimeCapabilityReport,
  assertRequiredNetworkCapabilities,
  getCoarseConnectionProfile,
  createRuntimeTuningProfile,
  createRuntimeSupportSummary,
  scaleTimeoutForRuntime
});
