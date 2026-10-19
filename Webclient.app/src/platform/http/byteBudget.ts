export interface ByteBudgetBounds {
  readonly fallback: number;
  readonly minimum: number;
  readonly maximum: number;
}

export interface ByteBudgetSnapshot {
  readonly limitBytes: number;
  readonly actualBytes: number;
  readonly exceeded: boolean;
  readonly remainingBytes: number;
  readonly utilization: number;
}

const requireSafeBound = (name: string, value: number, minimum = 0): number => {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new RangeError(`${name} must be a safe integer >= ${minimum}`);
  }
  return value;
};

export const normalizeByteBudget = (
  value: unknown,
  bounds: ByteBudgetBounds,
): number => {
  const minimum = requireSafeBound('minimum', bounds.minimum);
  const maximum = requireSafeBound('maximum', bounds.maximum, minimum);
  const fallback = requireSafeBound('fallback', bounds.fallback, minimum);
  if (fallback > maximum) {
    throw new RangeError('fallback must not exceed maximum');
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.floor(parsed)));
};

/**
 * Deterministic UTF-8 byte count without allocating a TextEncoder buffer.
 * Iteration is by Unicode code point, so astral characters are counted once.
 */
export const utf8ByteLength = (value: string): number => {
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

export const byteBudgetSnapshot = (
  actualBytes: number,
  limitBytes: number,
): ByteBudgetSnapshot => {
  const actual = requireSafeBound('actualBytes', actualBytes);
  const limit = requireSafeBound('limitBytes', limitBytes, 1);
  return Object.freeze({
    limitBytes: limit,
    actualBytes: actual,
    exceeded: actual > limit,
    remainingBytes: Math.max(0, limit - actual),
    utilization: Math.min(1, actual / limit),
  });
};

export const assertWithinByteBudget = (
  actualBytes: number,
  limitBytes: number,
  createError: (snapshot: ByteBudgetSnapshot) => Error,
): ByteBudgetSnapshot => {
  if (typeof createError !== 'function') {
    throw new TypeError('createError must be a function');
  }
  const snapshot = byteBudgetSnapshot(actualBytes, limitBytes);
  if (snapshot.exceeded) throw createError(snapshot);
  return snapshot;
};

export const estimateScalarByteLength = (value: unknown): number | null => {
  if (typeof value === 'string') return utf8ByteLength(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return utf8ByteLength(String(value));
    return utf8ByteLength(String(value));
  }
  if (typeof value === 'boolean') return value ? 4 : 5;
  if (typeof value === 'bigint') return utf8ByteLength(value.toString());
  if (value === null || value === undefined) return 0;
  return null;
};
