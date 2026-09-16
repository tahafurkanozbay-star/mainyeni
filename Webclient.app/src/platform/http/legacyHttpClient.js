const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

const normalizeHeaders = input => {
  if (!input || typeof input !== 'object') return {};
  if (typeof Headers !== 'undefined' && input instanceof Headers) {
    return Object.fromEntries(input.entries());
  }
  return Object.entries(input).reduce((headers, [key, value]) => {
    if (value !== null && value !== undefined) headers[key] = String(value);
    return headers;
  }, {});
};

const hasHeader = (headers, name) => Object.keys(headers)
  .some(key => key.toLowerCase() === name.toLowerCase());

const appendQuery = (url, params) => {
  if (!params || typeof params !== 'object') return url;
  const pairs = Object.entries(params).reduce((entries, [key, value]) => {
    if (value === null || value === undefined) return entries;
    const values = Array.isArray(value) ? value : [value];
    values.reduce((output, item) => {
      if (item !== null && item !== undefined) {
        output.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(item))}`);
      }
      return output;
    }, entries);
    return entries;
  }, []);
  if (pairs.length === 0) return url;
  const hashIndex = url.indexOf('#');
  const hash = hashIndex >= 0 ? url.slice(hashIndex) : '';
  const base = hashIndex >= 0 ? url.slice(0, hashIndex) : url;
  return `${base}${base.includes('?') ? '&' : '?'}${pairs.join('&')}${hash}`;
};

const parsePayload = async response => {
  if (response.status === 204 || response.status === 205) return null;
  const text = await response.text();
  if (!text) return '';
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

const normalizeBody = (data, headers) => {
  if (data === null || data === undefined) return undefined;
  if (typeof FormData !== 'undefined' && data instanceof FormData) return data;
  if (typeof URLSearchParams !== 'undefined' && data instanceof URLSearchParams) return data;
  if (typeof Blob !== 'undefined' && data instanceof Blob) return data;
  if (typeof data === 'string' || data instanceof ArrayBuffer) return data;
  if (!hasHeader(headers, 'content-type')) headers['Content-Type'] = 'application/json';
  return JSON.stringify(data);
};

export const legacyHttpClient = async config => {
  if (!config || typeof config !== 'object') throw new TypeError('HTTP request config is required.');
  const rawUrl = hasOwn(config, 'url') ? config.url : '';
  const url = typeof rawUrl === 'string' ? rawUrl.trim() : '';
  if (!url) throw new TypeError('HTTP request URL is required.');

  const method = String(config.method || 'get').trim().toUpperCase();
  const headers = normalizeHeaders(config.headers);
  const body = method === 'GET' || method === 'HEAD' ? undefined : normalizeBody(config.data, headers);
  const response = await fetch(appendQuery(url, config.params), {
    method,
    headers,
    body,
    signal: config.signal,
    credentials: config.credentials || 'same-origin',
    referrerPolicy: config.referrerPolicy,
  });
  const data = await parsePayload(response);
  const result = Object.freeze({
    data,
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
    config,
  });
  if (!response.ok) {
    const error = new Error(`HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''}`);
    error.response = result;
    throw error;
  }
  return result;
};

legacyHttpClient.get = (url, config = {}) => legacyHttpClient({ ...config, method: 'get', url });
legacyHttpClient.post = (url, data, config = {}) => legacyHttpClient({ ...config, method: 'post', url, data });
legacyHttpClient.put = (url, data, config = {}) => legacyHttpClient({ ...config, method: 'put', url, data });
legacyHttpClient.patch = (url, data, config = {}) => legacyHttpClient({ ...config, method: 'patch', url, data });
legacyHttpClient.delete = (url, config = {}) => legacyHttpClient({ ...config, method: 'delete', url });

export default legacyHttpClient;
