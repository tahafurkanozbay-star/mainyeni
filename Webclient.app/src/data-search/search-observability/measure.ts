import type {
  MeasuredOperation,
  MeasureOperationOptions,
} from './contracts';

export const measureAsyncOperation = async <T>(
  operation: () => T | Promise<T>,
  options: MeasureOperationOptions = {},
): Promise<MeasuredOperation<T>> => {
  if (typeof operation !== 'function') {
    throw new TypeError('Measured operation must be a function');
  }
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const startedAt = now();
  try {
    const value = await operation();
    return {
      value,
      durationMs: Math.max(0, now() - startedAt),
      error: null,
    };
  } catch (error) {
    return {
      value: undefined,
      durationMs: Math.max(0, now() - startedAt),
      error,
    };
  }
};
