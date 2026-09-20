import { AppError } from '../errors/appError';
import { readErrorLike } from './contracts';

const JSON_CONTENT_TYPES = [
  'application/json',
  'application/problem+json',
  'application/geo+json'
] as const;

const TEXT_CONTENT_TYPES = [
  'text/',
  'application/xml',
  'application/xhtml+xml',
  'application/javascript',
  'application/x-www-form-urlencoded'
] as const;

const MAX_SAFE_ERROR_MESSAGE_LENGTH = 240;
const MAX_HEADER_VALUE_LENGTH = 512;
const DEFAULT_MAX_BODY_BYTES = 16 * 1024 * 1024;
const MAX_BODY_BYTES = 64 * 1024 * 1024;
const ERROR_BODY_BYTES = 64 * 1024;
const SENSITIVE_RESPONSE_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'set-cookie',
  'set-cookie2',
  'x-api-key',
  'x-auth-token',
]);

const normalizedBodyLimit = (value: unknown): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_MAX_BODY_BYTES;
  return Math.max(1024, Math.min(MAX_BODY_BYTES, Math.floor(parsed)));
};

export const responseBodyByteLength = (value: string): number => {
  let bytes = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0x7f) bytes += 1;
    else if (codePoint <= 0x7ff) bytes += 2;
    else if (codePoint <= 0xffff) bytes += 3;
    else bytes += 4;
  }
  return bytes;
};

const responseContentLength = (response?: ResponseLike | null): number | null => {
  const raw = readHeader(response?.headers, 'content-length');
  if (raw === null || !/^\d+$/.test(raw.trim())) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
};

const responseTooLarge = (
  response: ResponseLike | null | undefined,
  actualBytes: number,
  limitBytes: number,
): AppError => new AppError('Sunucu yanıtı izin verilen boyutu aşıyor.', {
  code: 'RESPONSE_TOO_LARGE',
  status: response?.status ?? null,
  retryable: false,
  details: {
    limitBytes,
    actualBytes,
  },
});

export const assertResponseBodyBudget = (
  response: ResponseLike | null | undefined,
  maxBodyBytes: unknown,
): number => {
  const limit = normalizedBodyLimit(maxBodyBytes);
  const advertised = responseContentLength(response);
  if (advertised !== null && advertised > limit) {
    throw responseTooLarge(response, advertised, limit);
  }
  return limit;
};

const assertMaterializedSize = (
  response: ResponseLike | null | undefined,
  actualBytes: number,
  limitBytes: number,
): void => {
  if (!Number.isFinite(actualBytes) || actualBytes < 0 || actualBytes > limitBytes) {
    throw responseTooLarge(response, Math.max(0, Number(actualBytes) || 0), limitBytes);
  }
};

export type HeaderCollection = Headers | Record<string, unknown> | null | undefined;

export interface ResponseLike {
  status?: number;
  statusText?: string;
  ok?: boolean;
  headers?: HeaderCollection;
  text?: () => Promise<string>;
  blob?: () => Promise<Blob>;
  arrayBuffer?: () => Promise<ArrayBuffer>;
  [key: string]: unknown;
}

export interface ParseResponseOptions {
  method?: string;
  responseType?: string;
  allowInvalidJson?: boolean;
  requestId?: string | null;
  url?: string | null;
  includeHeaders?: boolean;
  maxBodyBytes?: number;
}

const normalizeContentType = (value: unknown): string => {
  const [mediaType = ''] = String(value || '').split(';', 1);
  return mediaType.trim().toLowerCase();
};

export const isJsonContentType = (value: unknown): boolean => {
  const normalized = normalizeContentType(value);
  return JSON_CONTENT_TYPES.includes(normalized as typeof JSON_CONTENT_TYPES[number]) || normalized.endsWith('+json');
};

export const isTextContentType = (value: unknown): boolean => {
  const normalized = normalizeContentType(value);
  return TEXT_CONTENT_TYPES.some((candidate) => normalized.startsWith(candidate));
};

const readHeader = (headers: HeaderCollection, name: string): string | null => {
  if (!headers) return null;
  if (typeof (headers as Headers).get === 'function') {
    const value = (headers as Headers).get(name);
    return value === null ? null : String(value);
  }
  const record = headers as Record<string, unknown>;
  const target = String(name).toLowerCase();
  const key = Object.keys(record).find((item) => item.toLowerCase() === target);
  return key ? String(record[key] ?? '') : null;
};

export const headersToObject = (headers: HeaderCollection): Readonly<Record<string, string>> => {
  if (!headers) return Object.freeze({});

  const result: Record<string, string> = {};
  if (typeof (headers as Headers).forEach === 'function') {
    (headers as Headers).forEach((value, key) => {
      const normalizedKey = String(key).toLowerCase();
      if (SENSITIVE_RESPONSE_HEADERS.has(normalizedKey)) return;
      result[normalizedKey] = String(value).slice(0, MAX_HEADER_VALUE_LENGTH);
    });
  } else {
    const record = headers as Record<string, unknown>;
    Object.keys(record).forEach((key) => {
      const normalizedKey = String(key).toLowerCase();
      if (SENSITIVE_RESPONSE_HEADERS.has(normalizedKey)) return;
      result[normalizedKey] = String(record[key]).slice(0, MAX_HEADER_VALUE_LENGTH);
    });
  }

  return Object.freeze(result);
};

export const getContentType = (response?: ResponseLike | null): string =>
  normalizeContentType(readHeader(response?.headers, 'content-type'));

export const hasNoResponseBody = (response?: ResponseLike | null, method = 'get'): boolean => {
  const status = Number(response?.status);
  const normalizedMethod = String(method || 'get').toLowerCase();

  if (normalizedMethod === 'head') return true;
  if (status === 204 || status === 205 || status === 304) return true;

  const contentLength = readHeader(response?.headers, 'content-length');
  if (contentLength !== null && Number(contentLength) === 0) return true;

  return false;
};

const safeText = async (
  response: ResponseLike | null | undefined,
  limitBytes: number,
): Promise<string> => {
  if (!response || typeof response.text !== 'function') return '';
  const value = await response.text();
  const text = typeof value === 'string' ? value : String(value ?? '');
  assertMaterializedSize(response, responseBodyByteLength(text), limitBytes);
  return text;
};

const parseJsonText = (
  text: string,
  options: { allowInvalidJson?: boolean; status?: number | null } = {}
): unknown => {
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

export const parseResponseBody = async (
  response: ResponseLike,
  options: ParseResponseOptions = {}
): Promise<unknown> => {
  const method = options.method || 'get';
  if (hasNoResponseBody(response, method)) return null;

  const responseType = String(options.responseType || 'auto').toLowerCase();
  if (responseType === 'response') return response;
  const bodyLimit = assertResponseBodyBudget(response, options.maxBodyBytes);

  if (responseType === 'blob') {
    if (typeof response?.blob !== 'function') {
      throw new AppError('Binary response is not supported by this runtime.', {
        code: 'UNSUPPORTED_RESPONSE_TYPE',
        status: response?.status ?? null
      });
    }
    const blob = await response.blob();
    assertMaterializedSize(response, blob.size, bodyLimit);
    return blob;
  }
  if (responseType === 'arraybuffer') {
    if (typeof response?.arrayBuffer !== 'function') {
      throw new AppError('ArrayBuffer response is not supported by this runtime.', {
        code: 'UNSUPPORTED_RESPONSE_TYPE',
        status: response?.status ?? null
      });
    }
    const buffer = await response.arrayBuffer();
    assertMaterializedSize(response, buffer.byteLength, bodyLimit);
    return buffer;
  }

  const text = await safeText(response, bodyLimit);
  if (responseType === 'text') return text;
  if (responseType === 'json') {
    return parseJsonText(text, {
      ...(response?.status === undefined ? {} : { status: response.status }),
      ...(options.allowInvalidJson === undefined ? {} : { allowInvalidJson: options.allowInvalidJson })
    });
  }

  const contentType = getContentType(response);
  if (isJsonContentType(contentType)) {
    return parseJsonText(text, {
      ...(response?.status === undefined ? {} : { status: response.status }),
      ...(options.allowInvalidJson === undefined ? {} : { allowInvalidJson: options.allowInvalidJson })
    });
  }

  if (isTextContentType(contentType)) return text;
  if (!text.trim()) return null;

  const trimmed = text.trim();
  if ((trimmed.startsWith('{') && trimmed.endsWith('}')) ||
      (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
    return parseJsonText(text, {
      ...(response?.status === undefined ? {} : { status: response.status }),
      allowInvalidJson: true
    });
  }

  return text;
};

const extractProblemMessage = (body: unknown): string | null => {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  const candidates = [
    record.message,
    record.detail,
    record.title,
    record.error_description,
    record.error
  ];

  const selected = candidates.find((value) =>
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.trim().length <= MAX_SAFE_ERROR_MESSAGE_LENGTH);

  return typeof selected === 'string' ? selected.trim() : null;
};

interface HttpErrorOptions {
  requestId?: string | null;
  cause?: unknown;
}

export const mapHttpStatusToError = (
  status: unknown,
  body: unknown,
  options: HttpErrorOptions = {}
) => {
  const numericCandidate = Number(status);
  const numericStatus = Number.isFinite(numericCandidate) && numericCandidate > 0
    ? numericCandidate
    : null;
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

export const createHttpResponseError = async (
  response: ResponseLike,
  options: ParseResponseOptions = {}
) => {
  let body: unknown = null;
  try {
    body = await parseResponseBody(response, {
      ...options,
      allowInvalidJson: true,
      maxBodyBytes: Math.min(
        ERROR_BODY_BYTES,
        normalizedBodyLimit(options.maxBodyBytes),
      ),
    });
  } catch {
    body = null;
  }

  const requestId =
    readHeader(response?.headers, 'x-request-id') ||
    readHeader(response?.headers, 'x-correlation-id') ||
    options.requestId ||
    null;

  const error = mapHttpStatusToError(response?.status, body, { requestId }) as typeof AppError.prototype & {
    response?: { status: number | null; headers: HeaderCollection; data: unknown };
  };
  error.response = {
    status: response?.status ?? null,
    headers: response?.headers || null,
    data: body
  };
  return error;
};

export const normalizeFetchFailure = (
  error: unknown,
  context: { timedOut?: boolean; aborted?: boolean } = {}
) => {
  if (error instanceof AppError) return error;
  if (context.timedOut === true) {
    return new AppError('İstek zaman aşımına uğradı.', {
      code: 'TIMEOUT', status: 408, retryable: true, cause: error
    });
  }
  if (context.aborted === true || readErrorLike(error).name === 'AbortError') {
    return new AppError('Request cancelled', {
      code: 'ABORTED', retryable: false, cause: error
    });
  }
  return new AppError('Ağ bağlantısı kurulamadı.', {
    code: 'NETWORK_ERROR', retryable: true, cause: error
  });
};

export const createResponseMetadata = (
  response: ResponseLike,
  options: ParseResponseOptions = {}
) => Object.freeze({
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
  responseBodyByteLength,
  assertResponseBodyBudget,
  getContentType,
  hasNoResponseBody,
  parseResponseBody,
  mapHttpStatusToError,
  createHttpResponseError,
  normalizeFetchFailure,
  createResponseMetadata
});
