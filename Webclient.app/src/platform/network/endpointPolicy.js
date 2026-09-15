import { AppError } from '../errors/appError';

export const isSameOriginPath = (value) =>
    typeof value === 'string' && value.trim().startsWith('/') && !value.trim().startsWith('//');

export const assertApplicationEndpoint = (value) => {
    if (!isSameOriginPath(value)) {
        throw new AppError('Cross-origin application endpoint is blocked.', {
            code: 'CROSS_ORIGIN_BLOCKED',
            retryable: false
        });
    }
    return value;
};

export const normalizeApplicationPath = (value) => {
    const raw = String(value || '').trim();
    if (!raw) return '/';
    if (/^[a-z][a-z\d+.-]*:/i.test(raw) || raw.startsWith('//')) return assertApplicationEndpoint(raw);
    const path = `/${raw.replace(/^\/+/, '')}`.replace(/\/{2,}/g, '/');
    return assertApplicationEndpoint(path);
};
