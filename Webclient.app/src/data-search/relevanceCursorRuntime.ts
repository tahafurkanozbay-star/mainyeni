import { hashFingerprint, stableSerialize } from './normalization';
import type { RelevanceHit } from './relevanceIndexRuntime';

export interface RelevanceCursorPolicy {
  readonly maximumCursorLength: number;
  readonly maximumPageSize: number;
  readonly maximumScan: number;
}

export interface RelevanceCursorIdentity {
  readonly datasetRevision: string;
  readonly querySignature: string;
  readonly filterFingerprint: string;
}

export interface RelevanceCursorPayload extends RelevanceCursorIdentity {
  readonly version: 1;
  readonly score: number;
  readonly title: string;
  readonly sourceIndex: number;
  readonly fingerprint: string;
  readonly checksum: string;
}

export interface RelevanceCursorPage {
  readonly items: readonly RelevanceHit[];
  readonly pageSize: number;
  readonly hasMore: boolean;
  readonly nextCursor: string | null;
  readonly scanned: number;
  readonly staleCursor: boolean;
  readonly invalidCursor: boolean;
}

const DEFAULT_POLICY: RelevanceCursorPolicy = Object.freeze({
  maximumCursorLength: 2048,
  maximumPageSize: 250,
  maximumScan: 50_000,
});

const normalizeInteger = (value: number | undefined, fallback: number, minimum: number, maximum: number): number => {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`cursor policy integer must be between ${minimum} and ${maximum}`);
  }
  return value;
};

const normalizePolicy = (input: Partial<RelevanceCursorPolicy>): RelevanceCursorPolicy => Object.freeze({
  maximumCursorLength: normalizeInteger(input.maximumCursorLength, DEFAULT_POLICY.maximumCursorLength, 128, 16_384),
  maximumPageSize: normalizeInteger(input.maximumPageSize, DEFAULT_POLICY.maximumPageSize, 1, 5000),
  maximumScan: normalizeInteger(input.maximumScan, DEFAULT_POLICY.maximumScan, 1, 1_000_000),
});

const sanitizeIdentityValue = (value: unknown, maximum: number): string => String(value ?? '').slice(0, maximum);

const normalizeIdentity = (identity: RelevanceCursorIdentity): RelevanceCursorIdentity => Object.freeze({
  datasetRevision: sanitizeIdentityValue(identity.datasetRevision, 256),
  querySignature: sanitizeIdentityValue(identity.querySignature, 256),
  filterFingerprint: sanitizeIdentityValue(identity.filterFingerprint, 256),
});

const cursorCore = (payload: Omit<RelevanceCursorPayload, 'checksum'>): string => stableSerialize({
  version: payload.version,
  datasetRevision: payload.datasetRevision,
  querySignature: payload.querySignature,
  filterFingerprint: payload.filterFingerprint,
  score: payload.score,
  title: payload.title,
  sourceIndex: payload.sourceIndex,
  fingerprint: payload.fingerprint,
});

const cursorChecksum = (payload: Omit<RelevanceCursorPayload, 'checksum'>): string => hashFingerprint(cursorCore(payload));

const encodePayload = (payload: RelevanceCursorPayload): string => `rk1.${encodeURIComponent(JSON.stringify(payload))}`;

const asObject = (value: unknown): Readonly<Record<string, unknown>> | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Readonly<Record<string, unknown>>;
};

const finiteNumber = (value: unknown): number | null => {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

const safeInteger = (value: unknown): number | null => {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
};

const decodePayload = (cursor: string, maximumLength: number): RelevanceCursorPayload | null => {
  if (!cursor || cursor.length > maximumLength || !cursor.startsWith('rk1.')) return null;
  try {
    const decoded = decodeURIComponent(cursor.slice(4));
    const object = asObject(JSON.parse(decoded));
    if (!object || object.version !== 1) return null;
    const score = finiteNumber(object.score);
    const sourceIndex = safeInteger(object.sourceIndex);
    if (score === null || sourceIndex === null) return null;
    const datasetRevision = sanitizeIdentityValue(object.datasetRevision, 256);
    const querySignature = sanitizeIdentityValue(object.querySignature, 256);
    const filterFingerprint = sanitizeIdentityValue(object.filterFingerprint, 256);
    const title = sanitizeIdentityValue(object.title, 512);
    const fingerprint = sanitizeIdentityValue(object.fingerprint, 512);
    const checksum = sanitizeIdentityValue(object.checksum, 256);
    if (!datasetRevision || !querySignature || !fingerprint || !checksum) return null;
    const corePayload: Omit<RelevanceCursorPayload, 'checksum'> = Object.freeze({
      version: 1,
      datasetRevision,
      querySignature,
      filterFingerprint,
      score,
      title,
      sourceIndex,
      fingerprint,
    });
    if (cursorChecksum(corePayload) !== checksum) return null;
    return Object.freeze({ ...corePayload, checksum });
  } catch (_error) {
    return null;
  }
};

const identityMatches = (payload: RelevanceCursorPayload, identity: RelevanceCursorIdentity): boolean => payload.datasetRevision === identity.datasetRevision
  && payload.querySignature === identity.querySignature
  && payload.filterFingerprint === identity.filterFingerprint;

const compareHitToCursor = (hit: RelevanceHit, payload: RelevanceCursorPayload): number => {
  const scoreDifference = payload.score - hit.score;
  if (Math.abs(scoreDifference) > Number.EPSILON) return scoreDifference < 0 ? -1 : 1;
  const title = hit.record.title.localeCompare(payload.title, 'tr-TR', { sensitivity: 'base' });
  if (title !== 0) return title;
  const sourceIndex = hit.record.sourceIndex - payload.sourceIndex;
  if (sourceIndex !== 0) return sourceIndex;
  return hit.record.fingerprint.localeCompare(payload.fingerprint);
};

const findStart = (hits: readonly RelevanceHit[], payload: RelevanceCursorPayload, maximumScan: number): { readonly start: number; readonly scanned: number } => {
  const bound = Math.min(hits.length, maximumScan);
  let scanned = 0;
  for (let index = 0; index < bound; index += 1) {
    const hit = hits[index];
    if (!hit) continue;
    scanned += 1;
    const comparison = compareHitToCursor(hit, payload);
    if (comparison > 0) return Object.freeze({ start: index, scanned });
    if (comparison === 0) return Object.freeze({ start: index + 1, scanned });
  }
  return Object.freeze({ start: bound, scanned });
};

const createPayload = (hit: RelevanceHit, identityInput: RelevanceCursorIdentity): RelevanceCursorPayload => {
  const identity = normalizeIdentity(identityInput);
  const core: Omit<RelevanceCursorPayload, 'checksum'> = Object.freeze({
    version: 1,
    datasetRevision: identity.datasetRevision,
    querySignature: identity.querySignature,
    filterFingerprint: identity.filterFingerprint,
    score: hit.score,
    title: hit.record.title.slice(0, 512),
    sourceIndex: hit.record.sourceIndex,
    fingerprint: hit.record.fingerprint.slice(0, 512),
  });
  return Object.freeze({ ...core, checksum: cursorChecksum(core) });
};

export const createRelevanceCursor = (hit: RelevanceHit, identity: RelevanceCursorIdentity): string => encodePayload(createPayload(hit, identity));

export const parseRelevanceCursor = (cursor: string, policy: Partial<RelevanceCursorPolicy> = {}): RelevanceCursorPayload | null => decodePayload(cursor, normalizePolicy(policy).maximumCursorLength);

export class RelevanceCursorRuntime {
  readonly #policy: RelevanceCursorPolicy;

  constructor(policy: Partial<RelevanceCursorPolicy> = {}) {
    this.#policy = normalizePolicy(policy);
  }

  policy(): RelevanceCursorPolicy {
    return this.#policy;
  }

  page(
    hits: readonly RelevanceHit[],
    identityInput: RelevanceCursorIdentity,
    cursor: string | null | undefined,
    requestedPageSize?: number,
  ): RelevanceCursorPage {
    const identity = normalizeIdentity(identityInput);
    const pageSize = normalizeInteger(requestedPageSize, Math.min(25, this.#policy.maximumPageSize), 1, this.#policy.maximumPageSize);
    let start = 0;
    let scanned = 0;
    let staleCursor = false;
    let invalidCursor = false;
    if (cursor) {
      const payload = decodePayload(cursor, this.#policy.maximumCursorLength);
      if (!payload) invalidCursor = true;
      else if (!identityMatches(payload, identity)) staleCursor = true;
      else {
        const located = findStart(hits, payload, this.#policy.maximumScan);
        start = located.start;
        scanned = located.scanned;
      }
    }
    if (invalidCursor || staleCursor) {
      return Object.freeze({
        items: Object.freeze([]),
        pageSize,
        hasMore: false,
        nextCursor: null,
        scanned,
        staleCursor,
        invalidCursor,
      });
    }
    const items = Object.freeze(hits.slice(start, start + pageSize));
    const hasMore = start + items.length < hits.length;
    const last = items[items.length - 1];
    return Object.freeze({
      items,
      pageSize,
      hasMore,
      nextCursor: hasMore && last ? createRelevanceCursor(last, identity) : null,
      scanned,
      staleCursor: false,
      invalidCursor: false,
    });
  }
}
