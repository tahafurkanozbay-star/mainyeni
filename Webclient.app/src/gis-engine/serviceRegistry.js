/** Shared GIS service registry with timeout, retry and health state. */

import { assertEndpointAllowed } from '../platform/network/endpointPolicy';

const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_RETRIES = 2;

export class GisServiceError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'GisServiceError';
    this.code = details.code || 'GIS_SERVICE_ERROR';
    this.serviceId = details.serviceId;
    this.status = details.status;
    this.cause = details.cause;
  }
}

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) {
    reject(Object.assign(new Error('Request aborted'), { name: 'AbortError' }));
    return;
  }
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => {
    clearTimeout(timer);
    reject(Object.assign(new Error('Request aborted'), { name: 'AbortError' }));
  }, { once: true });
});

const withTimeout = (promise, timeoutMs, serviceId, signal) => {
  let timer;
  let abortHandler;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new GisServiceError(`GIS request timed out after ${timeoutMs} ms`, { code: 'TIMEOUT', serviceId })), timeoutMs);
  });
  const abort = new Promise((_, reject) => {
    abortHandler = () => reject(new GisServiceError('GIS request was aborted', { code: 'ABORTED', serviceId }));
    signal?.addEventListener('abort', abortHandler, { once: true });
  });
  return Promise.race([promise, timeout, abort]).finally(() => {
    clearTimeout(timer);
    if (signal && abortHandler) signal.removeEventListener('abort', abortHandler);
  });
};

const isRetryable = (error) => error?.code === 'TIMEOUT' || error?.code === 'NETWORK_ERROR' || error?.status === 408 || error?.status === 429 || error?.status >= 500;

const normalizeService = (service) => ({
  id: service.id,
  type: service.type || 'generic',
  url: service.url,
  title: service.title || service.id,
  enabled: service.enabled !== false,
  timeoutMs: service.timeoutMs || DEFAULT_TIMEOUT_MS,
  retries: Number.isInteger(service.retries) ? service.retries : DEFAULT_RETRIES,
  headers: { ...(service.headers || {}) },
  metadata: { ...(service.metadata || {}) },
});

export class GisServiceRegistry {
  constructor(initialServices = []) {
    this.services = new Map();
    this.health = new Map();
    initialServices.forEach((service) => this.register(service));
  }

  register(service) {
    const normalized = normalizeService(service);
    if (!normalized.id || !normalized.url) throw new GisServiceError('A GIS service requires an id and url', { code: 'INVALID_SERVICE' });
    try {
      assertEndpointAllowed(normalized.url, { serviceType: normalized.type });
    } catch (error) {
      throw new GisServiceError(error.message, { code: error.code || 'UNAPPROVED_ENDPOINT', serviceId: normalized.id, cause: error });
    }
    this.services.set(normalized.id, normalized);
    if (!this.health.has(normalized.id)) this.health.set(normalized.id, { status: 'unknown', checkedAt: null, latencyMs: null, error: null });
    return normalized;
  }

  unregister(serviceId) {
    this.health.delete(serviceId);
    return this.services.delete(serviceId);
  }

  get(serviceId) { return this.services.get(serviceId) || null; }
  list() { return Array.from(this.services.values()); }
  getHealth(serviceId) { return this.health.get(serviceId) || null; }

  setHealth(serviceId, patch) {
    const next = { ...(this.health.get(serviceId) || {}), ...patch, checkedAt: new Date().toISOString() };
    this.health.set(serviceId, next);
    return next;
  }

  async request(serviceId, requestFactory, options = {}) {
    const service = this.get(serviceId);
    if (!service) throw new GisServiceError(`Unknown GIS service: ${serviceId}`, { code: 'UNKNOWN_SERVICE', serviceId });
    if (!service.enabled) throw new GisServiceError(`GIS service is disabled: ${serviceId}`, { code: 'DISABLED_SERVICE', serviceId });

    const timeoutMs = options.timeoutMs || service.timeoutMs;
    const retries = Number.isInteger(options.retries) ? options.retries : service.retries;
    const startedAt = Date.now();
    let attempt = 0;
    let lastError;

    while (attempt <= retries) {
      try {
        const result = await withTimeout(
          Promise.resolve().then(() => requestFactory(service, options.signal)),
          timeoutMs,
          serviceId,
          options.signal,
        );
        this.setHealth(serviceId, { status: 'healthy', latencyMs: Date.now() - startedAt, error: null });
        return result;
      } catch (error) {
        lastError = error instanceof GisServiceError ? error : new GisServiceError(error.message || 'GIS request failed', { code: 'NETWORK_ERROR', serviceId, cause: error });
        attempt += 1;
        if (attempt > retries || !isRetryable(lastError)) break;
        await sleep(Math.min(1000 * (2 ** (attempt - 1)), 4000), options.signal);
      }
    }

    this.setHealth(serviceId, { status: 'unhealthy', latencyMs: Date.now() - startedAt, error: { code: lastError.code, message: lastError.message } });
    throw lastError;
  }

  async checkHealth(serviceId, probe) {
    try {
      await this.request(serviceId, probe, { retries: 0 });
      return this.setHealth(serviceId, { status: 'healthy', error: null });
    } catch (error) {
      return this.setHealth(serviceId, { status: 'unhealthy', error: { code: error.code || 'PROBE_FAILED', message: error.message } });
    }
  }
}

export const createGisServiceRegistry = (services) => new GisServiceRegistry(services);
