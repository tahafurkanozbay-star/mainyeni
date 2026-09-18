export interface TouchViewportEnvironment {
  readonly width: number;
  readonly matchesCoarsePointer: boolean;
}

const browserTouchEnvironment = (): TouchViewportEnvironment => ({
  width: typeof window === 'undefined' ? Number.POSITIVE_INFINITY : window.innerWidth,
  matchesCoarsePointer: typeof window !== 'undefined'
    && window.matchMedia?.('(pointer: coarse)').matches === true,
});

export const normalizeCommandQuery = (value: unknown): string =>
  String(value ?? '')
    .toLocaleLowerCase('tr-TR')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/gu, '')
    .replace(/ı/gu, 'i')
    .replace(/\s+/gu, ' ')
    .trim();

export const isTouchViewport = (
  environment: TouchViewportEnvironment = browserTouchEnvironment(),
): boolean => {
  const width = Number(environment.width);
  return environment.matchesCoarsePointer === true
    || (Number.isFinite(width) && width < 768);
};

export const clamp = (
  value: unknown,
  minimum: number,
  maximum: number,
): number => {
  if (!Number.isFinite(minimum) || !Number.isFinite(maximum)) {
    throw new TypeError('Clamp bounds must be finite.');
  }
  if (maximum < minimum) {
    throw new RangeError('Clamp maximum cannot be lower than minimum.');
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return minimum;
  return Math.min(maximum, Math.max(minimum, numeric));
};
