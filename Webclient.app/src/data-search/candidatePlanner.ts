import type {
  CandidateIndex,
  CandidatePlan,
  CandidatePlannerOptions,
  NormalizedRecord,
  TokenPosting,
} from './contracts';
import { throwIfAborted } from './contracts';
import {
  normalizeInteger,
  normalizeSearchToken,
  tokenizeSearchText,
} from './normalization';
import {
  addressTokensForCandidatePlanning,
  canonicalAddressRecordTokens,
} from './addressSemantics';
import type { AddressQueryAnalysis } from './contracts';

export const DEFAULT_MAX_PREFIX_LENGTH = 8;
export const DEFAULT_MAX_PREFIX_POSTINGS = 25_000;
export const DEFAULT_MAX_TOKEN_POSTINGS = 100_000;
export const DEFAULT_FALLBACK_SCAN_THRESHOLD = 2_000;

interface NormalizedPlannerOptions {
  readonly maxPrefixLength: number;
  readonly maxPrefixPostings: number;
  readonly maxTokenPostings: number;
  readonly fallbackScanThreshold: number;
}

const normalizeOptions = (options: CandidatePlannerOptions = {}): NormalizedPlannerOptions => ({
  maxPrefixLength: normalizeInteger(options.maxPrefixLength, {
    min: 1,
    max: 24,
    fallback: DEFAULT_MAX_PREFIX_LENGTH,
  }),
  maxPrefixPostings: normalizeInteger(options.maxPrefixPostings, {
    min: 100,
    max: 1_000_000,
    fallback: DEFAULT_MAX_PREFIX_POSTINGS,
  }),
  maxTokenPostings: normalizeInteger(options.maxTokenPostings, {
    min: 100,
    max: 2_000_000,
    fallback: DEFAULT_MAX_TOKEN_POSTINGS,
  }),
  fallbackScanThreshold: normalizeInteger(options.fallbackScanThreshold, {
    min: 1,
    max: 100_000,
    fallback: DEFAULT_FALLBACK_SCAN_THRESHOLD,
  }),
});

const addToPosting = (
  map: Map<string, Set<number>>,
  key: string,
  position: number,
  maximum: number,
): void => {
  if (!key) return;
  const existing = map.get(key);
  if (existing) {
    if (existing.size < maximum) existing.add(position);
    return;
  }
  map.set(key, new Set([position]));
};

const prefixesForToken = (token: string, maximumLength: number): readonly string[] => {
  const normalized = normalizeSearchToken(token);
  if (!normalized) return [];
  const upper = Math.min(normalized.length, maximumLength);
  const result: string[] = [];
  for (let length = 2; length <= upper; length += 1) {
    result.push(normalized.slice(0, length));
  }
  return result;
};

const tokensForRecord = (record: NormalizedRecord): readonly string[] => {
  const tokens = new Set<string>();
  const addTokens = (values: readonly string[]): void => {
    for (const value of values) {
      const token = normalizeSearchToken(value);
      if (token) tokens.add(token);
    }
  };
  addTokens(tokenizeSearchText(record.searchText));
  addTokens(canonicalAddressRecordTokens(record));
  if (record.categoryKey) tokens.add(record.categoryKey.replace(/-/g, ''));
  if (record.typeKey) tokens.add(record.typeKey.replace(/-/g, ''));
  return Object.freeze(Array.from(tokens));
};

export const buildCandidateIndex = (
  records: readonly NormalizedRecord[],
  options: CandidatePlannerOptions = {},
): CandidateIndex => {
  const normalized = normalizeOptions(options);
  const tokenMap = new Map<string, Set<number>>();
  const prefixMap = new Map<string, Set<number>>();

  for (let position = 0; position < records.length; position += 1) {
    const record = records[position];
    if (!record) continue;
    for (const token of tokensForRecord(record)) {
      addToPosting(tokenMap, token, position, normalized.maxTokenPostings);
      for (const prefix of prefixesForToken(token, normalized.maxPrefixLength)) {
        addToPosting(prefixMap, prefix, position, normalized.maxPrefixPostings);
      }
    }
  }

  const readonlyTokens = new Map<string, ReadonlySet<number>>();
  const readonlyPrefixes = new Map<string, ReadonlySet<number>>();
  for (const [token, positions] of tokenMap) readonlyTokens.set(token, positions);
  for (const [prefix, positions] of prefixMap) readonlyPrefixes.set(prefix, positions);

  return Object.freeze({
    tokens: readonlyTokens,
    prefixes: readonlyPrefixes,
    recordCount: records.length,
    tokenCount: readonlyTokens.size,
    prefixCount: readonlyPrefixes.size,
  });
};

const sortedPositions = (positions: Iterable<number>): number[] =>
  Array.from(positions).sort((left, right) => left - right);

const postingForToken = (
  index: CandidateIndex,
  tokenInput: string,
): readonly number[] => {
  const token = normalizeSearchToken(tokenInput);
  if (!token) return [];
  // Prefix postings are a superset for short indexed tokens: they include the
  // exact token plus longer lexical forms such as `park` -> `parki`. Using an
  // exact posting first would incorrectly prune records that the scoring layer
  // can legitimately match by prefix. Long tokens beyond the prefix budget
  // still fall back to their exact posting.
  const prefix = index.prefixes.get(token);
  if (prefix?.size) return sortedPositions(prefix);
  const exact = index.tokens.get(token);
  return exact?.size ? sortedPositions(exact) : [];
};

const intersectSorted = (
  left: readonly number[],
  right: readonly number[],
): number[] => {
  const result: number[] = [];
  let leftIndex = 0;
  let rightIndex = 0;
  while (leftIndex < left.length && rightIndex < right.length) {
    const leftValue = left[leftIndex];
    const rightValue = right[rightIndex];
    if (leftValue === undefined || rightValue === undefined) break;
    if (leftValue === rightValue) {
      result.push(leftValue);
      leftIndex += 1;
      rightIndex += 1;
    } else if (leftValue < rightValue) {
      leftIndex += 1;
    } else {
      rightIndex += 1;
    }
  }
  return result;
};

const unionSorted = (postings: readonly (readonly number[])[]): number[] => {
  const values = new Set<number>();
  for (const posting of postings) {
    for (const position of posting) values.add(position);
  }
  return sortedPositions(values);
};

const allPositions = (count: number): number[] =>
  Array.from({ length: Math.max(0, count) }, (_value, index) => index);

const tokenPosting = (
  index: CandidateIndex,
  token: string,
): TokenPosting => Object.freeze({
  token,
  positions: Object.freeze(postingForToken(index, token)),
});

export interface CandidatePlanRequest {
  readonly query?: string | null;
  readonly address?: AddressQueryAnalysis | null;
  readonly requiredTokens?: readonly string[];
  readonly optionalTokens?: readonly string[];
  readonly signal?: AbortSignal | null;
}

const normalizePlanTokens = (values: readonly string[]): string[] =>
  Array.from(new Set(values.map(normalizeSearchToken).filter(Boolean)));

const chooseRequiredTokens = (request: CandidatePlanRequest): string[] => {
  if (request.requiredTokens?.length) return normalizePlanTokens(request.requiredTokens);
  if (request.address) return normalizePlanTokens(addressTokensForCandidatePlanning(request.address));
  return normalizePlanTokens(tokenizeSearchText(request.query));
};

const chooseOptionalTokens = (
  request: CandidatePlanRequest,
  requiredTokens: readonly string[],
): string[] => {
  const supplied = request.optionalTokens?.length
    ? normalizePlanTokens(request.optionalTokens)
    : normalizePlanTokens(tokenizeSearchText(request.query));
  const required = new Set(requiredTokens);
  return supplied.filter(token => !required.has(token));
};

const estimateCost = (
  strategy: CandidatePlan['strategy'],
  postings: readonly TokenPosting[],
  resultCount: number,
): number => {
  const postingCost = postings.reduce((total, posting) => total + posting.positions.length, 0);
  const multiplier = strategy === 'intersection'
    ? 1
    : strategy === 'union'
      ? 1.25
      : strategy === 'fallback-scan'
        ? 2
        : 0.5;
  return Math.round((postingCost + resultCount) * multiplier);
};

export const planCandidates = (
  index: CandidateIndex,
  request: CandidatePlanRequest = {},
  options: CandidatePlannerOptions = {},
): CandidatePlan => {
  throwIfAborted(request.signal);
  const normalizedOptions = normalizeOptions(options);
  const requiredTokens = chooseRequiredTokens(request);
  const optionalTokens = chooseOptionalTokens(request, requiredTokens);
  const requiredPostings = requiredTokens.map(token => tokenPosting(index, token));
  const optionalPostings = optionalTokens.map(token => tokenPosting(index, token));
  const nonEmptyRequired = requiredPostings.filter(posting => posting.positions.length > 0);
  let candidatePositions: number[];
  let strategy: CandidatePlan['strategy'];

  if (!requiredTokens.length && !optionalTokens.length) {
    candidatePositions = allPositions(index.recordCount);
    strategy = 'all';
  } else if (requiredTokens.length && nonEmptyRequired.length === requiredTokens.length) {
    const ordered = [...requiredPostings].sort(
      (left, right) => left.positions.length - right.positions.length,
    );
    candidatePositions = ordered.length
      ? [...(ordered[0]?.positions ?? [])]
      : [];
    for (let postingIndex = 1; postingIndex < ordered.length; postingIndex += 1) {
      throwIfAborted(request.signal);
      const posting = ordered[postingIndex];
      if (!posting) continue;
      candidatePositions = intersectSorted(candidatePositions, posting.positions);
      if (!candidatePositions.length) break;
    }
    strategy = 'intersection';
  } else {
    const available = [...requiredPostings, ...optionalPostings]
      .filter(posting => posting.positions.length > 0);
    candidatePositions = unionSorted(available.map(posting => posting.positions));
    strategy = 'union';
  }

  if (!candidatePositions.length
    && index.recordCount <= normalizedOptions.fallbackScanThreshold
    && (requiredTokens.length || optionalTokens.length)) {
    candidatePositions = allPositions(index.recordCount);
    strategy = 'fallback-scan';
  }

  const postings = Object.freeze([...requiredPostings, ...optionalPostings]);
  return Object.freeze({
    candidatePositions: Object.freeze(candidatePositions),
    requiredTokens: Object.freeze(requiredTokens),
    optionalTokens: Object.freeze(optionalTokens),
    tokenPostings: postings,
    strategy,
    estimatedCost: estimateCost(strategy, postings, candidatePositions.length),
  });
};

export const validateCandidatePlan = (
  plan: CandidatePlan,
  recordCount: number,
): readonly string[] => {
  const issues: string[] = [];
  let previous = -1;
  for (const position of plan.candidatePositions) {
    if (!Number.isInteger(position) || position < 0 || position >= recordCount) {
      issues.push(`candidate-out-of-range:${String(position)}`);
      continue;
    }
    if (position <= previous) issues.push(`candidate-order:${String(position)}`);
    previous = position;
  }
  return Object.freeze(issues);
};

export const candidateIndexDiagnostics = (
  index: CandidateIndex,
): Readonly<Record<string, number>> => {
  let tokenPostingCount = 0;
  let prefixPostingCount = 0;
  let largestTokenPosting = 0;
  let largestPrefixPosting = 0;
  for (const posting of index.tokens.values()) {
    tokenPostingCount += posting.size;
    largestTokenPosting = Math.max(largestTokenPosting, posting.size);
  }
  for (const posting of index.prefixes.values()) {
    prefixPostingCount += posting.size;
    largestPrefixPosting = Math.max(largestPrefixPosting, posting.size);
  }
  return Object.freeze({
    recordCount: index.recordCount,
    tokenCount: index.tokenCount,
    prefixCount: index.prefixCount,
    tokenPostingCount,
    prefixPostingCount,
    largestTokenPosting,
    largestPrefixPosting,
  });
};
