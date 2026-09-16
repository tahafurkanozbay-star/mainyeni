/** Shared application error contract that avoids exposing raw server/network internals to UI surfaces. */
export class AppError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'AppError';
    this.code = details.code || 'APP_ERROR';
    this.status = details.status ?? null;
    this.retryable = details.retryable === true;
    this.requestId = details.requestId || null;
    this.details = details.details || null;
    this.cause = details.cause;
  }
}

export const isAbortError = (error) =>
  error?.name === 'AbortError' ||
  error?.code === 'ERR_CANCELED' ||
  error?.code === 'ABORTED' ||
  (error?.code === 'ECONNABORTED' && /cancel/i.test(error?.message || ''));

const statusOf = (error) => {
  const candidates = [error?.status, error?.response?.status];
  for (const candidate of candidates) {
    const numeric = Number(candidate);
    if (Number.isInteger(numeric) && numeric >= 100 && numeric <= 599) return numeric;
  }
  return null;
};

const safeServerMessage = (data) => {
  const candidate = typeof data?.message === 'string'
    ? data.message
    : typeof data?.detail === 'string'
      ? data.detail
      : null;
  if (!candidate) return null;

  const normalized = candidate.replace(/[\r\n\t]+/g, ' ').trim();
  if (!normalized || normalized.length > 240) return null;
  return normalized;
};

export const normalizeHttpError = (error) => {
  if (error instanceof AppError) return error;
  if (isAbortError(error)) {
    return new AppError('Request cancelled', {
      code: 'ABORTED',
      retryable: false,
      cause: error
    });
  }

  const status = statusOf(error);
  const data = error?.response?.data;
  const serverMessage = safeServerMessage(data);
  const errorCode = String(error?.code || '').toUpperCase();

  if (status === 401) {
    return new AppError('Oturum doğrulaması gerekli.', {
      code: 'UNAUTHORIZED', status, retryable: false, cause: error
    });
  }
  if (status === 403) {
    return new AppError('Bu işlem için yetkiniz yok.', {
      code: 'FORBIDDEN', status, retryable: false, cause: error
    });
  }
  if (status === 404) {
    return new AppError('İstenen kaynak bulunamadı.', {
      code: 'NOT_FOUND', status, retryable: false, cause: error
    });
  }
  if (status === 408 || errorCode === 'ECONNABORTED' || errorCode === 'ETIMEDOUT') {
    return new AppError('İstek zaman aşımına uğradı.', {
      code: 'TIMEOUT', status: status || 408, retryable: true, cause: error
    });
  }
  if (status === 409) {
    return new AppError(serverMessage || 'İstek mevcut durumla çakışıyor.', {
      code: 'CONFLICT', status, retryable: false, cause: error
    });
  }
  if (status === 422) {
    return new AppError(serverMessage || 'Gönderilen veri doğrulanamadı.', {
      code: 'VALIDATION_ERROR', status, retryable: false, cause: error
    });
  }
  if (status === 429) {
    return new AppError('Çok fazla istek gönderildi. Lütfen tekrar deneyin.', {
      code: 'RATE_LIMITED', status, retryable: true, cause: error
    });
  }
  if (status >= 500) {
    return new AppError('Sunucu geçici olarak kullanılamıyor.', {
      code: 'SERVER_ERROR', status, retryable: true, cause: error
    });
  }
  if (!status) {
    return new AppError('Ağ bağlantısı kurulamadı.', {
      code: 'NETWORK_ERROR', retryable: true, cause: error
    });
  }

  return new AppError(serverMessage || 'İstek tamamlanamadı.', {
    code: 'HTTP_ERROR',
    status,
    retryable: false,
    cause: error
  });
};

// Compatibility export for modules migrated in separate feature PRs. New platform code should use
// normalizeHttpError; retaining this alias lets the transport migration remain feature-by-feature.
export const normalizeAxiosError = normalizeHttpError;

export const getSafeErrorMessage = (error, fallback = 'Beklenmeyen bir hata oluştu.') => {
  if (error instanceof AppError) return error.message;
  return fallback;
};
