import { clampNumber, type ResourceBudgetSnapshot, type RuntimeBudget } from './contracts';
import { budgetPressure } from './resourceBudget';

export type RuntimePressureLevel = 'nominal' | 'elevated' | 'high' | 'critical';

export interface RuntimePressureSample {
  readonly at: number;
  readonly queueDepth: number;
  readonly queueCapacity: number;
  readonly p95LatencyMs: number;
  readonly targetLatencyMs: number;
  readonly failureRate: number;
  readonly frameTimeMs: number | null;
  readonly frameBudgetMs: number;
  readonly resourceSnapshot: ResourceBudgetSnapshot;
}

export interface RuntimePressureWeights {
  readonly queue: number;
  readonly latency: number;
  readonly failures: number;
  readonly frame: number;
  readonly resources: number;
}

export interface RuntimePressurePolicy {
  readonly sampleCapacity: number;
  readonly elevatedThreshold: number;
  readonly highThreshold: number;
  readonly criticalThreshold: number;
  readonly recoveryThreshold: number;
  readonly recoverySamples: number;
  readonly weights: RuntimePressureWeights;
}

export interface RuntimePressureDecision {
  readonly level: RuntimePressureLevel;
  readonly score: number;
  readonly previousLevel: RuntimePressureLevel;
  readonly changed: boolean;
  readonly recoveryStreak: number;
  readonly budget: RuntimeBudget;
  readonly reasons: readonly string[];
}

export interface RuntimePressureController {
  readonly record: (sample: RuntimePressureSample) => RuntimePressureDecision;
  readonly snapshot: () => RuntimePressureDecision;
  readonly history: () => readonly RuntimePressureDecision[];
  readonly reset: () => void;
}

const DEFAULT_POLICY: RuntimePressurePolicy = Object.freeze({
  sampleCapacity: 48,
  elevatedThreshold: 0.48,
  highThreshold: 0.68,
  criticalThreshold: 0.84,
  recoveryThreshold: 0.38,
  recoverySamples: 4,
  weights: Object.freeze({ queue: 0.24, latency: 0.2, failures: 0.18, frame: 0.16, resources: 0.22 }),
});

const LEVEL_RANK: Readonly<Record<RuntimePressureLevel, number>> = Object.freeze({ nominal: 0, elevated: 1, high: 2, critical: 3 });
const LEVELS: readonly RuntimePressureLevel[] = Object.freeze(['nominal', 'elevated', 'high', 'critical']);

const ratio = (value: number, maximum: number): number => maximum <= 0 ? 0 : clampNumber(value / maximum, 0, 1.5, 0);

const resourceScore = (snapshot: ResourceBudgetSnapshot): number => Math.max(
  budgetPressure(snapshot, 'network'),
  budgetPressure(snapshot, 'cpu'),
  budgetPressure(snapshot, 'memory'),
  budgetPressure(snapshot, 'render'),
  budgetPressure(snapshot, 'storage'),
);

const levelFor = (score: number, policy: RuntimePressurePolicy): RuntimePressureLevel => {
  if (score >= policy.criticalThreshold) return 'critical';
  if (score >= policy.highThreshold) return 'high';
  if (score >= policy.elevatedThreshold) return 'elevated';
  return 'nominal';
};

const constrainedBudget = (budget: RuntimeBudget, level: RuntimePressureLevel): RuntimeBudget => {
  const factor = level === 'critical' ? 0.4 : level === 'high' ? 0.58 : level === 'elevated' ? 0.78 : 1;
  const floor = (value: number, minimum = 1): number => Math.max(minimum, Math.floor(value * factor));
  return Object.freeze({
    ...budget,
    maxConcurrentNetwork: floor(budget.maxConcurrentNetwork),
    maxConcurrentCpu: floor(budget.maxConcurrentCpu),
    maxQueuedTasks: floor(budget.maxQueuedTasks, 8),
    maxVisibleFeatures2d: floor(budget.maxVisibleFeatures2d, 250),
    maxVisibleFeatures3d: floor(budget.maxVisibleFeatures3d, 100),
    maxGpuHeavyLayers: floor(budget.maxGpuHeavyLayers),
    backgroundSliceMs: Math.max(2, Math.floor(budget.backgroundSliceMs * factor)),
  });
};

export const createRuntimePressureController = (
  initialBudget: RuntimeBudget,
  overrides: Partial<RuntimePressurePolicy> = {},
): RuntimePressureController => {
  const policy: RuntimePressurePolicy = Object.freeze({ ...DEFAULT_POLICY, ...overrides, weights: Object.freeze({ ...DEFAULT_POLICY.weights, ...overrides.weights }) });
  const decisions: RuntimePressureDecision[] = [];
  let level: RuntimePressureLevel = 'nominal';
  let recoveryStreak = 0;
  let current: RuntimePressureDecision = Object.freeze({ level, score: 0, previousLevel: level, changed: false, recoveryStreak, budget: initialBudget, reasons: Object.freeze([]) });

  const record = (sample: RuntimePressureSample): RuntimePressureDecision => {
    const queue = ratio(sample.queueDepth, sample.queueCapacity);
    const latency = ratio(sample.p95LatencyMs, sample.targetLatencyMs);
    const failures = clampNumber(sample.failureRate, 0, 1, 0);
    const frame = sample.frameTimeMs === null ? 0 : ratio(sample.frameTimeMs, sample.frameBudgetMs);
    const resources = resourceScore(sample.resourceSnapshot);
    const weights = policy.weights;
    const totalWeight = weights.queue + weights.latency + weights.failures + weights.frame + weights.resources;
    const score = clampNumber((queue * weights.queue + latency * weights.latency + failures * weights.failures + frame * weights.frame + resources * weights.resources) / Math.max(totalWeight, 0.001), 0, 1, 0);
    const desired = levelFor(score, policy);
    const previousLevel = level;

    if (LEVEL_RANK[desired] > LEVEL_RANK[level]) {
      level = desired;
      recoveryStreak = 0;
    } else if (LEVEL_RANK[desired] < LEVEL_RANK[level] && score <= policy.recoveryThreshold) {
      recoveryStreak += 1;
      if (recoveryStreak >= policy.recoverySamples) {
        level = LEVELS[Math.max(0, LEVEL_RANK[level] - 1)] ?? 'nominal';
        recoveryStreak = 0;
      }
    } else {
      recoveryStreak = 0;
    }

    const reasons: string[] = [];
    if (queue >= 0.8) reasons.push('queue');
    if (latency >= 1) reasons.push('latency');
    if (failures >= 0.1) reasons.push('failures');
    if (frame >= 1) reasons.push('frame');
    if (resources >= 0.85) reasons.push('resources');
    current = Object.freeze({ level, score, previousLevel, changed: previousLevel !== level, recoveryStreak, budget: constrainedBudget(initialBudget, level), reasons: Object.freeze(reasons) });
    decisions.push(current);
    if (decisions.length > policy.sampleCapacity) decisions.splice(0, decisions.length - policy.sampleCapacity);
    return current;
  };

  const reset = (): void => {
    decisions.length = 0;
    level = 'nominal';
    recoveryStreak = 0;
    current = Object.freeze({ level, score: 0, previousLevel: level, changed: false, recoveryStreak, budget: initialBudget, reasons: Object.freeze([]) });
  };

  return Object.freeze({ record, snapshot: () => current, history: () => Object.freeze([...decisions]), reset });
};
