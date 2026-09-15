import axios from 'axios';
import { runtimeConfig } from '../config/runtimeConfig';
import { RequestCache } from '../cache/requestCache';
import { normalizeAxiosError, isAbortError } from '../errors/appError';
import { normalizeApplicationPath } from '../network/endpointPolicy';

const SAFE_METHODS = new Set(['get', 'head']);
const defaultCache = new RequestCache({ ttlMs: runtimeConfig.cacheTtlMs, maxEntries: 150 });
const inFlight = new Map();
const client = axios.create({
    baseURL: runtimeConfig.apiBaseUrl,
    timeout: runtimeConfig.requestTimeoutMs,
    headers: { Accept: 'application/json' },
    withCredentials: true
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const stableSerialize = (value) => {
    if (value === undefined) return '';
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`;
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`).join(',')}}`;
};
const cacheKey = (config) => [String(config.method || 'get').toLowerCase(), config.url, stableSerialize(config.params)].join('|');
const isRetryable = (error) => {
    if (isAbortError(error)) return false;
    const status = error?.response?.status;
    return !status || status === 408 || status === 429 || status >= 500;
};
const retryDelay = (attempt) => Math.min(250 * 2 ** attempt, 2000) + Math.round(Math.random() * 100);

const createCancelToken = (signal) => {
    if (!signal) return { token: undefined, cleanup: () => {} };
    const source = axios.CancelToken.source();
    const abort = () => source.cancel('Request cancelled');
    if (signal.aborted) abort();
    signal.addEventListener('abort', abort, { once: true });
    return { token: source.token, cleanup: () => signal.removeEventListener('abort', abort) };
};

const request = async (config = {}) => {
    const method = String(config.method || 'get').toLowerCase();
    const url = normalizeApplicationPath(config.url || '/');
    const merged = { ...config, method, url, timeout: config.timeout ?? runtimeConfig.requestTimeoutMs };
    const cacheable = SAFE_METHODS.has(method) && config.cache === true;
    const dedupe = SAFE_METHODS.has(method) && config.dedupe === true;
    const key = cacheKey(merged);

    if (cacheable) {
        const cached = defaultCache.get(key);
        if (cached !== undefined) return cached;
    }
    if (dedupe && inFlight.has(key)) return inFlight.get(key);

    const execute = async () => {
        const cancel = createCancelToken(config.signal);
        let attempt = 0;
        try {
            while (true) {
                try {
                    const response = await client.request({ ...merged, cancelToken: cancel.token });
                    if (cacheable && response.status >= 200 && response.status < 300) {
                        defaultCache.set(key, response.data, config.cacheTtlMs ?? runtimeConfig.cacheTtlMs);
                    }
                    return response.data;
                } catch (error) {
                    const normalized = normalizeAxiosError(error);
                    if (attempt >= (config.maxRetries ?? runtimeConfig.maxRetries) || !isRetryable(error)) throw normalized;
                    await sleep(retryDelay(attempt));
                    attempt += 1;
                }
            }
        } finally {
            cancel.cleanup();
        }
    };

    const promise = execute().finally(() => inFlight.delete(key));
    if (dedupe) inFlight.set(key, promise);
    return promise;
};

export const apiClient = {
    request,
    get: (url, config = {}) => request({ ...config, url, method: 'get' }),
    head: (url, config = {}) => request({ ...config, url, method: 'head' }),
    post: (url, data, config = {}) => request({ ...config, url, data, method: 'post', cache: false, dedupe: false }),
    put: (url, data, config = {}) => request({ ...config, url, data, method: 'put', cache: false, dedupe: false }),
    patch: (url, data, config = {}) => request({ ...config, url, data, method: 'patch', cache: false, dedupe: false }),
    delete: (url, config = {}) => request({ ...config, url, method: 'delete', cache: false, dedupe: false }),
    clearCache: () => defaultCache.clear(),
    invalidateCache: (prefix) => defaultCache.invalidatePrefix(prefix),
    getCacheSize: () => defaultCache.size()
};

export { SAFE_METHODS, stableSerialize };
