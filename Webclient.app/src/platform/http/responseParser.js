import { AppError } from '../errors/appError';

const JSON_CONTENT_TYPES = [
  'application/json',
  'application/problem+json',
  'application/geo+json'
];

const TEXT_CONTENT_TYPES = [
  'text/',
  'application/xml',
  'application/xhtml+xml',
  'application/javascript',
  'application/x-www-form-urlencoded'
];

const MAX_SAFE_ERROR_MESSAGE_LENGTH = 240;
const MAX_HEADER_VALUE_LENGTH = 512;

const normalizeContentType = (value) =>
  String(value || '').split(';')[0].trim().toLowerCase();

export const isJsonContentType = (value) => {
  const normalized = normalizeContentType(value);
  return JSON_CONTENT_TYPES.includes(normalized) || normalized.endsWith('+json');
};

export const isTextContentType = (value) => {
  const normalized = normalizeContentType(value);
  return TEXT_CONTENT_TYPES.some((candidate) => normalized.startsWith(candidate));
};

const readHeader = (headers, name) => {
  if (!headers) return null;
  if (typeof headers.get === 'function') return headers.get(name);
  const target = String(name).toLowerCase();
  const key = Object.keys(headers).find((item) => item.toLowerCase() === target);
  return key ? headers[key] : null;
};

export const headersToObject = (headers) => {
  if (!headers) return Object.freeze({});

  const result = {};
  if (typeof headers.forEach === 'function') {
    headers.forEach((value, key) => {
      result[String(key).toLowerCase()] = String(value).slice(0, MAX_HEADER_VALUE_LENGTH);
    });
  } else {
    Object.keys(headers).forEach((key) => {
      result[String(key).toLowerCase()] = String(headers[key]).slice(0, MAX_HEADER_VALUE_LENGTH);
    });
  }

  return Object.freeze(result);
};

export const getContentType = (response) =>
  normalizeContentType(readHeader(response?.headers, 'content-type'));

export const hasNoResponseBody = (response, method = 'get') => {
  const status = Number(response?.status);
  const normalizedMethod = String(method || 'get').toLowerCase();

  if (normalizedMethod === 'head') return true;
  if (status === 204 || status === 205 || status === 304) return true;

  const contentLength = readHeader(response?.headers, 'content-length');
  if (contentLength !== null && Number(contentLength) === 0) return true;

  return false;
};

const safeText = async (response) => {
  if (!response || typeof response.text !== 'function') return '';
  const value = await response.text();
  return typeof value === 'string' ? value : String(value ?? '');
};

const parseJsonText = (text, options = {}) => {
  if (!text || !text.trim()) return null;

  try {
    return JSON.parse(text);
  } catch (error) {
    if (options.allowInvalidJson === true) return text;
    throw new AppError('Sunucu geçersiz JSON yanıtı döndürdü.', {
      code: 'INVALID_JSON_RESPONSE',
      status: options.status ?? null,
      retryable: false,
      cause: error
    });
  }
};

export const parseResponseBody = async (response, options = {}) => {
  const method = options.method || 'get';
  if (hasNoResponseBody(response, method)) return null;

  const responseType = String(options.responseType || 'auto').toLowerCase();
  if (responseType === 'response') return response;
  if (responseType === 'blob') {
    if (typeof response?.blob !== 'function') {
      throw new AppError('Binary response is not supported by this runtime.', {
        code: 'UNSUPPORTED_RESPONSE_TYPE',
        status: response?.status ?? null
      });
    }
    return response.blob();
  }
  if (responseType === 'arraybuffer') {
    if (typeof response?.arrayBuffer !== 'function') {
      throw new AppError('ArrayBuffer response is not supported by this runtime.', {
        code: 'UNSUPPORTED_RESPONSE_TYPE',
        status: response?.status ?? null
      });
    }
    return response.arrayBuffer();
  }

  const text = await safeText(response);
  if (responseType === 'text') return text;
  if (responseType === 'json') {
    return parseJsonText(text, {
      status: response?.status,
      allowInvalidJson: options.allowInvalidJson
    });
  }

  const contentType = getContentType(response);
  if (isJsonContentType(contentType)) {
    return parseJsonText(text, {
      status: response?.status,
      allowInvalidJson: options.allowInvalidJson
    });
  }

  if (isTextContentType(contentType)) return text;

  if (!text.trim()) return null;

  const trimmed = text.trim();
  if ((trimmed.startsWith('{') && trimmed.endsWith('}')) ||
      (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
    return parseJsonText(text, {
      status: response?.status,
      allowInvalidJson: true
    });
  }

  return text;
};

const extractProblemMessage = (body) => {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;

  const candidates = [
    body.message,
    body.detail,
    body.title,
    body.error_description,
    body.error
  ];

  const selected = candidates.find((value) =>
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.trim().length <= MAX_SAFE_ERROR_MESSAGE_LENGTH);

  return selected ? selected.trim() : null;
};

export const mapHttpStatusToError = (status, body, options = {}) => {
  const numericStatus = Number(status) || null;
  const requestId = options.requestId || null;
  const cause = options.cause;
  const safeServerMessage = extractProblemMessage(body);

  if (numericStatus === 400) {
    return new AppError(safeServerMessage || 'İstek geçersiz.', {
      code: 'BAD_REQUEST', status: numericStatus, retryable: false, requestId, cause
    });
  }
  if (numericStatus === 401) {
    return new AppError('Oturum doğrulaması gerekli.', {
      code: 'UNAUTHORIZED', status: numericStatus, retryable: false, requestId, cause
    });
  }
  if (numericStatus === 403) {
    return new AppError('Bu işlem için yetkiniz yok.', {
      code: 'FORBIDDEN', status: numericStatus, retryable: false, requestId, cause
    });
  }
  if (numericStatus === 404) {
    return new AppError('İstenen kaynak bulunamadı.', {
      code: 'NOT_FOUND', status: numericStatus, retryable: false, requestId, cause
    });
  }
  if (numericStatus === 408) {
    return new AppError('İstek zaman aşımına uğradı.', {
      code: 'TIMEOUT', status: numericStatus, retryable: true, requestId, cause
    });
  }
  if (numericStatus === 409) {
    return new AppError(safeServerMessage || 'İstek mevcut durumla çakışıyor.', {
      code: 'CONFLICT', status: numericStatus, retryable: false, requestId, cause
    });
  }
  if (numericStatus === 412) {
    return new AppError(safeServerMessage || 'İstek önkoşulu karşılanmadı.', {
      code: 'PRECONDITION_FAILED', status: numericStatus, retryable: false, requestId, cause
    });
  }
  if (numericStatus === 413) {
    return new AppError('İstek gövdesi izin verilen boyutu aşıyor.', {
      code: 'PAYLOAD_TOO_LARGE', status: numericStatus, retryable: false, requestId, cause
    });
  }
  if (numericStatus === 422) {
    return new AppError(safeServerMessage || 'İstek doğrulaması başarısız oldu.', {
      code: 'VALIDATION_FAILED', status: numericStatus, retryable: false, requestId, cause
    });
  }
  if (numericStatus === 425) {
    return new AppError('İstek geçici olarak işlenemiyor.', {
      code: 'TOO_EARLY', status: numericStatus, retryable: true, requestId, cause
    });
  }
  if (numericStatus === 429) {
    return new AppError('Çok fazla istek gönderildi. Lütfen tekrar deneyin.', {
      code: 'RATE_LIMITED', status: numericStatus, retryable: true, requestId, cause
    });
  }
  if (numericStatus && numericStatus >= 500) {
    return new AppError('Sunucu geçici olarak kullanılamıyor.', {
      code: 'SERVER_ERROR', status: numericStatus, retryable: true, requestId, cause
    });
  }

  return new AppError(safeServerMessage || 'İstek tamamlanamadı.', {
    code: 'HTTP_ERROR', status: numericStatus, retryable: false, requestId, cause
  });
};

export const createHttpResponseError = async (response, options = {}) => {
  let body = null;
  try {
    body = await parseResponseBody(response, { ...options, allowInvalidJson: true });
  } catch (_error) {
    body = null;
  }

  const requestId =
    readHeader(response?.headers, 'x-request-id') ||
    readHeader(response?.headers, 'x-correlation-id') ||
    options.requestId ||
    null;

  const error = mapHttpStatusToError(response?.status, body, { requestId });
  error.response = {
    status: response?.status ?? null,
    headers: response?.headers || null,
    data: body
  };
  return error;
};

export const normalizeFetchFailure = (error, context = {}) => {
  if (error instanceof AppError) return error;
  if (context.timedOut === true) {
    return new AppError('İstek zaman aşımına uğradı.', {
      code: 'TIMEOUT', status: 408, retryable: true, cause: error
    });
  }
  if (context.aborted === true || error?.name === 'AbortError') {
    return new AppError('Request cancelled', {
      code: 'ABORTED', retryable: false, cause: error
    });
  }
  return new AppError('Ağ bağlantısı kurulamadı.', {
    code: 'NETWORK_ERROR', retryable: true, cause: error
  });
};

export const createResponseMetadata = (response, options = {}) => Object.freeze({
  status: Number(response?.status) || 0,
  ok: response?.ok === true,
  contentType: getContentType(response),
  requestId:
    readHeader(response?.headers, 'x-request-id') ||
    readHeader(response?.headers, 'x-correlation-id') ||
    null,
  url: options.url || null,
  method: String(options.method || 'get').toLowerCase(),
  headers: options.includeHeaders === true ? headersToObject(response?.headers) : undefined
});

export const ResponseParser = Object.freeze({
  isJsonContentType,
  isTextContentType,
  headersToObject,
  getContentType,
  hasNoResponseBody,
  parseResponseBody,
  mapHttpStatusToError,
  createHttpResponseError,
  normalizeFetchFailure,
  createResponseMetadata
});
