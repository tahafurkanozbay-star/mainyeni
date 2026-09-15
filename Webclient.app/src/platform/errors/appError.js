/** Normalized application error model for UI, logs and telemetry boundaries. */

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
    error?.name === 'AbortError' || error?.code === 'ERR_CANCELED' || error?.code === 'ABORTED';

export const normalizeAxiosError = (error) => {
    if (isAbortError(error)) {
        return new AppError('Request cancelled', { code: 'ABORTED', retryable: false, cause: error });
    }

    const status = error?.response?.status ?? error?.status ?? null;
    const data = error?.response?.data;
    const serverMessage = typeof data?.message === 'string' ? data.message : null;

    if (status === 401) return new AppError('Oturum doğrulaması gerekli.', { code: 'UNAUTHORIZED', status, retryable: false, cause: error });
    if (status === 403) return new AppError('Bu işlem için yetkiniz yok.', { code: 'FORBIDDEN', status, retryable: false, cause: error });
    if (status === 404) return new AppError('İstenen kaynak bulunamadı.', { code: 'NOT_FOUND', status, retryable: false, cause: error });
    if (status === 408) return new AppError('İstek zaman aşımına uğradı.', { code: 'TIMEOUT', status, retryable: true, cause: error });
    if (status === 429) return new AppError('Çok fazla istek gönderildi. Lütfen tekrar deneyin.', { code: 'RATE_LIMITED', status, retryable: true, cause: error });
    if (status >= 500) return new AppError('Sunucu geçici olarak kullanılamıyor.', { code: 'SERVER_ERROR', status, retryable: true, cause: error });
    if (!status) return new AppError('Ağ bağlantısı kurulamadı.', { code: 'NETWORK_ERROR', retryable: true, cause: error });

    return new AppError(serverMessage || 'İstek tamamlanamadı.', {
        code: 'HTTP_ERROR',
        status,
        retryable: false,
        cause: error
    });
};

export const getSafeErrorMessage = (error, fallback = 'Beklenmeyen bir hata oluştu.') => {
    if (error instanceof AppError) return error.message;
    if (typeof error?.message === 'string' && error.message.length < 240) return error.message;
    return fallback;
};
