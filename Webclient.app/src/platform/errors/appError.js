export const ERROR_CODES = Object.freeze({
  CONFIGURATION: 'CONFIGURATION_ERROR',
  VALIDATION: 'VALIDATION_ERROR',
  NETWORK: 'NETWORK_ERROR',
  TIMEOUT: 'TIMEOUT',
  ABORTED: 'REQUEST_ABORTED',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  RATE_LIMITED: 'RATE_LIMITED',
  SERVER: 'SERVER_ERROR',
  PARSE: 'RESPONSE_PARSE_ERROR',
  UNKNOWN: 'UNKNOWN_ERROR',
});

const statusToCode = (status) => {
  if (status === 401) return ERROR_CODES.UNAUTHORIZED;
  if (status === 403) return ERROR_CODES.FORBIDDEN;
  if (status === 404) return ERROR_CODES.NOT_FOUND;
  if (status === 408) return ERROR_CODES.TIMEOUT;
  if (status === 429) return ERROR_CODES.RATE_LIMITED;
  if (status >= 500) return ERROR_CODES.SERVER;
  return ERROR_CODES.UNKNOWN;
};

const messageForCode = (code) => ({
  [ERROR_CODES.CONFIGURATION]: 'Uygulama yapılandırması kullanılamıyor.',
  [ERROR_CODES.VALIDATION]: 'İstek doğrulanamadı.',
  [ERROR_CODES.NETWORK]: 'Sunucuya ulaşılamadı.',
  [ERROR_CODES.TIMEOUT]: 'İstek zaman aşımına uğradı.',
  [ERROR_CODES.ABORTED]: 'İstek iptal edildi.',
  [ERROR_CODES.UNAUTHORIZED]: 'Bu işlem için oturum gerekli.',
  [ERROR_CODES.FORBIDDEN]: 'Bu işlem için yetkiniz yok.',
  [ERROR_CODES.NOT_FOUND]: 'İstenen kaynak bulunamadı.',
  [ERROR_CODES.RATE_LIMITED]: 'Çok fazla istek gönderildi. Lütfen tekrar deneyin.',
  [ERROR_CODES.SERVER]: 'Sunucu geçici olarak kullanılamıyor.',
  [ERROR_CODES.PARSE]: 'Sunucudan beklenmeyen veri alındı.',
  [ERROR_CODES.UNKNOWN]: 'Beklenmeyen bir hata oluştu.',
});

export class AppError extends Error {
  constructor(message, details = {}) {
    super(message || messageForCode(details.code || ERROR_CODES.UNKNOWN));
    this.name = 'AppError';
    this.code = details.code || ERROR_CODES.UNKNOWN;
    this.status = details.status;
    this.requestId = details.requestId || null;
    this.endpoint = details.endpoint || null;
    this.retryable = Boolean(details.retryable);
    this.cause = details.cause;
    this.details = details.details || null;
  }

  toJSON() {
    return {
      name: this.name,
      code: this.code,
      status: this.status,
      requestId: this.requestId,
      endpoint: this.endpoint,
      retryable: this.retryable,
      message: this.message,
    };
  }
}

const isAbortError = (error) => error?.name === 'AbortError' || error?.code === 'ABORT_ERR';

const isTimeoutError = (error) => error?.name === 'TimeoutError' || error?.code === 'ETIMEDOUT';

export const normalizeError = (error, context = {}) => {
  if (error instanceof AppError) return error;
  if (isAbortError(error)) {
    return new AppError(messageForCode(ERROR_CODES.ABORTED), {
      ...context,
      code: ERROR_CODES.ABORTED,
      retryable: false,
      cause: error,
    });
  }
  if (isTimeoutError(error)) {
    return new AppError(messageForCode(ERROR_CODES.TIMEOUT), {
      ...context,
      code: ERROR_CODES.TIMEOUT,
      retryable: true,
      cause: error,
    });
  }

  const status = error?.status || error?.response?.status;
  const code = status ? statusToCode(status) : ERROR_CODES.NETWORK;
  return new AppError(messageForCode(code), {
    ...context,
    code,
    status,
    retryable: code === ERROR_CODES.NETWORK || code === ERROR_CODES.TIMEOUT || code === ERROR_CODES.RATE_LIMITED || code === ERROR_CODES.SERVER,
    requestId: error?.requestId || error?.response?.headers?.get?.('x-request-id') || null,
    cause: error,
  });
};

export const toUserMessage = (error) => {
  if (error instanceof AppError) return error.message;
  return messageForCode(ERROR_CODES.UNKNOWN);
};
