import type { NormalizedRecord, SpatialHit } from './contracts';
import {
  hashFingerprint,
  normalizeInteger,
  normalizeText,
  stableSerialize,
} from './normalization';

export const SPATIAL_CURSOR_VERSION = 1 as const;
export const DEFAULT_SPATIAL_CURSOR_LIMIT = 50;
export const MAX_SPATIAL_CURSOR_LIMIT = 500;
export const DEFAULT_SPATIAL_CURSOR_MAX_AGE_MS = 15 * 60 * 1000;
export const MAX_SPATIAL_CURSOR_TOKEN_LENGTH = 8_192;

export type SpatialCursorErrorCode =
  | 'SPATIAL_CURSOR_EMPTY'
  | 'SPATIAL_CURSOR_TOO_LONG'
  | 'SPATIAL_CURSOR_FORMAT'
  | 'SPATIAL_CURSOR_CHECKSUM'
  | 'SPATIAL_CURSOR_VERSION'
  | 'SPATIAL_CURSOR_DATASET_MISMATCH'
  | 'SPATIAL_CURSOR_REVISION_MISMATCH'
  | 'SPATIAL_CURSOR_FINGERPRINT_MISMATCH'
  | 'SPATIAL_CURSOR_QUERY_MISMATCH'
  | 'SPATIAL_CURSOR_EXPIRED';

export interface SpatialCursorDatasetIdentity {
  readonly datasetKey: string;
  readonly revision: number;
  readonly fingerprint: string;
}

export interface SpatialCursorTuple {
  readonly distanceMicrometers: number;
  readonly sourceIndex: number;
  readonly recordFingerprint: string;
}

export interface SpatialCursorPayload {
  readonly version: typeof SPATIAL_CURSOR_VERSION;
  readonly datasetKey: string;
  readonly datasetRevision: number;
  readonly datasetFingerprint: string;
  readonly queryFingerprint: string;
  readonly limit: number;
  readonly issuedAt: number;
  readonly after: SpatialCursorTuple | null;
}

export interface SpatialCursorContext {
  readonly dataset: SpatialCursorDatasetIdentity;
  readonly queryFingerprint: string;
  readonly now?: number;
  readonly maxAgeMs?: number;
}

export interface SpatialCursorPage<TRecord extends NormalizedRecord = NormalizedRecord> {
  readonly items: readonly SpatialHit<TRecord>[];
  readonly count: number;
  readonly limit: number;
  readonly hasMore: boolean;
  readonly nextCursor: string | null;
  readonly datasetRevision: number;
  readonly queryFingerprint: string;
}

export class SpatialCursorError extends Error {
  readonly code: SpatialCursorErrorCode;

  constructor(code: SpatialCursorErrorCode, message: string) {
    super(message);
    this.name = 'SpatialCursorError';
    this.code = code;
  }
}

const normalizeDatasetKey = (value: unknown): string => normalizeText(value).slice(0, 160);
const normalizeFingerprint = (value: unknown): string => normalizeText(value).slice(0, 256);

const normalizeTimestamp = (value: unknown, fallback = Date.now()): number => {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? Math.trunc(numeric) : fallback;
};

const normalizeLimit = (value: unknown): number => normalizeInteger(value, {
  min: 1,
  max: MAX_SPATIAL_CURSOR_LIMIT,
  fallback: DEFAULT_SPATIAL_CURSOR_LIMIT,
});

const normalizeRevision = (value: unknown): number => normalizeInteger(value, {
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

const checksum = (serialized: string): string => hashFingerprint(serialized);

const distanceMicrometers = (value: unknown): number => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return Number.MAX_SAFE_INTEGER;
  const scaled = Math.round(numeric * 1_000_000);
  return Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, scaled));
};

const tupleFromHit = <TRecord extends NormalizedRecord>(
  hit: SpatialHit<TRecord>,
): SpatialCursorTuple => Object.freeze({
  distanceMicrometers: distanceMicrometers(hit.distanceMeters),
  sourceIndex: normalizeInteger(hit.record.sourceIndex, {
    min: 0,
    max: Number.MAX_SAFE_INTEGER,
    fallback: 0,
  }),
  recordFingerprint: normalizeFingerprint(hit.record.fingerprint),
});

const normalizeTuple = (value: unknown): SpatialCursorTuple | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Readonly<Record<string, unknown>>;
  const recordFingerprint = normalizeFingerprint(record.recordFingerprint);
  if (!recordFingerprint) return null;
  return Object.freeze({
    distanceMicrometers: normalizeInteger(record.distanceMicrometers, {
      min: 0,
      max: Number.MAX_SAFE_INTEGER,
      fallback: Number.MAX_SAFE_INTEGER,
    }),
    sourceIndex: normalizeInteger(record.sourceIndex, {
      min: 0,
      max: Number.MAX_SAFE_INTEGER,
      fallback: 0,
    }),
    recordFingerprint,
  });
};

const compareTuple = (left: SpatialCursorTuple, right: SpatialCursorTuple): number =>
  left.distanceMicrometers - right.distanceMicrometers
  || left.sourceIndex - right.sourceIndex
  || left.recordFingerprint.localeCompare(right.recordFingerprint);

const compareHits = <TRecord extends NormalizedRecord>(
  left: SpatialHit<TRecord>,
  right: SpatialHit<TRecord>,
): number => compareTuple(tupleFromHit(left), tupleFromHit(right));

export const normalizeSpatialCursorPayload = (
  input: Partial<SpatialCursorPayload>,
): SpatialCursorPayload => {
  const datasetKey = normalizeDatasetKey(input.datasetKey);
  const datasetFingerprint = normalizeFingerprint(input.datasetFingerprint);
  const queryFingerprint = normalizeFingerprint(input.queryFingerprint);
  if (!datasetKey) {
    throw new SpatialCursorError('SPATIAL_CURSOR_FORMAT', 'Spatial cursor dataset key is required');
  }
  if (!datasetFingerprint) {
    throw new SpatialCursorError('SPATIAL_CURSOR_FORMAT', 'Spatial cursor dataset fingerprint is required');
  }
  if (!queryFingerprint) {
    throw new SpatialCursorError('SPATIAL_CURSOR_FORMAT', 'Spatial cursor query fingerprint is required');
  }
  if (Number(input.version) !== SPATIAL_CURSOR_VERSION) {
    throw new SpatialCursorError(
      'SPATIAL_CURSOR_VERSION',
      `Unsupported spatial cursor version: ${String(input.version)}`,
    );
  }
  return Object.freeze({
    version: SPATIAL_CURSOR_VERSION,
    datasetKey,
    datasetRevision: normalizeRevision(input.datasetRevision),
    datasetFingerprint,
    queryFingerprint,
    limit: normalizeLimit(input.limit),
    issuedAt: normalizeTimestamp(input.issuedAt, 0),
    after: input.after === null || input.after === undefined ? null : normalizeTuple(input.after),
  });
};

export const encodeSpatialCursor = (
  input: Partial<SpatialCursorPayload>,
): string => {
  const payload = normalizeSpatialCursorPayload(input);
  const serialized = stableSerialize(payload);
  const token = `dss${SPATIAL_CURSOR_VERSION}.${checksum(serialized)}.${encodeText(serialized)}`;
  if (token.length > MAX_SPATIAL_CURSOR_TOKEN_LENGTH) {
    throw new SpatialCursorError(
      'SPATIAL_CURSOR_TOO_LONG',
      'Spatial cursor exceeds the maximum token length',
    );
  }
  return token;
};

const readTokenParts = (tokenInput: unknown): readonly [string, string] => {
  const token = normalizeText(tokenInput);
  if (!token) throw new SpatialCursorError('SPATIAL_CURSOR_EMPTY', 'Spatial cursor is required');
  if (token.length > MAX_SPATIAL_CURSOR_TOKEN_LENGTH) {
    throw new SpatialCursorError(
      'SPATIAL_CURSOR_TOO_LONG',
      'Spatial cursor exceeds the maximum token length',
    );
  }
  const first = token.indexOf('.');
  const second = first >= 0 ? token.indexOf('.', first + 1) : -1;
  if (first <= 0 || second <= first + 1 || second >= token.length - 1) {
    throw new SpatialCursorError('SPATIAL_CURSOR_FORMAT', 'Spatial cursor has an invalid format');
  }
  const prefix = token.slice(0, first);
  if (prefix !== `dss${SPATIAL_CURSOR_VERSION}`) {
    throw new SpatialCursorError(
      'SPATIAL_CURSOR_VERSION',
      `Unsupported spatial cursor prefix: ${prefix}`,
    );
  }
  return [token.slice(first + 1, second), token.slice(second + 1)] as const;
};

export const decodeSpatialCursor = (tokenInput: unknown): SpatialCursorPayload => {
  const [expectedChecksum, encoded] = readTokenParts(tokenInput);
  let serialized: string;
  try {
    serialized = decodeText(encoded);
  } catch {
    throw new SpatialCursorError('SPATIAL_CURSOR_FORMAT', 'Spatial cursor payload is not decodable');
  }
  if (checksum(serialized) !== expectedChecksum) {
    throw new SpatialCursorError(
      'SPATIAL_CURSOR_CHECKSUM',
      'Spatial cursor checksum does not match its payload',
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    throw new SpatialCursorError('SPATIAL_CURSOR_FORMAT', 'Spatial cursor payload is not valid JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new SpatialCursorError('SPATIAL_CURSOR_FORMAT', 'Spatial cursor payload must be an object');
  }
  return normalizeSpatialCursorPayload(parsed as Partial<SpatialCursorPayload>);
};

export const validateSpatialCursor = (
  cursor: SpatialCursorPayload,
  context: SpatialCursorContext,
): SpatialCursorPayload => {
  const datasetKey = normalizeDatasetKey(context.dataset.datasetKey);
  const datasetFingerprint = normalizeFingerprint(context.dataset.fingerprint);
  const queryFingerprint = normalizeFingerprint(context.queryFingerprint);
  if (cursor.datasetKey !== datasetKey) {
    throw new SpatialCursorError(
      'SPATIAL_CURSOR_DATASET_MISMATCH',
      'Spatial cursor belongs to a different dataset',
    );
  }
  if (cursor.datasetRevision !== normalizeRevision(context.dataset.revision)) {
    throw new SpatialCursorError(
      'SPATIAL_CURSOR_REVISION_MISMATCH',
      'Spatial cursor belongs to a stale dataset revision',
    );
  }
  if (cursor.datasetFingerprint !== datasetFingerprint) {
    throw new SpatialCursorError(
      'SPATIAL_CURSOR_FINGERPRINT_MISMATCH',
      'Spatial cursor dataset fingerprint is stale',
    );
  }
  if (cursor.queryFingerprint !== queryFingerprint) {
    throw new SpatialCursorError(
      'SPATIAL_CURSOR_QUERY_MISMATCH',
      'Spatial cursor belongs to a different spatial query',
    );
  }
  const maxAgeMs = normalizeInteger(context.maxAgeMs, {
    min: 0,
    max: 7 * 24 * 60 * 60 * 1000,
    fallback: DEFAULT_SPATIAL_CURSOR_MAX_AGE_MS,
  });
  if (maxAgeMs > 0) {
    const now = normalizeTimestamp(context.now, Date.now());
    if (cursor.issuedAt <= 0 || now - cursor.issuedAt > maxAgeMs) {
      throw new SpatialCursorError('SPATIAL_CURSOR_EXPIRED', 'Spatial cursor has expired');
    }
  }
  return cursor;
};

export const createSpatialCursor = (
  context: SpatialCursorContext,
  after: SpatialCursorTuple | null,
  limit: unknown,
): string => encodeSpatialCursor({
  version: SPATIAL_CURSOR_VERSION,
  datasetKey: context.dataset.datasetKey,
  datasetRevision: context.dataset.revision,
  datasetFingerprint: context.dataset.fingerprint,
  queryFingerprint: context.queryFingerprint,
  limit: normalizeLimit(limit),
  issuedAt: normalizeTimestamp(context.now, Date.now()),
  after,
});

const firstIndexAfter = <TRecord extends NormalizedRecord>(
  hits: readonly SpatialHit<TRecord>[],
  after: SpatialCursorTuple | null,
): number => {
  if (!after) return 0;
  let low = 0;
  let high = hits.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    const hit = hits[middle];
    if (hit && compareTuple(tupleFromHit(hit), after) <= 0) low = middle + 1;
    else high = middle;
  }
  return low;
};

export const createSpatialCursorPage = <TRecord extends NormalizedRecord>(
  inputHits: readonly SpatialHit<TRecord>[],
  context: SpatialCursorContext,
  options: {
    readonly cursor?: string | null;
    readonly limit?: number;
  } = {},
): SpatialCursorPage<TRecord> => {
  const cursor = options.cursor
    ? validateSpatialCursor(decodeSpatialCursor(options.cursor), context)
    : null;
  const limit = cursor?.limit ?? normalizeLimit(options.limit);
  const sorted = [...inputHits].sort(compareHits);
  const start = firstIndexAfter(sorted, cursor?.after ?? null);
  const items = sorted.slice(start, start + limit);
  const hasMore = start + items.length < sorted.length;
  const last = items.at(-1) ?? null;
  const nextCursor = hasMore && last
    ? createSpatialCursor(context, tupleFromHit(last), limit)
    : null;
  return Object.freeze({
    items: Object.freeze(items),
    count: items.length,
    limit,
    hasMore,
    nextCursor,
    datasetRevision: context.dataset.revision,
    queryFingerprint: normalizeFingerprint(context.queryFingerprint),
  });
};

export const createSpatialQueryFingerprint = (input: Readonly<{
  center: unknown;
  radiusMeters: unknown;
  filters?: unknown;
  sort?: unknown;
}>): string => hashFingerprint(stableSerialize({
  center: input.center ?? null,
  radiusMeters: Number(input.radiusMeters),
  filters: input.filters ?? [],
  sort: normalizeText(input.sort) || 'distance',
}));

export const spatialHitTuple = <TRecord extends NormalizedRecord>(
  hit: SpatialHit<TRecord>,
): SpatialCursorTuple => tupleFromHit(hit);

export const compareSpatialHits = <TRecord extends NormalizedRecord>(
  left: SpatialHit<TRecord>,
  right: SpatialHit<TRecord>,
): number => compareHits(left, right);

export const isSpatialCursorError = (value: unknown): value is SpatialCursorError =>
  value instanceof SpatialCursorError
  || Boolean(value && typeof value === 'object'
    && (value as { name?: unknown }).name === 'SpatialCursorError');
