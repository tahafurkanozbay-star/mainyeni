import { loadModules } from 'esri-loader';
import { CommonBusiness } from '../Business/CommonBusiness';
import { assertBrowserGisEndpoint } from './networkPolicy';

const MAX_CACHE_ENTRIES = 80;
const DEFAULT_TTL_MS = 15000;
const modulePromises = new Map();
const responseCache = new Map();
const inFlight = new Map();

const load = (name) => {
  if (!modulePromises.has(name)) modulePromises.set(name, loadModules([name]).then((modules) => modules[0]));
  return modulePromises.get(name);
};

const stable = (value) => {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
};
const now = () => Date.now();
const cacheSet = (key, value, ttl) => {
  responseCache.delete(key);
  responseCache.set(key, { value, expiresAt: now() + ttl });
  while (responseCache.size > MAX_CACHE_ENTRIES) responseCache.delete(responseCache.keys().next().value);
};
const cacheGet = (key) => {
  const hit = responseCache.get(key);
  if (!hit) return null;
  if (hit.expiresAt <= now()) { responseCache.delete(key); return null; }
  responseCache.delete(key); responseCache.set(key, hit); return hit.value;
};
const cancelError = () => Object.assign(new Error('GIS query cancelled.'), { code: 'CANCELLED' });
const throwIfAborted = (signal) => { if (signal?.aborted) throw cancelError(); };
const raceCancellation = (promise, signal) => {
  if (!signal) return promise;
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const onAbort = () => { signal.removeEventListener('abort', onAbort); reject(cancelError()); };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then((value) => { signal.removeEventListener('abort', onAbort); resolve(value); }, (error) => { signal.removeEventListener('abort', onAbort); reject(error); });
  });
};
const resolveUrl = (service, options = {}) => assertBrowserGisEndpoint(CommonBusiness.GenerateUrl(service) || service?.url || service, options);
const normalizeQuery = (input = {}) => ({
  where: input.where || '1=1',
  outFields: Array.isArray(input.outFields) && input.outFields.length ? input.outFields.slice().sort() : ['*'],
  returnGeometry: input.returnGeometry === true,
  returnDistinctValues: input.returnDistinctValues === true,
  orderByFields: Array.isArray(input.orderByFields) ? input.orderByFields.slice() : undefined,
  resultOffset: Number.isInteger(input.resultOffset) && input.resultOffset >= 0 ? input.resultOffset : undefined,
  resultRecordCount: Number.isInteger(input.resultRecordCount) && input.resultRecordCount > 0 ? Math.min(input.resultRecordCount, 2000) : undefined,
  geometry: input.geometry || null,
  outSpatialReference: input.outSpatialReference || undefined,
  timeExtent: input.timeExtent || undefined,
  distance: Number.isFinite(input.distance) ? input.distance : undefined,
  units: input.units || undefined,
});
export const createQueryKey = (service, query) => stable({ url: CommonBusiness.GenerateUrl(service) || service?.url || service, query: normalizeQuery(query) });
export const clearQueryCache = (prefix = null) => {
  if (!prefix) { responseCache.clear(); return; }
  for (const key of responseCache.keys()) if (key.startsWith(prefix)) responseCache.delete(key);
};
export const executeFeatureQuery = async (service, input = {}, options = {}) => {
  const url = resolveUrl(service, options);
  const query = normalizeQuery(input);
  if (!url) throw new Error('A GIS service URL is required.');
  const key = createQueryKey(service, query);
  const cacheable = options.cache !== false && !options.live;
  const ttl = Number.isFinite(options.ttlMs) ? Math.max(0, options.ttlMs) : DEFAULT_TTL_MS;
  const cached = cacheable ? cacheGet(key) : null;
  if (cached) return cached;
  throwIfAborted(options.signal);
  if (inFlight.has(key)) return raceCancellation(inFlight.get(key), options.signal);

  const work = (async () => {
    const [QueryTask, Query] = await Promise.all([load('esri/tasks/QueryTask'), load('esri/tasks/support/Query')]);
    throwIfAborted(options.signal);
    const task = new QueryTask({ url });
    const request = new Query();
    Object.keys(query).forEach((property) => {
      if (query[property] !== undefined && query[property] !== null) request[property] = query[property];
    });
    if (request.outFields?.length > 100) request.outFields = request.outFields.slice(0, 100);
    const execution = task.execute(request, options.signal ? { signal: options.signal } : undefined);
    const response = await raceCancellation(Promise.resolve(execution), options.signal);
    const normalized = { features: response?.features || [], fields: response?.fields || [], exceededTransferLimit: Boolean(response?.exceededTransferLimit), geometryType: response?.geometryType || null, spatialReference: response?.spatialReference || null };
    if (cacheable && ttl > 0 && !normalized.exceededTransferLimit) cacheSet(key, normalized, ttl);
    return normalized;
  })();
  inFlight.set(key, work);
  try { return await raceCancellation(work, options.signal); }
  finally { if (inFlight.get(key) === work) inFlight.delete(key); }
};
export const executeFeatureCount = async (service, input = {}, options = {}) => {
  const result = await executeFeatureQuery(service, { ...input, returnGeometry: false, outFields: ['OBJECTID'], resultRecordCount: 1 }, options);
  return result?.features?.length || 0;
};
export const invalidateServiceQueries = (service) => {
  const url = String(CommonBusiness.GenerateUrl(service) || service?.url || service || '');
  if (!url) return;
  for (const key of responseCache.keys()) if (key.includes(url)) responseCache.delete(key);
};
export const getQueryCacheStats = () => ({ entries: responseCache.size, inFlight: inFlight.size, maxEntries: MAX_CACHE_ENTRIES });
