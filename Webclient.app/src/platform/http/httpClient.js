import { runtimeConfig } from '../config/runtimeConfig';
import { createFetchTransport } from './fetchTransport';
import { createNetworkDiagnostics } from './networkDiagnostics';
import { createCoordinatedClient } from './requestCoordinator';

const createTransportDiagnosticHooks = (diagnostics) => ({
  onStart: ({ method, url, timeout }) => {
    diagnostics.record('network.transport.started', {
      method,
      url,
      timeoutMs: timeout
    });
  },
  onSuccess: ({ method, url, durationMs, status }) => {
    diagnostics.record('network.transport.completed', {
      method,
      url,
      durationMs,
      status
    });
  },
  onFailure: ({ method, url, durationMs, status, error }) => {
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

export const createApiClient = (options = {}) => {
  const config = options.runtimeConfig || runtimeConfig;
  const diagnostics = options.diagnostics || createNetworkDiagnostics({
    capacity: options.diagnosticCapacity || 250,
    clock: options.clock
  });

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

  return createCoordinatedClient({
    transport,
    diagnostics,
    timeoutMs: config.requestTimeoutMs,
    maxRetries: config.maxRetries,
    cacheTtlMs: config.cacheTtlMs,
    maxCacheEntries: options.maxCacheEntries || 150,
    clock: options.clock,
    wait: options.wait,
    retryOptions: options.retryOptions
  });
};

export const apiClient = createApiClient();

export const clearApiClientRuntime = () => {
  apiClient.clearCache();
  apiClient.clearDiagnostics();
};

export const getApiClientDiagnostics = (options = {}) =>
  apiClient.getDiagnostics(options);

export const getApiClientDiagnosticSummary = () =>
  apiClient.getDiagnosticSummary();

export {
  createCoordinatedClient,
  createFetchTransport
};
