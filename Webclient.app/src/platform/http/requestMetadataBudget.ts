import { AppError } from '../errors/appError';
import { normalizeByteBudget, utf8ByteLength } from './byteBudget';

export interface RequestMetadataBudgetOptions {
  readonly maxHeaderCount?: number;
  readonly maxHeaderNameBytes?: number;
  readonly maxHeaderValueBytes?: number;
  readonly maxHeaderBytes?: number;
  readonly maxQueryKeys?: number;
  readonly maxQueryArrayItems?: number;
  readonly maxQueryKeyBytes?: number;
  readonly maxQueryBytes?: number;
}

export interface RequestMetadataBudget {
  readonly maxHeaderCount: number;
  readonly maxHeaderNameBytes: number;
  readonly maxHeaderValueBytes: number;
  readonly maxHeaderBytes: number;
  readonly maxQueryKeys: number;
  readonly maxQueryArrayItems: number;
  readonly maxQueryKeyBytes: number;
  readonly maxQueryBytes: number;
}

export interface RequestMetadataSnapshot {
  readonly headerCount: number;
  readonly headerBytes: number;
  readonly queryKeys: number;
  readonly queryItems: number;
  readonly queryBytes: number;
}

const integer = (
  name: string,
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
): number => {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new RangeError(`${name} must be finite`);
  }
  const normalized = Math.floor(parsed);
  if (!Number.isSafeInteger(normalized) || normalized < minimum || normalized > maximum) {
    throw new RangeError(`${name} must be between ${minimum} and ${maximum}`);
  }
  return normalized;
};

export const createRequestMetadataBudget = (
  options: RequestMetadataBudgetOptions = {},
): RequestMetadataBudget => Object.freeze({
  maxHeaderCount: integer('maxHeaderCount', options.maxHeaderCount, 64, 1, 256),
  maxHeaderNameBytes: integer('maxHeaderNameBytes', options.maxHeaderNameBytes, 128, 16, 1024),
  maxHeaderValueBytes: normalizeByteBudget(options.maxHeaderValueBytes, {
    fallback: 8 * 1024,
    minimum: 128,
    maximum: 64 * 1024,
  }),
  maxHeaderBytes: normalizeByteBudget(options.maxHeaderBytes, {
    fallback: 32 * 1024,
    minimum: 1024,
    maximum: 256 * 1024,
  }),
  maxQueryKeys: integer('maxQueryKeys', options.maxQueryKeys, 128, 1, 1024),
  maxQueryArrayItems: integer('maxQueryArrayItems', options.maxQueryArrayItems, 256, 1, 4096),
  maxQueryKeyBytes: integer('maxQueryKeyBytes', options.maxQueryKeyBytes, 256, 8, 2048),
  maxQueryBytes: normalizeByteBudget(options.maxQueryBytes, {
    fallback: 16 * 1024,
    minimum: 1024,
    maximum: 128 * 1024,
  }),
});

export const DEFAULT_REQUEST_METADATA_BUDGET = createRequestMetadataBudget();

const budgetError = (
  code: string,
  message: string,
  details: Record<string, unknown>,
): AppError => new AppError(message, {
  code,
  retryable: false,
  details,
});

export const assertHeaderCollectionBudget = (
  entries: readonly (readonly [string, unknown])[],
  budget: RequestMetadataBudget = DEFAULT_REQUEST_METADATA_BUDGET,
): number => {
  if (entries.length > budget.maxHeaderCount) {
    throw budgetError(
      'REQUEST_HEADER_BUDGET_EXCEEDED',
      'Request header count exceeds the platform budget.',
      { count: entries.length, maximum: budget.maxHeaderCount },
    );
  }

  let totalBytes = 0;
  for (const [rawName, rawValue] of entries) {
    const nameBytes = utf8ByteLength(String(rawName));
    if (nameBytes > budget.maxHeaderNameBytes) {
      throw budgetError(
        'REQUEST_HEADER_BUDGET_EXCEEDED',
        'Request header name exceeds the platform budget.',
        { nameBytes, maximum: budget.maxHeaderNameBytes },
      );
    }
    if (rawValue === null || rawValue === undefined) continue;

    const valueBytes = utf8ByteLength(String(rawValue));
    if (valueBytes > budget.maxHeaderValueBytes) {
      throw budgetError(
        'REQUEST_HEADER_BUDGET_EXCEEDED',
        'Request header value exceeds the platform budget.',
        { header: String(rawName).toLowerCase(), valueBytes, maximum: budget.maxHeaderValueBytes },
      );
    }

    totalBytes += nameBytes + valueBytes + 4;
    if (totalBytes > budget.maxHeaderBytes) {
      throw budgetError(
        'REQUEST_HEADER_BUDGET_EXCEEDED',
        'Request headers exceed the platform byte budget.',
        { totalBytes, maximum: budget.maxHeaderBytes },
      );
    }
  }
  return totalBytes;
};

export const assertQueryKeyBudget = (
  key: string,
  budget: RequestMetadataBudget = DEFAULT_REQUEST_METADATA_BUDGET,
): void => {
  const bytes = utf8ByteLength(key);
  if (!key || bytes > budget.maxQueryKeyBytes) {
    throw budgetError(
      'REQUEST_QUERY_BUDGET_EXCEEDED',
      'Request query key exceeds the platform budget.',
      { keyBytes: bytes, maximum: budget.maxQueryKeyBytes },
    );
  }
  for (const character of key) {
    const code = character.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f) {
      throw budgetError(
        'INVALID_QUERY_PARAMS',
        'Request query key contains control characters.',
        {},
      );
    }
  }
};

export const assertQueryArrayBudget = (
  value: readonly unknown[],
  budget: RequestMetadataBudget = DEFAULT_REQUEST_METADATA_BUDGET,
): void => {
  if (value.length > budget.maxQueryArrayItems) {
    throw budgetError(
      'REQUEST_QUERY_BUDGET_EXCEEDED',
      'Request query array exceeds the platform budget.',
      { count: value.length, maximum: budget.maxQueryArrayItems },
    );
  }
};

export const assertQueryStringBudget = (
  serialized: string,
  budget: RequestMetadataBudget = DEFAULT_REQUEST_METADATA_BUDGET,
): number => {
  const bytes = utf8ByteLength(serialized);
  if (bytes > budget.maxQueryBytes) {
    throw budgetError(
      'REQUEST_QUERY_BUDGET_EXCEEDED',
      'Request query string exceeds the platform byte budget.',
      { queryBytes: bytes, maximum: budget.maxQueryBytes },
    );
  }
  return bytes;
};

export const assertQueryKeyCount = (
  count: number,
  budget: RequestMetadataBudget = DEFAULT_REQUEST_METADATA_BUDGET,
): void => {
  if (!Number.isSafeInteger(count) || count < 0 || count > budget.maxQueryKeys) {
    throw budgetError(
      'REQUEST_QUERY_BUDGET_EXCEEDED',
      'Request query key count exceeds the platform budget.',
      { count, maximum: budget.maxQueryKeys },
    );
  }
};

export const requestMetadataSnapshot = (
  input: Partial<RequestMetadataSnapshot> = {},
): RequestMetadataSnapshot => Object.freeze({
  headerCount: Math.max(0, Math.floor(Number(input.headerCount) || 0)),
  headerBytes: Math.max(0, Math.floor(Number(input.headerBytes) || 0)),
  queryKeys: Math.max(0, Math.floor(Number(input.queryKeys) || 0)),
  queryItems: Math.max(0, Math.floor(Number(input.queryItems) || 0)),
  queryBytes: Math.max(0, Math.floor(Number(input.queryBytes) || 0)),
});
