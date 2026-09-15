/** Shared GIS service registry with timeout, retry, cancellation and health state. */

const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_RETRIES = 2;
const MAX_RETRIES = 5;
const MIN_TIMEOUT_MS = 1000;
const MAX_TIMEOUT_MS = 120000;

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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const normalizeTimeout = (value) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return DEFAULT_TIMEOUT_MS;
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, numeric));
};

const normalizeRetries = (value) => {
  if (!Number.isInteger(value)) return DEFAULT_RETRIES;
  return Math.min(MAX_RETRIES, Math.max(0, value));
};

const cancelledError = (serviceId) => new GisServiceError('GIS request cancelled.', {
  code: 'CANCELLED',
  serviceId,
});

const throwIfAborted = (signal, serviceId) => {
  if (signal?.aborted) throw cancelledError(serviceId);
};

const createAttemptController = () => (
  typeof AbortController !== 'undefined' ? new AbortController() : null
);

const runAttempt = (requestFactory, service, { timeoutMs, externalSignal, attempt }) => {
  throwIfAborted(externalSignal, service.id);

  const controller = createAttemptController();
  const requestSignal = controller?.signal || externalSignal;
  let timer = null;
  let abortHandler = null;

  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller?.abort();
      reject(new GisServiceError(`GIS request timed out after ${timeoutMs} ms`, {
        code: 'TIMEOUT',
        serviceId: service.id,
      }));
    }, timeoutMs);
  });

  const cancellation = externalSignal
    ? new Promise((_, reject) => {
        abortHandler = () => {
          controller?.abort();
          reject(cancelledError(service.id));
        };
        externalSignal.addEventListener('abort', abortHandler, { once: true });
      })
    : null;

  const request = Promise.resolve().then(() => requestFactory(service, {
    signal: requestSignal,
    attempt,
  }));

  return Promise.race(cancellation ? [request, timeout, cancellation] : [request, timeout])
    .finally(() => {
      if (timer !== null) clearTimeout(timer);
      if (abortHandler) externalSignal.removeEventListener('abort', abortHandler);
    });
};

const isRetryable = (error) => (
  error?.code === 'TIMEOUT' ||
  error?.code === 'NETWORK_ERROR' ||
  error?.status === 408 ||
  error?.status === 429 ||
  error?.status >= 500
);

const normalizeService = (service = {}) => ({
  id: service.id,
  type: service.type || 'generic',
  url: service.url,
  title: service.title || service.id,
  enabled: service.enabled !== false,
  timeoutMs: normalizeTimeout(service.timeoutMs),
  retries: normalizeRetries(service.retries),
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
    if (!normalized.id || !normalized.url) {
      throw new GisServiceError('A GIS service requires an id and url', { code: 'INVALID_SERVICE' });
    }
    this.services.set(normalized.id, normalized);
    if (!this.health.has(normalized.id)) {
      this.health.set(normalized.id, {
        status: 'unknown',
        checkedAt: null,
        latencyMs: null,
        attempts: 0,
        error: null,
      });
    }
    return normalized;
  }

  unregister(serviceId) {
    this.health.delete(serviceId);
    return this.services.delete(serviceId);
  }

  get(serviceId) {
    return this.services.get(serviceId) || null;
  }

  list() {
    return Array.from(this.services.values());
  }

  getHealth(serviceId) {
    return this.health.get(serviceId) || null;
  }

  setHealth(serviceId, patch) {
    const next = {
      ...(this.health.get(serviceId) || {}),
      ...patch,
      checkedAt: new Date().toISOString(),
    };
    this.health.set(serviceId, next);
    return next;
  }

  async request(serviceId, requestFactory, options = {}) {
    const service = this.get(serviceId);
    if (!service) {
      throw new GisServiceError(`Unknown GIS service: ${serviceId}`, {
        code: 'UNKNOWN_SERVICE',
        serviceId,
      });
    }
    if (!service.enabled) {
      throw new GisServiceError(`GIS service is disabled: ${serviceId}`, {
        code: 'DISABLED_SERVICE',
        serviceId,
      });
    }
    if (typeof requestFactory !== 'function') {
      throw new GisServiceError('A GIS request factory is required.', {
        code: 'INVALID_REQUEST_FACTORY',
        serviceId,
      });
    }

    const timeoutMs = options.timeoutMs === undefined
      ? service.timeoutMs
      : normalizeTimeout(options.timeoutMs);
    const retries = options.retries === undefined
      ? service.retries
      : normalizeRetries(options.retries);
    const startedAt = Date.now();
    let attempt = 0;
    let lastError;

    while (attempt <= retries) {
      throwIfAborted(options.signal, serviceId);
      const attemptNumber = attempt + 1;
      try {
        const result = await runAttempt(requestFactory, service, {
          timeoutMs,
          externalSignal: options.signal,
          attempt: attemptNumber,
        });
        this.setHealth(serviceId, {
          status: 'healthy',
          latencyMs: Date.now() - startedAt,
          attempts: attemptNumber,
          error: null,
        });
        return result;
      } catch (error) {
        lastError = error instanceof GisServiceError
          ? error
          : new GisServiceError(error?.message || 'GIS request failed', {
              code: 'NETWORK_ERROR',
              serviceId,
              status: error?.status,
              cause: error,
            });
        attempt += 1;
        if (attempt > retries || !isRetryable(lastError)) break;
        await sleep(Math.min(1000 * (2 ** (attempt - 1)), 4000));
      }
    }

    this.setHealth(serviceId, {
      status: lastError?.code === 'CANCELLED' ? 'unknown' : 'unhealthy',
      latencyMs: Date.now() - startedAt,
      attempts: attempt,
      error: {
        code: lastError?.code || 'GIS_SERVICE_ERROR',
        message: lastError?.message || 'GIS request failed',
      },
    });
    throw lastError;
  }

  async checkHealth(serviceId, probe, options = {}) {
    try {
      await this.request(serviceId, probe, { ...options, retries: 0 });
      return this.getHealth(serviceId);
    } catch (error) {
      return this.setHealth(serviceId, {
        status: error?.code === 'CANCELLED' ? 'unknown' : 'unhealthy',
        error: {
          code: error?.code || 'PROBE_FAILED',
          message: error?.message || 'GIS health probe failed.',
        },
      });
    }
  }
}

export const createGisServiceRegistry = (services) => new GisServiceRegistry(services);
