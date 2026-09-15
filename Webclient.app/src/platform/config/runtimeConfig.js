const DEFAULT_API_BASE_URL = '/api';
const DEFAULT_REQUEST_TIMEOUT_MS = 15000;
const DEFAULT_CACHE_TTL_MS = 30000;
const DEFAULT_MAX_RETRIES = 2;

const getProcessEnv = () => {
    if (typeof process === 'undefined' || !process.env) return {};
    return process.env;
};

const parseInteger = (value, fallback, min, max) => {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(Math.max(parsed, min), max);
};

const normalizeApiBaseUrl = (value) => {
    const candidate = String(value || DEFAULT_API_BASE_URL).trim();
    if (candidate.startsWith('/') && !candidate.startsWith('//')) {
        return candidate.replace(/\/$/, '') || '/';
    }

    try {
        const origin = typeof window !== 'undefined' ? window.location.origin : null;
        const parsed = new URL(candidate, origin || 'http://localhost');
        if (origin && parsed.origin === origin && !parsed.pathname.startsWith('//')) {
            return `${parsed.pathname}${parsed.search}`.replace(/\/$/, '') || '/';
        }
    } catch (error) {
        // Public configuration is untrusted; invalid values intentionally fall back.
    }
    return DEFAULT_API_BASE_URL;
};

export const createRuntimeConfig = (source = getProcessEnv()) => {
    const env = source || {};
    return Object.freeze({
        apiBaseUrl: normalizeApiBaseUrl(env.REACT_APP_API_URL || env.REACT_APP_API_BASE_URL),
        requestTimeoutMs: parseInteger(env.REACT_APP_API_TIMEOUT_MS, DEFAULT_REQUEST_TIMEOUT_MS, 1000, 60000),
        cacheTtlMs: parseInteger(env.REACT_APP_API_CACHE_TTL_MS, DEFAULT_CACHE_TTL_MS, 0, 600000),
        maxRetries: parseInteger(env.REACT_APP_API_MAX_RETRIES, DEFAULT_MAX_RETRIES, 0, 4),
        environment: String(env.REACT_APP_ENV || 'production').trim() || 'production',
        release: String(env.REACT_APP_VERSION || env.REACT_APP_RELEASE || 'local').trim() || 'local',
        telemetryEnabled: String(env.REACT_APP_ENABLE_TELEMETRY || 'false').toLowerCase() === 'true',
        esriApiVersion: String(env.REACT_APP_ESRI_API_VERSION || '').trim(),
        tkgmCityId: String(env.REACT_APP_TKGM_CITY_ID || '').trim()
    });
};

export const runtimeConfig = createRuntimeConfig();

export const assertSafeRuntimeConfig = (config = runtimeConfig) => {
    if (!config.apiBaseUrl.startsWith('/') || config.apiBaseUrl.startsWith('//')) {
        throw new Error('API base URL must resolve to a same-origin relative path');
    }
    if (config.requestTimeoutMs < 1000 || config.requestTimeoutMs > 60000) {
        throw new Error('API timeout is outside the supported range');
    }
    if (config.maxRetries < 0 || config.maxRetries > 4) {
        throw new Error('API retry count is outside the supported range');
    }
    return true;
};

assertSafeRuntimeConfig();
