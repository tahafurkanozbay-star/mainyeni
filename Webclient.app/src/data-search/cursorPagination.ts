import type {
  PageInfo,
  SearchHit,
  SearchRequest,
  SearchResponse,
} from './contracts';
import {
  hashFingerprint,
  normalizeInteger,
  normalizeText,
  stableSerialize,
} from './normalization';

export const SEARCH_CURSOR_VERSION = 1 as const;
export const DEFAULT_CURSOR_LIMIT = 50;
export const MAX_CURSOR_LIMIT = 250;
export const DEFAULT_CURSOR_MAX_AGE_MS = 15 * 60 * 1000;
export const MAX_CURSOR_TOKEN_LENGTH = 8_192;

export type SearchCursorErrorCode =
  | 'CURSOR_EMPTY'
  | 'CURSOR_TOO_LONG'
  | 'CURSOR_FORMAT'
  | 'CURSOR_CHECKSUM'
  | 'CURSOR_VERSION'
  | 'CURSOR_DATASET_MISMATCH'
  | 'CURSOR_REVISION_MISMATCH'
  | 'CURSOR_FINGERPRINT_MISMATCH'
  | 'CURSOR_QUERY_MISMATCH'
  | 'CURSOR_EXPIRED';

export interface SearchCursorPayload {
  readonly version: typeof SEARCH_CURSOR_VERSION;
  readonly datasetKey: string;
  readonly datasetRevision: number;
  readonly datasetFingerprint: string;
  readonly querySignature: string;
  readonly offset: number;
  readonly limit: number;
  readonly issuedAt: number;
}

export interface SearchCursorContext {
  readonly datasetKey: string;
  readonly datasetRevision: number;
  readonly datasetFingerprint: string;
  readonly querySignature: string;
  readonly now?: number;
  readonly maxAgeMs?: number;
}

export interface CursorPage<T = SearchHit> {
  readonly items: readonly T[];
  readonly page: PageInfo;
  readonly cursor: string | null;
  readonly previousCursor: string | null;
  readonly datasetRevision: number;
  readonly querySignature: string;
}

export class SearchCursorError extends Error {
  readonly code: SearchCursorErrorCode;

  constructor(code: SearchCursorErrorCode, message: string) {
    super(message);
    this.name = 'SearchCursorError';
    this.code = code;
  }
}

const normalizeTimestamp = (value: unknown, fallback = Date.now()): number => {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? Math.trunc(numeric) : fallback;
};

const normalizeCursorLimit = (value: unknown): number => normalizeInteger(value, {
  min: 1,
  max: MAX_CURSOR_LIMIT,
  fallback: DEFAULT_CURSOR_LIMIT,
});

const normalizeCursorOffset = (value: unknown): number => normalizeInteger(value, {
  min: 0,
  max: Number.MAX_SAFE_INTEGER,
  fallback: 0,
});

const encodeText = (value: string): string => encodeURIComponent(value)
  .replace(/%([0-9A-F]{2})/g, (_match, hex: string) => `~${hex.toLowerCase()}`)
  .replace(/\./g, '%2E');

const decodeText = (value: string): string => decodeURIComponent(
  value
    .replace(/~([0-9a-f]{2})/g, (_match, hex: string) => `%${hex.toUpperCase()}`)
    .replace(/%2E/gi, '.'),
);

const payloadChecksum = (serializedPayload: string): string => hashFingerprint(serializedPayload);

export const normalizeSearchCursorPayload = (
  input: Partial<SearchCursorPayload>,
): SearchCursorPayload => {
  const datasetKey = normalizeText(input.datasetKey);
  const datasetFingerprint = normalizeText(input.datasetFingerprint);
  const querySignature = normalizeText(input.querySignature);
  if (!datasetKey) throw new SearchCursorError('CURSOR_FORMAT', 'Cursor dataset key is required');
  if (!datasetFingerprint) throw new SearchCursorError('CURSOR_FORMAT', 'Cursor dataset fingerprint is required');
  if (!querySignature) throw new SearchCursorError('CURSOR_FORMAT', 'Cursor query signature is required');
  const version = Number(input.version);
  if (version !== SEARCH_CURSOR_VERSION) {
    throw new SearchCursorError('CURSOR_VERSION', `Unsupported cursor version: ${String(input.version)}`);
  }
  return Object.freeze({
    version: SEARCH_CURSOR_VERSION,
    datasetKey,
    datasetRevision: normalizeInteger(input.datasetRevision, {
      min: 0,
      max: Number.MAX_SAFE_INTEGER,
      fallback: 0,
    }),
    datasetFingerprint,
    querySignature,
    offset: normalizeCursorOffset(input.offset),
    limit: normalizeCursorLimit(input.limit),
    issuedAt: normalizeTimestamp(input.issuedAt, 0),
  });
};

export const encodeSearchCursor = (input: Partial<SearchCursorPayload>): string => {
  const payload = normalizeSearchCursorPayload(input);
  const serialized = stableSerialize(payload);
  const checksum = payloadChecksum(serialized);
  const encoded = encodeText(serialized);
  const token = `dsc${SEARCH_CURSOR_VERSION}.${checksum}.${encoded}`;
  if (token.length > MAX_CURSOR_TOKEN_LENGTH) {
    throw new SearchCursorError('CURSOR_TOO_LONG', 'Search cursor exceeds the maximum token length');
  }
  return token;
};

const readCursorParts = (tokenInput: unknown): readonly [string, string] => {
  const token = normalizeText(tokenInput);
  if (!token) throw new SearchCursorError('CURSOR_EMPTY', 'Search cursor is required');
  if (token.length > MAX_CURSOR_TOKEN_LENGTH) {
    throw new SearchCursorError('CURSOR_TOO_LONG', 'Search cursor exceeds the maximum token length');
  }
  const first = token.indexOf('.');
  const second = first >= 0 ? token.indexOf('.', first + 1) : -1;
  if (first <= 0 || second <= first + 1 || second >= token.length - 1) {
    throw new SearchCursorError('CURSOR_FORMAT', 'Search cursor has an invalid format');
  }
  const prefix = token.slice(0, first);
  if (prefix !== `dsc${SEARCH_CURSOR_VERSION}`) {
    throw new SearchCursorError('CURSOR_VERSION', `Unsupported search cursor prefix: ${prefix}`);
  }
  return [token.slice(first + 1, second), token.slice(second + 1)] as const;
};

export const decodeSearchCursor = (tokenInput: unknown): SearchCursorPayload => {
  const [checksum, encoded] = readCursorParts(tokenInput);
  let serialized: string;
  try {
    serialized = decodeText(encoded);
  } catch {
    throw new SearchCursorError('CURSOR_FORMAT', 'Search cursor payload is not decodable');
  }
  if (payloadChecksum(serialized) !== checksum) {
    throw new SearchCursorError('CURSOR_CHECKSUM', 'Search cursor checksum does not match its payload');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    throw new SearchCursorError('CURSOR_FORMAT', 'Search cursor payload is not valid JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new SearchCursorError('CURSOR_FORMAT', 'Search cursor payload must be an object');
  }
  return normalizeSearchCursorPayload(parsed as Partial<SearchCursorPayload>);
};

const normalizeMaxAge = (value: unknown): number => normalizeInteger(value, {
  min: 0,
  max: 7 * 24 * 60 * 60 * 1000,
  fallback: DEFAULT_CURSOR_MAX_AGE_MS,
});

export const validateSearchCursor = (
  cursor: SearchCursorPayload,
  context: SearchCursorContext,
): SearchCursorPayload => {
  if (cursor.datasetKey !== normalizeText(context.datasetKey)) {
    throw new SearchCursorError('CURSOR_DATASET_MISMATCH', 'Cursor belongs to a different dataset');
  }
  if (cursor.datasetRevision !== context.datasetRevision) {
    throw new SearchCursorError('CURSOR_REVISION_MISMATCH', 'Cursor belongs to a stale dataset revision');
  }
  if (cursor.datasetFingerprint !== normalizeText(context.datasetFingerprint)) {
    throw new SearchCursorError('CURSOR_FINGERPRINT_MISMATCH', 'Cursor dataset fingerprint is stale');
  }
  if (cursor.querySignature !== normalizeText(context.querySignature)) {
    throw new SearchCursorError('CURSOR_QUERY_MISMATCH', 'Cursor belongs to a different query');
  }
  const maxAge = normalizeMaxAge(context.maxAgeMs);
  if (maxAge > 0) {
    const now = normalizeTimestamp(context.now, Date.now());
    if (cursor.issuedAt <= 0 || now - cursor.issuedAt > maxAge) {
      throw new SearchCursorError('CURSOR_EXPIRED', 'Search cursor has expired');
    }
  }
  return cursor;
};

export const createSearchCursor = (
  context: SearchCursorContext,
  offset: unknown,
  limit: unknown,
): string => encodeSearchCursor({
  version: SEARCH_CURSOR_VERSION,
  datasetKey: context.datasetKey,
  datasetRevision: context.datasetRevision,
  datasetFingerprint: context.datasetFingerprint,
  querySignature: context.querySignature,
  offset: normalizeCursorOffset(offset),
  limit: normalizeCursorLimit(limit),
  issuedAt: normalizeTimestamp(context.now, Date.now()),
});

export const applyCursorToSearchRequest = (
  request: SearchRequest,
  token: unknown,
  context: SearchCursorContext,
): SearchRequest => {
  const cursor = validateSearchCursor(decodeSearchCursor(token), context);
  return Object.freeze({
    ...request,
    offset: cursor.offset,
    limit: cursor.limit,
  });
};

export const createCursorPage = <T extends SearchHit>(
  response: SearchResponse,
  context: SearchCursorContext,
): CursorPage<T> => {
  const page = response.page;
  const cursor = page.hasMore && page.nextOffset !== null
    ? createSearchCursor(context, page.nextOffset, page.limit)
    : null;
  const previousOffset = Math.max(0, page.offset - page.limit);
  const previousCursor = page.offset > 0
    ? createSearchCursor(context, previousOffset, page.limit)
    : null;
  return Object.freeze({
    items: Object.freeze(response.results as readonly T[]),
    page,
    cursor,
    previousCursor,
    datasetRevision: context.datasetRevision,
    querySignature: context.querySignature,
  });
};

export const cursorContextFromSearchResponse = (
  response: SearchResponse,
  datasetFingerprint: string,
  now = Date.now(),
): SearchCursorContext => Object.freeze({
  datasetKey: response.diagnostics.datasetKey,
  datasetRevision: response.diagnostics.revision,
  datasetFingerprint: normalizeText(datasetFingerprint),
  querySignature: response.diagnostics.querySignature,
  now: normalizeTimestamp(now),
});

export const cursorRequestFingerprint = (
  datasetKey: string,
  datasetRevision: number,
  request: SearchRequest,
): string => hashFingerprint(stableSerialize({
  datasetKey: normalizeText(datasetKey),
  datasetRevision,
  query: normalizeText(request.query),
  filters: request.filters ?? [],
  facets: request.facetFields ?? [],
  sort: request.sort ?? 'relevance',
  minScore: request.minScore ?? 0,
  center: request.center ?? null,
  radiusMeters: request.radiusMeters ?? 0,
  level: request.level ?? null,
  district: normalizeText(request.district),
  neighborhood: normalizeText(request.neighborhood),
  street: normalizeText(request.street),
}));

export const isSearchCursorError = (value: unknown): value is SearchCursorError =>
  value instanceof SearchCursorError
  || Boolean(value && typeof value === 'object' && (value as { name?: unknown }).name === 'SearchCursorError');
