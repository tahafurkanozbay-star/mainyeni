import { useEffect, useState } from 'react';

export const normalizeDebounceDelay = (delayMs: unknown): number => {
  const parsed = Number(delayMs);
  if (!Number.isFinite(parsed)) return 0;
  return Math.min(60_000, Math.max(0, Math.trunc(parsed)));
};

export const useDebounce = <T>(value: T, delayMs: number): readonly [T] => {
  const [debouncedValue, setDebouncedValue] = useState<T>(value);
  const delay = normalizeDebounceDelay(delayMs);
  useEffect(() => {
    const timeoutId = window.setTimeout(() => setDebouncedValue(value), delay);
    return () => window.clearTimeout(timeoutId);
  }, [delay, value]);
  return Object.freeze([debouncedValue]) as readonly [T];
};
