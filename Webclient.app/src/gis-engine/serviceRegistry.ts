import type {
  GisRequestFactory,
  GisRequestOptions,
  GisServiceHealth,
  GisServiceInput,
  RegisteredGisService,
  RuntimeErrorDetails,
} from './contracts';

/** Shared GIS service registry with timeout, retry, cancellation and health state. */

const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_RETRIES = 2;
const MAX_RETRIES = 5;
const MIN_TIMEOUT_MS = 1000;
const MAX_TIMEOUT_MS = 120000;

export interface GisServiceErrorDetails extends RuntimeErrorDetails {
  serviceId?: string;
}

export class GisServiceError extends Error {
  code: string;
  serviceId?: string;
  status?: number;
  cause?: unknown;

  constructor(message: string, details: GisServiceErrorDetails = {}) {
    super(message);
    this.name = 'GisServiceError';
    this.code = details.code || 'GIS_SERVICE_ERROR';
    this.serviceId = details.serviceId;
    this.status = details.status;
    this.cause = details.cause;
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const normalizeTimeout = (value: unknown): number => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return DEFAULT_TIMEOUT_MS;
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, numeric));
};

const normalizeRetries = (value: unknown): number => {
  if (!Number.isInteger(value)) return DEFAULT_RETRIES;
  return Math.min(MAX_RETRIES, Math.max(0, Number(value)));
};

const cancelledError = (serviceId: string): GisServiceError => new GisServiceError('GIS request cancelled.', {
  code: 'CANCELLED',
  serviceId,
});

const throwIfAborted = (signal: AbortSignal | undefined, serviceId: string): void => {
  if (signal?.aborted) throw cancelledError(serviceId);
};

const createAttemptController = (): AbortController | null => (
  typeof AbortController !== 'undefined' ? new AbortController() : null
);

interface RunAttemptOptions {
  timeoutMs: number;
  externalSignal?: AbortSignal;
  attempt: number;
}

const runAttempt = <T>(
  requestFactory: GisRequestFactory<T>,
  service: RegisteredGisService,
  { timeoutMs, externalSignal, attempt }: RunAttemptOptions,
): Promise<T> => {
  throwIfAborted(externalSignal, service.id);

  const controller = createAttemptController();
  const requestSignal = controller?.signal || externalSignal;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let abortHandler: (() => void) | null = null;

  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller?.abort();
      reject(new GisServiceError(`GIS request timed out after ${timeoutMs} ms`, {
        code: 'TIMEOUT',
        serviceId: service.id,
      }));
    }, timeoutMs);
  });

  const cancellation = externalSignal
    ? new Promise<never>((_, reject) => {
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
      if (abortHandler && externalSignal) externalSignal.removeEventListener('abort', abortHandler);
    }) as Promise<T>;
};

const isRetryable = (error: GisServiceError): boolean => (
  error?.code === 'TIMEOUT' ||
  error?.code === 'NETWORK_ERROR' ||
  error?.status === 408 ||
  error?.status === 429 ||
  (typeof error?.status === 'number' && error.status >= 500)
);

const normalizeService = (service: GisServiceInput = {}): RegisteredGisService => ({
  ...service,
  id: String(service.id ?? ''),
  type: String(service.type || 'generic'),
  url: String(service.url || ''),
  title: String(service.title || service.id || ''),
  enabled: service.enabled !== false,
  timeoutMs: normalizeTimeout(service.timeoutMs),
  retries: normalizeRetries(service.retries),
  headers: { ...service.headers },
  metadata: { ...service.metadata },
});

const initialHealth = (): GisServiceHealth => ({
  status: 'unknown',
  checkedAt: null,
  latencyMs: null,
  attempts: 0,
  error: null,
});

const asError = (error: unknown, serviceId: string): GisServiceError => {
  if (error instanceof GisServiceError) return error;
  const candidate = error as { message?: string; status?: number } | null;
  return new GisServiceError(candidate?.message || 'GIS request failed', {
    code: 'NETWORK_ERROR',
    serviceId,
    status: candidate?.status,
    cause: error,
  });
};

export class GisServiceRegistry {
  private services = new Map<string, RegisteredGisService>();
  private health = new Map<string, GisServiceHealth>();

  constructor(initialServices: GisServiceInput[] = []) {
    initialServices.forEach((service) => this.register(service));
  }

  register(service: GisServiceInput): RegisteredGisService {
    const normalized = normalizeService(service);
    if (!normalized.id || !normalized.url) {
      throw new GisServiceError('A GIS service requires an id and url', { code: 'INVALID_SERVICE' });
    }
    this.services.set(normalized.id, normalized);
    if (!this.health.has(normalized.id)) this.health.set(normalized.id, initialHealth());
    return normalized;
  }

  unregister(serviceId: string): boolean {
    this.health.delete(serviceId);
    return this.services.delete(serviceId);
  }

  get(serviceId: string): RegisteredGisService | null {
    return this.services.get(serviceId) || null;
  }

  list(): RegisteredGisService[] {
    return Array.from(this.services.values());
  }

  getHealth(serviceId: string): GisServiceHealth | null {
    return this.health.get(serviceId) || null;
  }

  setHealth(serviceId: string, patch: Partial<GisServiceHealth>): GisServiceHealth {
    const next: GisServiceHealth = {
      ...(this.health.get(serviceId) || initialHealth()),
      ...patch,
      checkedAt: new Date().toISOString(),
    };
    this.health.set(serviceId, next);
    return next;
  }

  async request<T>(
    serviceId: string,
    requestFactory: GisRequestFactory<T>,
    options: GisRequestOptions = {},
  ): Promise<T> {
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
    let lastError: GisServiceError | undefined;

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
        lastError = asError(error, serviceId);
        attempt += 1;
        if (attempt > retries || !isRetryable(lastError)) break;
        await sleep(Math.min(1000 * (2 ** (attempt - 1)), 4000));
      }
    }

    const terminalError = lastError || new GisServiceError('GIS request failed', { serviceId });
    this.setHealth(serviceId, {
      status: terminalError.code === 'CANCELLED' ? 'unknown' : 'unhealthy',
      latencyMs: Date.now() - startedAt,
      attempts: attempt,
      error: {
        code: terminalError.code || 'GIS_SERVICE_ERROR',
        message: terminalError.message || 'GIS request failed',
      },
    });
    throw terminalError;
  }

  async checkHealth<T>(
    serviceId: string,
    probe: GisRequestFactory<T>,
    options: GisRequestOptions = {},
  ): Promise<GisServiceHealth | null> {
    try {
      await this.request(serviceId, probe, { ...options, retries: 0 });
      return this.getHealth(serviceId);
    } catch (error) {
      const normalized = asError(error, serviceId);
      return this.setHealth(serviceId, {
        status: normalized.code === 'CANCELLED' ? 'unknown' : 'unhealthy',
        error: {
          code: normalized.code || 'PROBE_FAILED',
          message: normalized.message || 'GIS health probe failed.',
        },
      });
    }
  }
}

export const createGisServiceRegistry = (
  services: GisServiceInput[] = [],
): GisServiceRegistry => new GisServiceRegistry(services);
