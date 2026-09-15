import { AppError } from '../errors/appError';

/**
 * Browser network boundary. Application API traffic should stay same-origin.
 * ArcGIS layer traffic is managed by the GIS engine and is intentionally not
 * routed through this generic application client.
 */

export const isSameOriginPath = (value) =>
    typeof value === 'string' && value.trim().startsWith('/');

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
    const path = String(value || '').trim();
    if (!path) return '/';
    return assertApplicationEndpoint(path.replace(/\/{2,}/g, '/'));
};
