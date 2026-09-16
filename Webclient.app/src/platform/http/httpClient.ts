import { runtimeConfig } from '../config/runtimeConfig';
import { createFetchTransport } from './fetchTransport';
import { createNetworkDiagnostics } from './networkDiagnostics';
import { createCoordinatedClient } from './requestCoordinator.ts';
import { stableSerialize } from './requestPolicy';
import {
  type CoordinatedClient,
  type DiagnosticsSnapshotOptions,
  type RuntimeCapabilityReport,
  type RuntimeTuningProfile,
  type SchedulerLike,
  type SchedulerOptions,
  type Transport
} from './contracts';
import {
  assertRequiredNetworkCapabilities,
  createRuntimeCapabilityReport,
  createRuntimeSupportSummary,
  createRuntimeTuningProfile
} from './runtimeCapabilities';

interface ApiRuntimeConfig {
  apiBaseUrl: string;
  requestTimeoutMs: number;
  maxRetries: number;
  cacheTtlMs: number;
}

interface ApiClientOptions {
  runtimeConfig?: ApiRuntimeConfig;
  diagnostics?: ReturnType<typeof createNetworkDiagnostics>;
  diagnosticCapacity?: number;
  transport?: Transport;
  fetchImpl?: typeof fetch;
  clock?: () => number;
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
  wait?: (milliseconds: number, signal?: AbortSignal | null) => Promise<void>;
  retryOptions?: Record<string, unknown>;
  maxCacheEntries?: number;
  scheduler?: SchedulerLike;
  schedulerOptions?: SchedulerOptions;
  tuningProfile?: RuntimeTuningProfile;
  capabilityReport?: RuntimeCapabilityReport;
  runtime?: Record<string, unknown>;
  assertCapabilities?: boolean;
}

export interface ModernApiClient extends CoordinatedClient {
  getRuntimeCapabilityReport(): RuntimeCapabilityReport;
  getRuntimeTuningProfile(): RuntimeTuningProfile;
  getRuntimeSupportSummary(): Readonly<Record<string, unknown>>;
}

const createTransportDiagnosticHooks = (
  diagnostics: ReturnType<typeof createNetworkDiagnostics>
) => ({
  onStart: ({ method, url, timeout }: { method: string; url: string; timeout: number }) => {
    diagnostics.record('network.transport.started', {
      method,
      url,
      timeoutMs: timeout
    });
  },
  onSuccess: ({
    method,
    url,
    durationMs,
    status
  }: {
    method: string;
    url: string;
    durationMs: number;
    status: number;
  }) => {
    diagnostics.record('network.transport.completed', {
      method,
      url,
      durationMs,
      status
    });
  },
  onFailure: ({
    method,
    url,
    durationMs,
    status,
    error
  }: {
    method: string;
    url: string;
    durationMs: number;
    status?: number | null;
    error?: { code?: string; retryable?: boolean };
  }) => {
    diagnostics.record('network.transport.failed', {
      method,
      url,
      durationMs,
      status,
      code: error?.code,
      retryable: error?.retryable === true
    });
  }
});

const recordRuntimeProfile = (
  diagnostics: ReturnType<typeof createNetworkDiagnostics>,
  capabilityReport: RuntimeCapabilityReport,
  tuningProfile: RuntimeTuningProfile
): void => {
  diagnostics.record('network.runtime.capabilities', {
    supported: capabilityReport.supported,
    missingEssential: capabilityReport.missingEssential,
    optionalSupported: Object.values(capabilityReport.optional).filter(Boolean).length
  });
  diagnostics.record('network.runtime.tuning', {
    networkQuality: tuningProfile.network.quality,
    saveData: tuningProfile.network.saveData,
    memoryClass: tuningProfile.memoryClass,
    hardwareConcurrency: tuningProfile.hardwareConcurrency,
    maxConcurrent: tuningProfile.scheduler.maxConcurrent,
    maxConcurrentPerGroup: tuningProfile.scheduler.maxConcurrentPerGroup,
    maxQueued: tuningProfile.scheduler.maxQueued,
    prefetchAllowed: tuningProfile.prefetchAllowed,
    backgroundWorkAllowed: tuningProfile.backgroundWorkAllowed
  });
};

export const createApiClient = (options: ApiClientOptions = {}): ModernApiClient => {
  const config = options.runtimeConfig || runtimeConfig;
  const capabilityReport = options.capabilityReport || createRuntimeCapabilityReport(
    options.runtime as Record<string, unknown> | undefined
  );
  if (options.assertCapabilities === true) {
    assertRequiredNetworkCapabilities(capabilityReport);
  }

  const tuningProfile = options.tuningProfile || createRuntimeTuningProfile(
    options.runtime as Record<string, unknown> | undefined
  );
  const diagnostics = options.diagnostics || createNetworkDiagnostics({
    capacity: options.diagnosticCapacity || 250,
    clock: options.clock
  });

  recordRuntimeProfile(diagnostics, capabilityReport, tuningProfile);

  const hooks = createTransportDiagnosticHooks(diagnostics);
  const transport = options.transport || createFetchTransport({
    baseUrl: config.apiBaseUrl,
    timeoutMs: config.requestTimeoutMs,
    maxRetries: config.maxRetries,
    cacheTtlMs: config.cacheTtlMs,
    fetchImpl: options.fetchImpl,
    clock: options.clock,
    setTimeout: options.setTimeout,
    clearTimeout: options.clearTimeout,
    ...hooks
  });

  const coordinated = createCoordinatedClient({
    transport: transport as Transport,
    diagnostics,
    timeoutMs: config.requestTimeoutMs,
    maxRetries: config.maxRetries,
    cacheTtlMs: config.cacheTtlMs,
    maxCacheEntries: options.maxCacheEntries || 150,
    clock: options.clock,
    wait: options.wait,
    retryOptions: options.retryOptions,
    scheduler: options.scheduler,
    schedulerOptions: options.schedulerOptions as Record<string, unknown>,
    tuningProfile
  });

  return Object.freeze({
    ...coordinated,
    getRuntimeCapabilityReport: () => capabilityReport,
    getRuntimeTuningProfile: () => tuningProfile,
    getRuntimeSupportSummary: () => createRuntimeSupportSummary(capabilityReport, tuningProfile)
  }) as ModernApiClient;
};

export const apiClient = createApiClient();

export const clearApiClientRuntime = (): void => {
  apiClient.clearCache();
  apiClient.clearDiagnostics();
};

export const getApiClientDiagnostics = (options: DiagnosticsSnapshotOptions = {}) =>
  apiClient.getDiagnostics(options);

export const getApiClientDiagnosticSummary = () =>
  apiClient.getDiagnosticSummary();

export const getApiClientSchedulerSnapshot = () =>
  apiClient.getSchedulerSnapshot();

export const getApiClientRuntimeSupport = () =>
  apiClient.getRuntimeSupportSummary();

export {
  createCoordinatedClient,
  createFetchTransport,
  stableSerialize
};
