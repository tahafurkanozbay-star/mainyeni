export type AppErrorCode =
  | 'APP_ERROR'
  | 'ABORTED'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'TIMEOUT'
  | 'RATE_LIMITED'
  | 'SERVER_ERROR'
  | 'NETWORK_ERROR'
  | 'HTTP_ERROR'
  | 'VALIDATION_ERROR'
  | 'CONFIGURATION_ERROR'
  | 'INVARIANT_ERROR'
  | (string & {});

export interface AppErrorDetails {
  code?: AppErrorCode;
  status?: number | null;
  retryable?: boolean;
  requestId?: string | null;
  details?: unknown;
  cause?: unknown;
}

export interface ErrorLike {
  name?: unknown;
  code?: unknown;
  message?: unknown;
  status?: unknown;
  requestId?: unknown;
  response?: {
    status?: unknown;
    data?: unknown;
    headers?: unknown;
  } | null;
}

export interface ProblemDetailsLike {
  type?: unknown;
  title?: unknown;
  status?: unknown;
  detail?: unknown;
  instance?: unknown;
  message?: unknown;
  traceId?: unknown;
  requestId?: unknown;
  errors?: unknown;
}

const MAX_SERVER_MESSAGE_LENGTH = 240;
const MAX_REQUEST_ID_LENGTH = 128;

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;

const asFiniteStatus = (value: unknown): number | null => {
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric < 100 || numeric > 599) return null;
  return numeric;
};

const asBoundedText = (value: unknown, maxLength: number): string | null => {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) return null;
  return normalized;
};

const readHeader = (headers: unknown, name: string): string | null => {
  if (!headers) return null;
  const normalizedName = name.toLowerCase();

  if (typeof (headers as { get?: unknown }).get === 'function') {
    try {
      const value = (headers as { get(name: string): unknown }).get(name);
      return asBoundedText(value, MAX_REQUEST_ID_LENGTH);
    } catch (_error) {
      return null;
    }
  }

  const record = asRecord(headers);
  if (!record) return null;
  for (const [key, value] of Object.entries(record)) {
    if (key.toLowerCase() === normalizedName) {
      return asBoundedText(value, MAX_REQUEST_ID_LENGTH);
    }
  }
  return null;
};

const safeServerMessage = (data: unknown): string | null => {
  const record = asRecord(data);
  if (!record) return null;

  return asBoundedText(record.message, MAX_SERVER_MESSAGE_LENGTH)
    || asBoundedText(record.detail, MAX_SERVER_MESSAGE_LENGTH)
    || asBoundedText(record.title, MAX_SERVER_MESSAGE_LENGTH);
};

const requestIdFrom = (error: ErrorLike): string | null => {
  const direct = asBoundedText(error.requestId, MAX_REQUEST_ID_LENGTH);
  if (direct) return direct;

  const data = asRecord(error.response?.data);
  const bodyId = data
    ? asBoundedText(data.requestId, MAX_REQUEST_ID_LENGTH)
      || asBoundedText(data.traceId, MAX_REQUEST_ID_LENGTH)
    : null;
  if (bodyId) return bodyId;

  return readHeader(error.response?.headers, 'x-request-id')
    || readHeader(error.response?.headers, 'x-correlation-id');
};

export class AppError extends Error {
  readonly code: AppErrorCode;
  readonly status: number | null;
  readonly retryable: boolean;
  readonly requestId: string | null;
  readonly details: unknown;
  readonly cause?: unknown;

  constructor(message: string, details: AppErrorDetails = {}) {
    super(message);
    this.name = 'AppError';
    this.code = details.code || 'APP_ERROR';
    this.status = details.status ?? null;
    this.retryable = details.retryable === true;
    this.requestId = details.requestId || null;
    this.details = details.details ?? null;
    this.cause = details.cause;
  }

  toSafeJSON(): Readonly<Record<string, unknown>> {
    return Object.freeze({
      name: this.name,
      code: this.code,
      message: this.message,
      status: this.status,
      retryable: this.retryable,
      requestId: this.requestId
    });
  }
}

export const isAppError = (error: unknown): error is AppError => error instanceof AppError;

export const isAbortError = (error: unknown): boolean => {
  const candidate = (error || {}) as ErrorLike;
  const name = String(candidate.name || '');
  const code = String(candidate.code || '');
  const message = String(candidate.message || '');

  return name === 'AbortError'
    || code === 'ERR_CANCELED'
    || code === 'ABORTED'
    || (code === 'ECONNABORTED' && /cancel/i.test(message));
};

export const isTimeoutError = (error: unknown): boolean => {
  const candidate = (error || {}) as ErrorLike;
  const status = asFiniteStatus(candidate.response?.status ?? candidate.status);
  const code = String(candidate.code || '');
  if (status === 408) return true;
  if (code !== 'ECONNABORTED') return false;
  return !/cancel/i.test(String(candidate.message || ''));
};

export const normalizeProblemDetails = (value: unknown): Readonly<Record<string, unknown>> | null => {
  const record = asRecord(value);
  if (!record) return null;

  const result: Record<string, unknown> = {};
  const status = asFiniteStatus(record.status);
  const title = asBoundedText(record.title, MAX_SERVER_MESSAGE_LENGTH);
  const detail = asBoundedText(record.detail, MAX_SERVER_MESSAGE_LENGTH);
  const instance = asBoundedText(record.instance, MAX_SERVER_MESSAGE_LENGTH);
  const requestId = asBoundedText(record.requestId, MAX_REQUEST_ID_LENGTH)
    || asBoundedText(record.traceId, MAX_REQUEST_ID_LENGTH);

  if (status !== null) result.status = status;
  if (title) result.title = title;
  if (detail) result.detail = detail;
  if (instance) result.instance = instance;
  if (requestId) result.requestId = requestId;

  return Object.keys(result).length ? Object.freeze(result) : null;
};

/**
 * Compatibility normalizer retained under the historical name while the
 * underlying transport is native Fetch. It accepts Axios-like and Fetch-like
 * error shapes without leaking raw response bodies into UI surfaces.
 */
export const normalizeAxiosError = (error: unknown): AppError => {
  if (error instanceof AppError) return error;
  if (isAbortError(error)) {
    return new AppError('Request cancelled', {
      code: 'ABORTED',
      retryable: false,
      cause: error
    });
  }

  const candidate = (error || {}) as ErrorLike;
  const status = asFiniteStatus(candidate.response?.status ?? candidate.status);
  const data = candidate.response?.data;
  const serverMessage = safeServerMessage(data);
  const requestId = requestIdFrom(candidate);
  const common = { status, requestId, cause: error };

  if (status === 401) {
    return new AppError('Oturum doğrulaması gerekli.', {
      ...common,
      code: 'UNAUTHORIZED',
      retryable: false
    });
  }
  if (status === 403) {
    return new AppError('Bu işlem için yetkiniz yok.', {
      ...common,
      code: 'FORBIDDEN',
      retryable: false
    });
  }
  if (status === 404) {
    return new AppError('İstenen kaynak bulunamadı.', {
      ...common,
      code: 'NOT_FOUND',
      retryable: false
    });
  }
  if (status === 408 || isTimeoutError(error)) {
    return new AppError('İstek zaman aşımına uğradı.', {
      ...common,
      code: 'TIMEOUT',
      status: status || 408,
      retryable: true
    });
  }
  if (status === 429) {
    return new AppError('Çok fazla istek gönderildi. Lütfen tekrar deneyin.', {
      ...common,
      code: 'RATE_LIMITED',
      retryable: true
    });
  }
  if (status !== null && status >= 500) {
    return new AppError('Sunucu geçici olarak kullanılamıyor.', {
      ...common,
      code: 'SERVER_ERROR',
      retryable: true
    });
  }
  if (status === null) {
    return new AppError('Ağ bağlantısı kurulamadı.', {
      ...common,
      code: 'NETWORK_ERROR',
      retryable: true
    });
  }

  return new AppError(serverMessage || 'İstek tamamlanamadı.', {
    ...common,
    code: 'HTTP_ERROR',
    retryable: false,
    details: normalizeProblemDetails(data)
  });
};

export const getSafeErrorMessage = (
  error: unknown,
  fallback = 'Beklenmeyen bir hata oluştu.'
): string => error instanceof AppError ? error.message : fallback;

export const toAppError = (
  error: unknown,
  fallbackMessage = 'Beklenmeyen bir hata oluştu.',
  fallbackCode: AppErrorCode = 'APP_ERROR'
): AppError => {
  if (error instanceof AppError) return error;
  const normalized = normalizeAxiosError(error);
  if (normalized.code !== 'HTTP_ERROR' && normalized.code !== 'NETWORK_ERROR') return normalized;
  return new AppError(fallbackMessage, {
    code: fallbackCode,
    retryable: normalized.retryable,
    status: normalized.status,
    requestId: normalized.requestId,
    cause: error
  });
};
