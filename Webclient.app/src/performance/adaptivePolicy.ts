import type { PerformanceReadinessReport } from './contracts';
import { boundedInteger, finiteNumber } from './normalization';

export type RuntimePerformanceTier = 'economy' | 'balanced' | 'full';

export interface AdaptiveRuntimePolicy {
  readonly tier: RuntimePerformanceTier;
  readonly reasons: readonly string[];
  readonly maxConcurrentWork: number;
  readonly prefetch: boolean;
  readonly animations: boolean;
  readonly highCost3dEffects: boolean;
  readonly maxClientRecords: number;
  readonly recommendedDebounceMs: number;
}

export interface AdaptiveRuntimePolicyInput {
  readonly report: PerformanceReadinessReport;
  readonly hardwareConcurrency?: unknown;
  readonly deviceMemoryGb?: unknown;
}

const effectiveTypeWeight = (value: string | null | undefined): number => {
  const type = (value ?? '').toLowerCase();
  if (type === 'slow-2g' || type === '2g') return 3;
  if (type === '3g') return 2;
  if (type === '4g') return 0;
  return 1;
};

export const createAdaptiveRuntimePolicy = (
  input: AdaptiveRuntimePolicyInput,
): AdaptiveRuntimePolicy => {
  const { report } = input;
  const network = report.evidence.monitor.network;
  const memory = report.evidence.monitor.memory;
  const hardwareConcurrency = boundedInteger(input.hardwareConcurrency, 1, 64, 4);
  const deviceMemoryGb = Math.max(0, finiteNumber(input.deviceMemoryGb, 0) ?? 0);
  const reasons: string[] = [];

  let pressure = 0;
  if (report.level === 'block') {
    pressure += 4;
    reasons.push('runtime-budget-blocked');
  } else if (report.level === 'warning') {
    pressure += 2;
    reasons.push('runtime-budget-warning');
  }

  const connectionPressure = effectiveTypeWeight(network?.effectiveType);
  if (connectionPressure > 0) {
    pressure += connectionPressure;
    reasons.push(`network-${network?.effectiveType ?? 'unknown'}`);
  }
  if (network?.saveData) {
    pressure += 3;
    reasons.push('save-data');
  }
  if ((network?.rttMs ?? 0) > 500) {
    pressure += 2;
    reasons.push('high-rtt');
  }
  if ((memory?.utilization ?? 0) >= 0.8) {
    pressure += 3;
    reasons.push('heap-pressure');
  } else if ((memory?.utilization ?? 0) >= 0.65) {
    pressure += 1;
    reasons.push('heap-warning');
  }
  if (hardwareConcurrency <= 2) {
    pressure += 2;
    reasons.push('low-core-count');
  } else if (hardwareConcurrency <= 4) {
    pressure += 1;
    reasons.push('mid-core-count');
  }
  if (deviceMemoryGb > 0 && deviceMemoryGb <= 2) {
    pressure += 2;
    reasons.push('low-device-memory');
  }

  const tier: RuntimePerformanceTier = pressure >= 7
    ? 'economy'
    : pressure >= 3
      ? 'balanced'
      : 'full';

  if (tier === 'economy') {
    return Object.freeze({
      tier,
      reasons: Object.freeze(reasons),
      maxConcurrentWork: 2,
      prefetch: false,
      animations: false,
      highCost3dEffects: false,
      maxClientRecords: 5_000,
      recommendedDebounceMs: 350,
    });
  }

  if (tier === 'balanced') {
    return Object.freeze({
      tier,
      reasons: Object.freeze(reasons),
      maxConcurrentWork: Math.min(4, Math.max(2, Math.floor(hardwareConcurrency / 2))),
      prefetch: network?.saveData !== true,
      animations: true,
      highCost3dEffects: false,
      maxClientRecords: 20_000,
      recommendedDebounceMs: 180,
    });
  }

  return Object.freeze({
    tier,
    reasons: Object.freeze(reasons),
    maxConcurrentWork: Math.min(8, Math.max(4, Math.floor(hardwareConcurrency / 2))),
    prefetch: true,
    animations: true,
    highCost3dEffects: true,
    maxClientRecords: 50_000,
    recommendedDebounceMs: 100,
  });
};
