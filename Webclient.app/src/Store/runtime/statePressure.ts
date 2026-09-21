import {
  normalizeStoreRuntimeLimits,
  type StoreRuntimeLimits,
  type StoreRuntimeSnapshot,
} from './contracts';

export type StorePressureLevel = 'normal' | 'elevated' | 'critical';

export interface StorePressureMetric {
  readonly name: string;
  readonly current: number;
  readonly limit: number;
  readonly ratio: number;
  readonly level: StorePressureLevel;
}

export interface StorePressureAssessment {
  readonly level: StorePressureLevel;
  readonly metrics: readonly StorePressureMetric[];
  readonly elevated: readonly string[];
  readonly critical: readonly string[];
}

const levelFor = (ratio: number): StorePressureLevel => {
  if (ratio >= 0.9) return 'critical';
  if (ratio >= 0.7) return 'elevated';
  return 'normal';
};

const metric = (
  name: string,
  currentInput: number,
  limitInput: number,
): StorePressureMetric => {
  const current = Math.max(0, Number.isFinite(currentInput) ? currentInput : 0);
  const limit = Math.max(1, Number.isFinite(limitInput) ? limitInput : 1);
  const ratio = current / limit;
  return Object.freeze({
    name,
    current,
    limit,
    ratio,
    level: levelFor(ratio),
  });
};

export const assessStorePressure = (
  snapshot: StoreRuntimeSnapshot,
  limitsInput: Partial<StoreRuntimeLimits> | StoreRuntimeLimits = {},
): StorePressureAssessment => {
  const limits = normalizeStoreRuntimeLimits(limitsInput);
  const projection = snapshot.projection;
  const metrics = Object.freeze([
    metric('history', snapshot.health.historyRetained, limits.maxHistoryEntries),
    metric('subscribers', snapshot.health.subscriberCount, limits.maxSubscribers),
    metric('windows', projection?.common.windows.length ?? 0, limits.maxWindows),
    metric('graphics', projection?.map.graphicsCount ?? 0, limits.maxGraphics),
    metric('dynamicLayers', projection?.dynamicLayers.count ?? 0, limits.maxDynamicLayers),
    metric('services', projection?.common.services.length ?? 0, limits.maxServices),
  ]);
  const elevated = Object.freeze(
    metrics.filter((item) => item.level === 'elevated').map((item) => item.name),
  );
  const critical = Object.freeze(
    metrics.filter((item) => item.level === 'critical').map((item) => item.name),
  );
  const level: StorePressureLevel = critical.length > 0
    ? 'critical'
    : elevated.length > 0
      ? 'elevated'
      : 'normal';

  return Object.freeze({
    level,
    metrics,
    elevated,
    critical,
  });
};
