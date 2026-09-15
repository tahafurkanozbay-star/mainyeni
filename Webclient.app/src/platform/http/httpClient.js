import axios from 'axios';
import { runtimeConfig } from '../config/runtimeConfig';
import { RequestCache } from '../cache/requestCache';
import { normalizeAxiosError, isAbortError } from '../errors/appError';

const SAFE_METHODS = new Set(['get', 'head']);
const defaultCache = new RequestCache({ ttlMs: runtimeConfig.cacheTtlMs, maxEntries: 150 });
const inFlight = new Map();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const joinUrl = (baseUrl, path) => {
    if (/^https?:\/\//i.test(path)) return path;
    const base = String(baseUrl || '/api').replace(/\/$/, '');
    const suffix = String(path || '').replace(/^\//, '');
    return `${base}/${suffix}`;
};

const stableSerialize = (value) => {
    if (value === undefined) return '';
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`;
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`).join(',')}}`;
};

const cacheKey = (config) => [
    String(config.method || 'get').toLowerCase(),
    config.url,
    stableSerialize(config.params)
].join('|');

const isRetryable = (error) => {
    if (isAbortError(error)) return false;
    const status = error?.response?.status;
    return !status || status === 408 || status === 429 || status >= 500;
};

const retryDelay = (attempt) => Math.min(250 * 2 ** attempt, 2000) + Math.round(Math.random() * 100);

const createApiClient = () => {
    const instance = axios.create({
        baseURL: runtimeConfig.apiBaseUrl,
        timeout: runtimeConfig.requestTimeoutMs,
        headers: {
            Accept: 'application/json'
        },
        withCredentials: true
    });

    const request = async (config = {}) => {
        const method = String(config.method || 'get').toLowerCase();
        const merged = {
            ...config,
            method,
            url: joinUrl('', config.url || ''),
            timeout: config.timeout ?? runtimeConfig.requestTimeoutMs
        };
        const key = cacheKey(merged);
        const useCache = SAFE_METHODS.has(method) && config.cache !== false;
        const dedupe = SAFE_METHODS.has(method) && config.dedupe !== false;

        if (useCache) {
            const cached = defaultCache.get(key);
            if (cached !== undefined) return cached;
        }

        if (dedupe && inFlight.has(key)) {
            return inFlight.get(key);
        }

        const execute = async () => {
            let attempt = 0;
            while (true) {
                try {
                    const response = await instance.request(merged);
                    const data = response?.data;
                    if (useCache && response.status >= 200 && response.status < 300) {
                        defaultCache.set(key, data, config.cacheTtlMs ?? runtimeConfig.cacheTtlMs);
                    }
                    return data;
                } catch (error) {
                    const normalized = normalizeAxiosError(error);
                    if (attempt >= (config.maxRetries ?? runtimeConfig.maxRetries) || !isRetryable(error)) {
                        throw normalized;
                    }
                    await sleep(retryDelay(attempt));
                    attempt += 1;
                }
            }
        };

        const promise = execute().finally(() => inFlight.delete(key));
        if (dedupe) inFlight.set(key, promise);
        return promise;
    };

    return {
        get: (url, config = {}) => request({ ...config, url, method: 'get' }),
        head: (url, config = {}) => request({ ...config, url, method: 'head' }),
        post: (url, data, config = {}) => request({ ...config, url, data, method: 'post', cache: false, dedupe: false }),
        put: (url, data, config = {}) => request({ ...config, url, data, method: 'put', cache: false, dedupe: false }),
        patch: (url, data, config = {}) => request({ ...config, url, data, method: 'patch', cache: false, dedupe: false }),
        delete: (url, config = {}) => request({ ...config, url, method: 'delete', cache: false, dedupe: false }),
        request,
        clearCache: () => defaultCache.clear(),
        invalidateCache: (prefix) => defaultCache.invalidatePrefix(prefix),
        getCacheSize: () => defaultCache.size()
    };
};

export const apiClient = createApiClient();

export { SAFE_METHODS, stableSerialize };
