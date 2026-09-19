export type CachePressureLevel = 'healthy' | 'elevated' | 'high' | 'critical';

export interface CachePressureInput {
  readonly entries: number;
  readonly bytes: number;
  readonly maxEntries: number;
  readonly maxBytes: number;
  readonly staleEntries?: number;
}

export interface CachePressureDecision {
  readonly level: CachePressureLevel;
  readonly entryRatio: number;
  readonly byteRatio: number;
  readonly dominantRatio: number;
  readonly targetEntryCount: number;
  readonly targetByteCount: number;
  readonly pruneRecommended: boolean;
  readonly suppressWarmup: boolean;
}

export const evaluateCachePressure = (
  input: CachePressureInput,
): CachePressureDecision => {
  validateCount('entries', input.entries);
  validateCount('bytes', input.bytes);
  validateMaximum('maxEntries', input.maxEntries);
  validateMaximum('maxBytes', input.maxBytes);
  const staleEntries = input.staleEntries ?? 0;
  validateCount('staleEntries', staleEntries);
  if (input.entries > input.maxEntries) throw new RangeError('entries exceed maxEntries');
  if (input.bytes > input.maxBytes) throw new RangeError('bytes exceed maxBytes');
  if (staleEntries > input.entries) throw new RangeError('staleEntries exceed entries');

  const entryRatio = ratio(input.entries, input.maxEntries);
  const byteRatio = ratio(input.bytes, input.maxBytes);
  const dominantRatio = Math.max(entryRatio, byteRatio);
  const level = pressureLevel(dominantRatio);
  const targetRatio = level === 'critical'
    ? 0.70
    : level === 'high'
      ? 0.78
      : level === 'elevated'
        ? 0.86
        : 0.92;

  return Object.freeze({
    level,
    entryRatio,
    byteRatio,
    dominantRatio,
    targetEntryCount: Math.floor(input.maxEntries * targetRatio),
    targetByteCount: Math.floor(input.maxBytes * targetRatio),
    pruneRecommended: level !== 'healthy' || staleEntries > Math.ceil(input.entries * 0.25),
    suppressWarmup: level === 'high' || level === 'critical',
  });
};

export const pressureEvictionCount = (
  decision: CachePressureDecision,
  currentEntries: number,
): number => {
  validateCount('currentEntries', currentEntries);
  return Math.max(0, currentEntries - decision.targetEntryCount);
};

const pressureLevel = (ratioValue: number): CachePressureLevel => {
  if (ratioValue >= 0.95) return 'critical';
  if (ratioValue >= 0.85) return 'high';
  if (ratioValue >= 0.70) return 'elevated';
  return 'healthy';
};

const ratio = (value: number, maximum: number): number =>
  maximum === 0 ? 0 : Math.min(1, value / maximum);

const validateCount = (name: string, value: number): void => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(name + ' must be a non-negative safe integer');
  }
};

const validateMaximum = (name: string, value: number): void => {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(name + ' must be a positive safe integer');
  }
};
