import type { SafeJsonValue, StoreStateProjection } from './contracts';
import { storeProjectionToSafeValue } from './stateProjectionValue';

export interface StoreProjectionDiff {
  readonly changed: boolean;
  readonly changedPaths: readonly string[];
  readonly truncated: boolean;
}

const isRecord = (value: SafeJsonValue): value is Readonly<Record<string, SafeJsonValue>> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export const diffStoreProjections = (
  before: StoreStateProjection,
  after: StoreStateProjection,
  maxPaths = 128,
): StoreProjectionDiff => {
  const limit = Number.isFinite(maxPaths)
    ? Math.min(10_000, Math.max(1, Math.trunc(maxPaths)))
    : 128;
  const changedPaths: string[] = [];
  let truncated = false;

  const push = (path: string): void => {
    if (changedPaths.length >= limit) {
      truncated = true;
      return;
    }
    changedPaths.push(path || '$');
  };

  const visit = (left: SafeJsonValue, right: SafeJsonValue, path: string): void => {
    if (Object.is(left, right)) return;
    if (changedPaths.length >= limit) {
      truncated = true;
      return;
    }

    if (
      left === null
      || right === null
      || typeof left !== 'object'
      || typeof right !== 'object'
    ) {
      push(path);
      return;
    }

    const leftArray = Array.isArray(left);
    const rightArray = Array.isArray(right);
    if (leftArray !== rightArray) {
      push(path);
      return;
    }

    if (leftArray && rightArray) {
      const leftValues = left as readonly SafeJsonValue[];
      const rightValues = right as readonly SafeJsonValue[];
      if (leftValues.length !== rightValues.length) push(path + '.length');
      const count = Math.max(leftValues.length, rightValues.length);
      for (let index = 0; index < count; index += 1) {
        const leftValue = leftValues[index];
        const rightValue = rightValues[index];
        if (leftValue === undefined || rightValue === undefined) {
          push(path + '[' + index + ']');
        } else {
          visit(leftValue, rightValue, path + '[' + index + ']');
        }
        if (truncated && changedPaths.length >= limit) break;
      }
      return;
    }

    if (isRecord(left) && isRecord(right)) {
      const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])]
        .sort((a, b) => a.localeCompare(b, 'en'));
      for (const key of keys) {
        const nextPath = path ? path + '.' + key : key;
        const leftValue = left[key];
        const rightValue = right[key];
        if (leftValue === undefined || rightValue === undefined) {
          push(nextPath);
        } else {
          visit(leftValue, rightValue, nextPath);
        }
        if (truncated && changedPaths.length >= limit) break;
      }
      return;
    }

    push(path);
  };

  visit(storeProjectionToSafeValue(before), storeProjectionToSafeValue(after), '');
  return Object.freeze({
    changed: changedPaths.length > 0,
    changedPaths: Object.freeze(changedPaths),
    truncated,
  });
};
