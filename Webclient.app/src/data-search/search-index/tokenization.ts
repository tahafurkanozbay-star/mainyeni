import {
  normalizeFiniteNumber,
  normalizeInteger,
  normalizeSearchText,
} from '../../Toolbox/DataIntegrityHelper';

export const DEFAULT_PREFIX_LENGTH = 3;

const unique = <T>(values: readonly T[]): T[] =>
  Array.from(new Set(values));

export const tokenizeSearchText = (value: unknown): string[] =>
  unique(
    normalizeSearchText(value)
      .replace(/[^a-z0-9]+/g, ' ')
      .split(' ')
      .map(token => token.trim())
      .filter(Boolean),
  );

export const createTokenPrefixes = (
  token: unknown,
  minimumLength: unknown = DEFAULT_PREFIX_LENGTH,
): string[] => {
  const normalized = normalizeSearchText(token).replace(/[^a-z0-9]/g, '');
  if (!normalized) return [];

  const requestedMinimum = normalizeFiniteNumber(minimumLength, null);
  const min = requestedMinimum === null || requestedMinimum <= 0
    ? DEFAULT_PREFIX_LENGTH
    : normalizeInteger(requestedMinimum, {
      min: 1,
      max: 20,
      fallback: DEFAULT_PREFIX_LENGTH,
    }) ?? DEFAULT_PREFIX_LENGTH;

  if (normalized.length < min) return [normalized];

  const prefixes: string[] = [];
  for (let length = min; length <= normalized.length; length += 1) {
    prefixes.push(normalized.slice(0, length));
  }
  return prefixes;
};

export const boundedLevenshtein = (
  leftValue: unknown,
  rightValue: unknown,
  maxDistance: unknown = 2,
): number => {
  const left = normalizeSearchText(leftValue);
  const right = normalizeSearchText(rightValue);
  const limit = Math.max(
    0,
    normalizeInteger(maxDistance, { min: 0, max: 8, fallback: 2 }) ?? 2,
  );

  if (left === right) return 0;
  if (!left.length) return right.length <= limit ? right.length : limit + 1;
  if (!right.length) return left.length <= limit ? left.length : limit + 1;
  if (Math.abs(left.length - right.length) > limit) return limit + 1;

  let previous = Array.from(
    { length: right.length + 1 },
    (_, index) => index,
  );

  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current: number[] = [leftIndex];
    let rowMinimum = current[0] ?? leftIndex;

    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const substitutionCost =
        left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1;
      const insertion = (current[rightIndex - 1] ?? Number.MAX_SAFE_INTEGER) + 1;
      const deletion = (previous[rightIndex] ?? Number.MAX_SAFE_INTEGER) + 1;
      const substitution =
        (previous[rightIndex - 1] ?? Number.MAX_SAFE_INTEGER) + substitutionCost;
      const value = Math.min(insertion, deletion, substitution);
      current[rightIndex] = value;
      rowMinimum = Math.min(rowMinimum, value);
    }

    if (rowMinimum > limit) return limit + 1;
    previous = current;
  }

  const distance = previous[right.length] ?? limit + 1;
  return distance <= limit ? distance : limit + 1;
};

export const uniqueSearchTokens = unique;
