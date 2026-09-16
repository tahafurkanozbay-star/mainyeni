export type RuntimeBudgetProfile = 'conservative' | 'balanced' | 'aggressive';
export type RuntimePressureLevel = 'low' | 'moderate' | 'high' | 'critical';

export interface RuntimeCapabilitySample {
  readonly hardwareConcurrency?: number | null;
  readonly deviceMemoryGb?: number | null;
  readonly effectiveType?: string | null;
  readonly saveData?: boolean | null;
  readonly downlinkMbps?: number | null;
  readonly rttMs?: number | null;
  readonly heapUtilization?: number | null;
  readonly longTaskCount?: number | null;
  readonly longTaskMaxMs?: number | null;
}

export interface RuntimeBudget {
  readonly profile: RuntimeBudgetProfile;
  readonly pressure: RuntimePressureLevel;
  readonly maxConcurrentRequests: number;
  readonly maxConcurrentBackgroundRequests: number;
  readonly maxCachedResponses: number;
  readonly maxVisibleFeatures: number;
  readonly maxBackgroundFeatures: number;
  readonly animationEnabled: boolean;
  readonly prefetchEnabled: boolean;
  readonly expensiveEffectsEnabled: boolean;
  readonly snapshotIntervalMs: number;
  readonly reasons: readonly string[];
}

const PROFILE_MULTIPLIER: Readonly<Record<RuntimeBudgetProfile, number>> = Object.freeze({
  conservative: 0.75,
  balanced: 1,
  aggressive: 1.25
});

const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.max(minimum, Math.min(maximum, value));

const finite = (value: unknown): number | null => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
};

const normalizeProfile = (value: unknown): RuntimeBudgetProfile => {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'conservative' || normalized === 'aggressive') return normalized;
  return 'balanced';
};

const connectionPenalty = (sample: RuntimeCapabilitySample, reasons: string[]): number => {
  let penalty = 0;
  const effectiveType = String(sample.effectiveType || '').toLowerCase();
  const downlink = finite(sample.downlinkMbps);
  const rtt = finite(sample.rttMs);

  if (sample.saveData === true) {
    penalty += 3;
    reasons.push('save-data');
  }
  if (effectiveType === 'slow-2g' || effectiveType === '2g') {
    penalty += 4;
    reasons.push('slow-network-class');
  } else if (effectiveType === '3g') {
    penalty += 2;
    reasons.push('moderate-network-class');
  }
  if (downlink !== null && downlink < 1.5) {
    penalty += 2;
    reasons.push('low-downlink');
  }
  if (rtt !== null && rtt > 600) {
    penalty += 2;
    reasons.push('high-rtt');
  } else if (rtt !== null && rtt > 250) {
    penalty += 1;
    reasons.push('moderate-rtt');
  }
  return penalty;
};

const hardwarePenalty = (sample: RuntimeCapabilitySample, reasons: string[]): number => {
  let penalty = 0;
  const cores = finite(sample.hardwareConcurrency);
  const memory = finite(sample.deviceMemoryGb);

  if (cores !== null && cores <= 2) {
    penalty += 3;
    reasons.push('low-cpu-concurrency');
  } else if (cores !== null && cores <= 4) {
    penalty += 1;
    reasons.push('moderate-cpu-concurrency');
  }

  if (memory !== null && memory <= 2) {
    penalty += 3;
    reasons.push('low-device-memory');
  } else if (memory !== null && memory <= 4) {
    penalty += 1;
    reasons.push('moderate-device-memory');
  }
  return penalty;
};

const runtimePenalty = (sample: RuntimeCapabilitySample, reasons: string[]): number => {
  let penalty = 0;
  const heap = finite(sample.heapUtilization);
  const longTaskCount = finite(sample.longTaskCount);
  const longTaskMaxMs = finite(sample.longTaskMaxMs);

  if (heap !== null && heap >= 0.9) {
    penalty += 4;
    reasons.push('critical-heap-pressure');
  } else if (heap !== null && heap >= 0.75) {
    penalty += 2;
    reasons.push('high-heap-pressure');
  }

  if (longTaskCount !== null && longTaskCount >= 20) {
    penalty += 2;
    reasons.push('frequent-long-tasks');
  } else if (longTaskCount !== null && longTaskCount >= 8) {
    penalty += 1;
    reasons.push('elevated-long-tasks');
  }

  if (longTaskMaxMs !== null && longTaskMaxMs >= 400) {
    penalty += 2;
    reasons.push('severe-main-thread-stall');
  } else if (longTaskMaxMs !== null && longTaskMaxMs >= 200) {
    penalty += 1;
    reasons.push('main-thread-stall');
  }
  return penalty;
};

const pressureFromPenalty = (penalty: number): RuntimePressureLevel => {
  if (penalty >= 9) return 'critical';
  if (penalty >= 6) return 'high';
  if (penalty >= 3) return 'moderate';
  return 'low';
};

const baseConcurrency = (sample: RuntimeCapabilitySample): number => {
  const cores = finite(sample.hardwareConcurrency);
  if (cores === null) return 6;
  if (cores <= 2) return 3;
  if (cores <= 4) return 5;
  if (cores <= 8) return 8;
  return 10;
};

const baseFeatureBudget = (sample: RuntimeCapabilitySample): number => {
  const memory = finite(sample.deviceMemoryGb);
  if (memory === null) return 12000;
  if (memory <= 2) return 4000;
  if (memory <= 4) return 8000;
  if (memory <= 8) return 16000;
  return 24000;
};

const pressureMultiplier = (pressure: RuntimePressureLevel): number => {
  switch (pressure) {
    case 'critical': return 0.35;
    case 'high': return 0.55;
    case 'moderate': return 0.75;
    default: return 1;
  }
};

export const deriveRuntimeBudget = (
  sample: RuntimeCapabilitySample = {},
  profileValue: RuntimeBudgetProfile = 'balanced'
): RuntimeBudget => {
  const profile = normalizeProfile(profileValue);
  const reasons: string[] = [];
  const penalty = connectionPenalty(sample, reasons)
    + hardwarePenalty(sample, reasons)
    + runtimePenalty(sample, reasons);
  const pressure = pressureFromPenalty(penalty);
  const multiplier = PROFILE_MULTIPLIER[profile] * pressureMultiplier(pressure);
  const concurrency = clamp(Math.round(baseConcurrency(sample) * multiplier), 2, 12);
  const visibleFeatures = clamp(Math.round(baseFeatureBudget(sample) * multiplier), 1500, 30000);
  const backgroundFeatures = clamp(Math.round(visibleFeatures * 0.5), 750, 12000);
  const cachedResponses = clamp(Math.round(120 * multiplier), 24, 240);

  const constrained = pressure === 'high' || pressure === 'critical' || sample.saveData === true;
  const critical = pressure === 'critical';

  return Object.freeze({
    profile,
    pressure,
    maxConcurrentRequests: concurrency,
    maxConcurrentBackgroundRequests: clamp(Math.floor(concurrency / 2), 1, 5),
    maxCachedResponses: cachedResponses,
    maxVisibleFeatures: visibleFeatures,
    maxBackgroundFeatures: backgroundFeatures,
    animationEnabled: !critical,
    prefetchEnabled: !constrained,
    expensiveEffectsEnabled: pressure === 'low' && sample.saveData !== true,
    snapshotIntervalMs: critical ? 3000 : constrained ? 5000 : 10000,
    reasons: Object.freeze(Array.from(new Set(reasons)))
  });
};

export const mergeRuntimeCapabilitySamples = (
  ...samples: readonly RuntimeCapabilitySample[]
): RuntimeCapabilitySample => {
  const merged: Record<string, unknown> = {};
  samples.forEach((sample) => {
    if (!sample || typeof sample !== 'object') return;
    Object.entries(sample).forEach(([key, value]) => {
      if (value !== null && value !== undefined) merged[key] = value;
    });
  });
  return Object.freeze(merged) as RuntimeCapabilitySample;
};

export const shouldDegradeRuntime = (budget: RuntimeBudget): boolean =>
  budget.pressure === 'high' || budget.pressure === 'critical';

export const runtimeBudgetSummary = (budget: RuntimeBudget) => Object.freeze({
  profile: budget.profile,
  pressure: budget.pressure,
  requestConcurrency: budget.maxConcurrentRequests,
  backgroundConcurrency: budget.maxConcurrentBackgroundRequests,
  visibleFeatures: budget.maxVisibleFeatures,
  cacheEntries: budget.maxCachedResponses,
  animationEnabled: budget.animationEnabled,
  prefetchEnabled: budget.prefetchEnabled,
  reasons: budget.reasons
});
