export interface AppErrorOptions {
  readonly code?: string;
  readonly status?: number | null;
  readonly retryable?: boolean;
  readonly requestId?: string | null;
  readonly details?: Readonly<Record<string, unknown>> | null;
  readonly cause?: unknown;
}

interface TransportResponseLike {
  readonly status?: unknown;
  readonly data?: unknown;
  readonly headers?: unknown;
}

interface TransportErrorLike {
  readonly name?: unknown;
  readonly code?: unknown;
  readonly message?: unknown;
  readonly status?: unknown;
  readonly response?: TransportResponseLike;
  readonly requestId?: unknown;
  readonly cause?: unknown;
}

const MAX_MESSAGE_LENGTH = 240;
const MAX_CODE_LENGTH = 80;
const MAX_REQUEST_ID_LENGTH = 120;

const safeString = (value: unknown, maxLength: number): string | null => {
  if (typeof value !== 'string') return null;
  const normalized = value.replace(/[\r\n\t]/g, ' ').replace(/\s{2,}/g, ' ').trim();
  return normalized ? normalized.slice(0, maxLength) : null;
};

const safeCode = (value: unknown): string => {
  const normalized = safeString(value, MAX_CODE_LENGTH);
  if (!normalized) return 'APP_ERROR';
  return normalized.replace(/[^A-Z0-9_.:-]/gi, '_').toUpperCase();
};

const safeStatus = (value: unknown): number | null => {
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric < 100 || numeric > 599) return null;
  return numeric;
};

const safeRequestId = (value: unknown): string | null => safeString(value, MAX_REQUEST_ID_LENGTH);

const extractHeaderRequestId = (headers: unknown): string | null => {
  if (!headers || typeof headers !== 'object') return null;
  const record = headers as Record<string, unknown>;
  return safeRequestId(
    record['x-request-id'] ??
    record['X-Request-Id'] ??
    record['request-id'] ??
    record['Request-Id'] ??
    null,
  );
};

const errorCandidate = (error: unknown): TransportErrorLike | null =>
  error && typeof error === 'object' ? error as TransportErrorLike : null;

const serverMessageFrom = (data: unknown): string | null => {
  if (!data || typeof data !== 'object') return null;
  const record = data as Record<string, unknown>;
  const message = safeString(record.message ?? record.Message, MAX_MESSAGE_LENGTH);
  return message;
};

export class AppError extends Error {
  readonly code: string;
  readonly status: number | null;
  readonly retryable: boolean;
  readonly requestId: string | null;
  readonly details: Readonly<Record<string, unknown>> | null;
  override readonly cause: unknown;

  constructor(message: string, options: AppErrorOptions = {}) {
    super(safeString(message, MAX_MESSAGE_LENGTH) ?? 'Application error');
    this.name = 'AppError';
    this.code = safeCode(options.code);
    this.status = safeStatus(options.status);
    this.retryable = options.retryable === true;
    this.requestId = safeRequestId(options.requestId);
    this.details = options.details ? Object.freeze({ ...options.details }) : null;
    this.cause = options.cause;
    Object.setPrototypeOf(this, new.target.prototype);
  }

  toJSON(): Readonly<Record<string, unknown>> {
    return Object.freeze({
      name: this.name,
      message: this.message,
      code: this.code,
      status: this.status,
      retryable: this.retryable,
      requestId: this.requestId,
      details: this.details,
    });
  }
}

export const isAbortError = (error: unknown): boolean => {
  const candidate = errorCandidate(error);
  if (!candidate) return false;
  const name = String(candidate.name ?? '');
  const code = String(candidate.code ?? '');
  const message = String(candidate.message ?? '');
  return name === 'AbortError' ||
    code === 'ERR_CANCELED' ||
    code === 'ABORTED' ||
    (code === 'ECONNABORTED' && /cancel|abort/i.test(message));
};

export const isTimeoutError = (error: unknown): boolean => {
  const candidate = errorCandidate(error);
  if (!candidate) return false;
  const code = String(candidate.code ?? '');
  const status = safeStatus(candidate.response?.status ?? candidate.status);
  return code === 'TIMEOUT' || code === 'ECONNABORTED' || status === 408 || status === 504;
};

export const isRateLimitError = (error: unknown): boolean => {
  const candidate = errorCandidate(error);
  if (!candidate) return false;
  return safeStatus(candidate.response?.status ?? candidate.status) === 429 || String(candidate.code ?? '') === 'RATE_LIMITED';
};

export const isRetryableStatus = (status: unknown): boolean => {
  const normalized = safeStatus(status);
  return normalized === 408 || normalized === 425 || normalized === 429 || normalized === 502 || normalized === 503 || normalized === 504;
};

export const normalizeTransportError = (error: unknown): AppError => {
  if (error instanceof AppError) return error;
  const candidate = errorCandidate(error);

  if (isAbortError(error)) {
    return new AppError('Request cancelled', {
      code: 'ABORTED',
      retryable: false,
      cause: error,
    });
  }

  const status = safeStatus(candidate?.response?.status ?? candidate?.status);
  const data = candidate?.response?.data;
  const serverMessage = serverMessageFrom(data);
  const requestId = safeRequestId(candidate?.requestId) ?? extractHeaderRequestId(candidate?.response?.headers);
  const code = String(candidate?.code ?? '');

  if (status === 400) return new AppError(serverMessage ?? 'İstek geçersiz.', { code: 'BAD_REQUEST', status, retryable: false, requestId, cause: error });
  if (status === 401) return new AppError('Oturum doğrulaması gerekli.', { code: 'UNAUTHORIZED', status, retryable: false, requestId, cause: error });
  if (status === 403) return new AppError('Bu işlem için yetkiniz yok.', { code: 'FORBIDDEN', status, retryable: false, requestId, cause: error });
  if (status === 404) return new AppError('İstenen kaynak bulunamadı.', { code: 'NOT_FOUND', status, retryable: false, requestId, cause: error });
  if (status === 409) return new AppError(serverMessage ?? 'İşlem mevcut durumla çakıştı.', { code: 'CONFLICT', status, retryable: false, requestId, cause: error });
  if (status === 412) return new AppError('Kaynak sürümü değişti. Lütfen yeniden deneyin.', { code: 'PRECONDITION_FAILED', status, retryable: true, requestId, cause: error });
  if (status === 413) return new AppError('İstek boyutu izin verilen sınırı aşıyor.', { code: 'PAYLOAD_TOO_LARGE', status, retryable: false, requestId, cause: error });
  if (status === 422) return new AppError(serverMessage ?? 'İstek doğrulaması başarısız oldu.', { code: 'VALIDATION_ERROR', status, retryable: false, requestId, cause: error });
  if (status === 425) return new AppError('İstek için henüz erken. Lütfen tekrar deneyin.', { code: 'TOO_EARLY', status, retryable: true, requestId, cause: error });
  if (status === 429) return new AppError('Çok fazla istek gönderildi. Lütfen tekrar deneyin.', { code: 'RATE_LIMITED', status, retryable: true, requestId, cause: error });
  if (status === 408 || code === 'ECONNABORTED') return new AppError('İstek zaman aşımına uğradı.', { code: 'TIMEOUT', status: status ?? 408, retryable: true, requestId, cause: error });
  if (status !== null && status >= 500) return new AppError('Sunucu geçici olarak kullanılamıyor.', { code: 'SERVER_ERROR', status, retryable: true, requestId, cause: error });
  if (status === null) return new AppError('Ağ bağlantısı kurulamadı.', { code: 'NETWORK_ERROR', retryable: true, requestId, cause: error });

  return new AppError(serverMessage ?? 'İstek tamamlanamadı.', {
    code: 'HTTP_ERROR',
    status,
    retryable: isRetryableStatus(status),
    requestId,
    cause: error,
  });
};

/** Backwards-compatible name while legacy business modules are migrated away from axios. */
export const normalizeAxiosError = normalizeTransportError;

export const getSafeErrorMessage = (error: unknown, fallback = 'Beklenmeyen bir hata oluştu.'): string => {
  if (error instanceof AppError) return error.message;
  return safeString(fallback, MAX_MESSAGE_LENGTH) ?? 'Beklenmeyen bir hata oluştu.';
};

export const getErrorCode = (error: unknown, fallback = 'UNKNOWN_ERROR'): string => {
  if (error instanceof AppError) return error.code;
  const candidate = errorCandidate(error);
  return safeCode(candidate?.code ?? fallback);
};

export const toAppError = (error: unknown, fallbackMessage = 'Beklenmeyen bir hata oluştu.'): AppError => {
  if (error instanceof AppError) return error;
  const normalized = normalizeTransportError(error);
  if (normalized.code !== 'NETWORK_ERROR' || errorCandidate(error)) return normalized;
  return new AppError(fallbackMessage, { code: 'APP_ERROR', retryable: false, cause: error });
};
