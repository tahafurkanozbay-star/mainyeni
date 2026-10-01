import { normalizeInteger, normalizeSearchToken } from './normalization';

export interface BoundedEditDistancePolicyV8 {
  readonly maximumTokenLength?: number;
  readonly maximumDistance?: number;
  readonly allowAdjacentTransposition?: boolean;
}

export interface BoundedEditDistanceResultV8 {
  readonly left: string;
  readonly right: string;
  readonly distance: number;
  readonly withinThreshold: boolean;
  readonly exact: boolean;
  readonly prefixRelated: boolean;
  readonly lengthDelta: number;
  readonly similarity: number;
  readonly truncated: boolean;
  readonly comparisons: number;
}

export interface BoundedEditDistanceSnapshotV8 {
  readonly version: 8;
  readonly maximumTokenLength: number;
  readonly maximumDistance: number;
  readonly allowAdjacentTransposition: boolean;
  readonly evaluations: number;
  readonly exactMatches: number;
  readonly thresholdMatches: number;
  readonly rejectedByLength: number;
  readonly rejectedByThreshold: number;
  readonly truncatedInputs: number;
  readonly comparisons: number;
}

interface NormalizedPolicyV8 {
  readonly maximumTokenLength: number;
  readonly maximumDistance: number;
  readonly allowAdjacentTransposition: boolean;
}

interface MutableStatsV8 {
  evaluations: number;
  exactMatches: number;
  thresholdMatches: number;
  rejectedByLength: number;
  rejectedByThreshold: number;
  truncatedInputs: number;
  comparisons: number;
}

interface RowComputationInputV8 {
  readonly left: string;
  readonly right: string;
  readonly leftIndex: number;
  readonly previous: readonly number[];
  readonly previousPrevious: readonly number[] | null;
  readonly threshold: number;
  readonly allowAdjacentTransposition: boolean;
}

interface RowComputationResultV8 {
  readonly row: readonly number[];
  readonly minimum: number;
  readonly comparisons: number;
}

const VERSION = 8 as const;
const DEFAULT_MAXIMUM_TOKEN_LENGTH = 64;
const DEFAULT_MAXIMUM_DISTANCE = 2;

const normalizePolicy = (input: BoundedEditDistancePolicyV8 = {}): NormalizedPolicyV8 => Object.freeze({
  maximumTokenLength: normalizeInteger(input.maximumTokenLength, {
    min: 1,
    max: 256,
    fallback: DEFAULT_MAXIMUM_TOKEN_LENGTH,
  }),
  maximumDistance: normalizeInteger(input.maximumDistance, {
    min: 0,
    max: 8,
    fallback: DEFAULT_MAXIMUM_DISTANCE,
  }),
  allowAdjacentTransposition: input.allowAdjacentTransposition !== false,
});

const boundedToken = (
  value: unknown,
  maximumLength: number,
): Readonly<{ value: string; truncated: boolean }> => {
  const canonical = normalizeSearchToken(value);
  if (canonical.length <= maximumLength) {
    return Object.freeze({ value: canonical, truncated: false });
  }
  return Object.freeze({ value: canonical.slice(0, maximumLength), truncated: true });
};

const initialRow = (length: number): readonly number[] => Object.freeze(
  Array.from({ length: length + 1 }, (_value, index) => index),
);

const clampCell = (value: number, threshold: number): number => Math.min(value, threshold + 1);

const substitutionCost = (leftCharacter: string, rightCharacter: string): number =>
  leftCharacter === rightCharacter ? 0 : 1;

const canTranspose = (
  left: string,
  right: string,
  leftIndex: number,
  rightIndex: number,
): boolean => leftIndex > 1
  && rightIndex > 1
  && left[leftIndex - 1] === right[rightIndex - 2]
  && left[leftIndex - 2] === right[rightIndex - 1];

const computeRow = (input: RowComputationInputV8): RowComputationResultV8 => {
  const row: number[] = [input.leftIndex];
  let minimum = row[0] ?? input.leftIndex;
  let comparisons = 0;
  for (let rightIndex = 1; rightIndex <= input.right.length; rightIndex += 1) {
    comparisons += 1;
    const insertion = (row[rightIndex - 1] ?? input.threshold + 1) + 1;
    const deletion = (input.previous[rightIndex] ?? input.threshold + 1) + 1;
    const substitution = (input.previous[rightIndex - 1] ?? input.threshold + 1)
      + substitutionCost(input.left[input.leftIndex - 1] ?? '', input.right[rightIndex - 1] ?? '');
    let value = Math.min(insertion, deletion, substitution);
    if (input.allowAdjacentTransposition
      && input.previousPrevious
      && canTranspose(input.left, input.right, input.leftIndex, rightIndex)) {
      value = Math.min(value, (input.previousPrevious[rightIndex - 2] ?? input.threshold + 1) + 1);
    }
    const bounded = clampCell(value, input.threshold);
    row.push(bounded);
    minimum = Math.min(minimum, bounded);
  }
  return Object.freeze({ row: Object.freeze(row), minimum, comparisons });
};

const normalizedSimilarity = (
  distance: number,
  leftLength: number,
  rightLength: number,
): number => {
  const denominator = Math.max(1, leftLength, rightLength);
  return Math.max(0, Math.min(1, 1 - distance / denominator));
};

const prefixRelated = (left: string, right: string): boolean => Boolean(
  left && right && (left.startsWith(right) || right.startsWith(left)),
);

const rejectedResult = (
  left: string,
  right: string,
  threshold: number,
  truncated: boolean,
  comparisons: number,
): BoundedEditDistanceResultV8 => {
  const distance = threshold + 1;
  return Object.freeze({
    left,
    right,
    distance,
    withinThreshold: false,
    exact: false,
    prefixRelated: prefixRelated(left, right),
    lengthDelta: Math.abs(left.length - right.length),
    similarity: normalizedSimilarity(distance, left.length, right.length),
    truncated,
    comparisons,
  });
};

export class BoundedEditDistanceRuntimeV8 {
  readonly #policy: NormalizedPolicyV8;
  readonly #stats: MutableStatsV8 = {
    evaluations: 0,
    exactMatches: 0,
    thresholdMatches: 0,
    rejectedByLength: 0,
    rejectedByThreshold: 0,
    truncatedInputs: 0,
    comparisons: 0,
  };

  constructor(policy: BoundedEditDistancePolicyV8 = {}) {
    this.#policy = normalizePolicy(policy);
  }

  policy(): Readonly<Required<BoundedEditDistancePolicyV8>> {
    return Object.freeze({
      maximumTokenLength: this.#policy.maximumTokenLength,
      maximumDistance: this.#policy.maximumDistance,
      allowAdjacentTransposition: this.#policy.allowAdjacentTransposition,
    });
  }

  evaluate(
    leftInput: unknown,
    rightInput: unknown,
    thresholdInput?: number,
  ): BoundedEditDistanceResultV8 {
    const leftBounded = boundedToken(leftInput, this.#policy.maximumTokenLength);
    const rightBounded = boundedToken(rightInput, this.#policy.maximumTokenLength);
    const left = leftBounded.value;
    const right = rightBounded.value;
    const truncated = leftBounded.truncated || rightBounded.truncated;
    const threshold = normalizeInteger(thresholdInput, {
      min: 0,
      max: this.#policy.maximumDistance,
      fallback: this.#policy.maximumDistance,
    });
    this.#stats.evaluations += 1;
    if (truncated) this.#stats.truncatedInputs += 1;

    if (left === right) {
      this.#stats.exactMatches += 1;
      this.#stats.thresholdMatches += 1;
      return Object.freeze({
        left,
        right,
        distance: 0,
        withinThreshold: true,
        exact: true,
        prefixRelated: true,
        lengthDelta: 0,
        similarity: 1,
        truncated,
        comparisons: 0,
      });
    }

    const lengthDelta = Math.abs(left.length - right.length);
    if (lengthDelta > threshold) {
      this.#stats.rejectedByLength += 1;
      return rejectedResult(left, right, threshold, truncated, 0);
    }

    if (!left || !right) {
      const distance = Math.max(left.length, right.length);
      const withinThreshold = distance <= threshold;
      if (withinThreshold) this.#stats.thresholdMatches += 1;
      else this.#stats.rejectedByThreshold += 1;
      return Object.freeze({
        left,
        right,
        distance,
        withinThreshold,
        exact: false,
        prefixRelated: false,
        lengthDelta,
        similarity: normalizedSimilarity(distance, left.length, right.length),
        truncated,
        comparisons: 0,
      });
    }

    let previousPrevious: readonly number[] | null = null;
    let previous = initialRow(right.length);
    let comparisons = 0;
    for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
      const computed = computeRow({
        left,
        right,
        leftIndex,
        previous,
        previousPrevious,
        threshold,
        allowAdjacentTransposition: this.#policy.allowAdjacentTransposition,
      });
      comparisons += computed.comparisons;
      if (computed.minimum > threshold) {
        this.#stats.comparisons += comparisons;
        this.#stats.rejectedByThreshold += 1;
        return rejectedResult(left, right, threshold, truncated, comparisons);
      }
      previousPrevious = previous;
      previous = computed.row;
    }

    const distance = previous[right.length] ?? threshold + 1;
    const withinThreshold = distance <= threshold;
    this.#stats.comparisons += comparisons;
    if (withinThreshold) this.#stats.thresholdMatches += 1;
    else this.#stats.rejectedByThreshold += 1;
    return Object.freeze({
      left,
      right,
      distance,
      withinThreshold,
      exact: false,
      prefixRelated: prefixRelated(left, right),
      lengthDelta,
      similarity: normalizedSimilarity(distance, left.length, right.length),
      truncated,
      comparisons,
    });
  }

  within(
    left: unknown,
    right: unknown,
    threshold?: number,
  ): boolean {
    return this.evaluate(left, right, threshold).withinThreshold;
  }

  snapshot(): BoundedEditDistanceSnapshotV8 {
    return Object.freeze({
      version: VERSION,
      maximumTokenLength: this.#policy.maximumTokenLength,
      maximumDistance: this.#policy.maximumDistance,
      allowAdjacentTransposition: this.#policy.allowAdjacentTransposition,
      evaluations: this.#stats.evaluations,
      exactMatches: this.#stats.exactMatches,
      thresholdMatches: this.#stats.thresholdMatches,
      rejectedByLength: this.#stats.rejectedByLength,
      rejectedByThreshold: this.#stats.rejectedByThreshold,
      truncatedInputs: this.#stats.truncatedInputs,
      comparisons: this.#stats.comparisons,
    });
  }
}

export const createBoundedEditDistanceRuntimeV8 = (
  policy: BoundedEditDistancePolicyV8 = {},
): BoundedEditDistanceRuntimeV8 => new BoundedEditDistanceRuntimeV8(policy);

export const boundedEditDistanceV8 = (
  left: unknown,
  right: unknown,
  threshold = DEFAULT_MAXIMUM_DISTANCE,
): BoundedEditDistanceResultV8 => new BoundedEditDistanceRuntimeV8({
  maximumDistance: Math.max(DEFAULT_MAXIMUM_DISTANCE, threshold),
}).evaluate(left, right, threshold);
