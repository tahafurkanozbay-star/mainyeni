import type { RuntimeBudget } from './contracts';
import type { AdmissionPolicy } from './admissionController';
import type { RuntimePressureLevel } from './pressureController';

export type CapacityLane =
  | 'interactive'
  | 'foreground'
  | 'default'
  | 'background'
  | 'prefetch'
  | 'maintenance';

export interface CapacityDemand {
  readonly queueDepth: number;
  readonly queueCapacity: number;
  readonly active: number;
  readonly activeCapacity: number;
  readonly activeCost: number;
  readonly costCapacity: number;
  readonly online?: boolean;
  readonly saveData?: boolean;
  readonly reducedMotion?: boolean;
}

export interface CapacityLanePolicy {
  readonly lane: CapacityLane;
  readonly maxActive: number;
  readonly maxQueued: number;
  readonly reservedActive: number;
  readonly priorityBias: number;
  readonly enabled: boolean;
}

export interface CapacityEnvelope {
  readonly pressure: RuntimePressureLevel;
  readonly pressureFactor: number;
  readonly demandFactor: number;
  readonly effectiveFactor: number;
  readonly maxActive: number;
  readonly maxQueued: number;
  readonly maxCost: number;
  readonly maxQueueAgeMs: number;
  readonly lanes: Readonly<Record<CapacityLane, CapacityLanePolicy>>;
  readonly admission: AdmissionPolicy;
  readonly derivedBudget: RuntimeBudget;
  readonly reasons: readonly string[];
}

export interface CapacityEnvelopePolicy {
  readonly nominalFactor: number;
  readonly elevatedFactor: number;
  readonly highFactor: number;
  readonly criticalFactor: number;
  readonly queueSoftLimit: number;
  readonly queueHardLimit: number;
  readonly activeSoftLimit: number;
  readonly activeHardLimit: number;
  readonly costSoftLimit: number;
  readonly costHardLimit: number;
  readonly queueAgeMs: number;
  readonly laneWeights: Readonly<Record<CapacityLane, number>>;
  readonly laneQueueWeights: Readonly<Record<CapacityLane, number>>;
  readonly laneReserveWeights: Readonly<Record<CapacityLane, number>>;
}

export interface CapacityEnvelopePlannerOptions {
  readonly policy?: Partial<CapacityEnvelopePolicy>;
  readonly minimumActive?: number;
  readonly minimumQueued?: number;
  readonly minimumCost?: number;
}

export interface CapacityEnvelopePlanner {
  readonly plan: (pressure: RuntimePressureLevel, demand: CapacityDemand) => CapacityEnvelope;
  readonly snapshot: () => CapacityEnvelope;
  readonly reset: () => CapacityEnvelope;
}

const DEFAULT_LANE_WEIGHTS: Readonly<Record<CapacityLane, number>> = Object.freeze({
  interactive: 0.34,
  foreground: 0.25,
  default: 0.18,
  background: 0.1,
  prefetch: 0.07,
  maintenance: 0.06,
});

const DEFAULT_LANE_QUEUE_WEIGHTS: Readonly<Record<CapacityLane, number>> = Object.freeze({
  interactive: 0.18,
  foreground: 0.2,
  default: 0.22,
  background: 0.16,
  prefetch: 0.14,
  maintenance: 0.1,
});

const DEFAULT_LANE_RESERVE_WEIGHTS: Readonly<Record<CapacityLane, number>> = Object.freeze({
  interactive: 0.5,
  foreground: 0.3,
  default: 0.2,
  background: 0,
  prefetch: 0,
  maintenance: 0,
});

const DEFAULT_POLICY: CapacityEnvelopePolicy = Object.freeze({
  nominalFactor: 1,
  elevatedFactor: 0.82,
  highFactor: 0.62,
  criticalFactor: 0.4,
  queueSoftLimit: 0.6,
  queueHardLimit: 0.92,
  activeSoftLimit: 0.7,
  activeHardLimit: 0.95,
  costSoftLimit: 0.68,
  costHardLimit: 0.94,
  queueAgeMs: 30_000,
  laneWeights: DEFAULT_LANE_WEIGHTS,
  laneQueueWeights: DEFAULT_LANE_QUEUE_WEIGHTS,
  laneReserveWeights: DEFAULT_LANE_RESERVE_WEIGHTS,
});

const LANES: readonly CapacityLane[] = Object.freeze([
  'interactive',
  'foreground',
  'default',
  'background',
  'prefetch',
  'maintenance',
]);

const finite = (value: number, fallback = 0): number =>
  Number.isFinite(value) ? Number(value) : fallback;

const positiveInt = (value: number, fallback: number, minimum = 1): number => {
  const normalized = Math.floor(finite(value, fallback));
  return Math.max(minimum, normalized);
};

const ratio = (value: number, capacity: number): number => {
  if (!Number.isFinite(value) || !Number.isFinite(capacity) || capacity <= 0) return 0;
  return Math.max(0, Math.min(1.5, value / capacity));
};


const pressureFactor = (level: RuntimePressureLevel, policy: CapacityEnvelopePolicy): number => {
  if (level === 'critical') return policy.criticalFactor;
  if (level === 'high') return policy.highFactor;
  if (level === 'elevated') return policy.elevatedFactor;
  return policy.nominalFactor;
};

const pressureRank: Readonly<Record<RuntimePressureLevel, number>> = Object.freeze({
  nominal: 0,
  elevated: 1,
  high: 2,
  critical: 3,
});

const interpolatePressure = (
  utilization: number,
  softLimit: number,
  hardLimit: number,
): number => {
  if (utilization <= softLimit) return 1;
  if (utilization >= hardLimit) return 0.45;
  const span = Math.max(0.001, hardLimit - softLimit);
  const progress = (utilization - softLimit) / span;
  return 1 - progress * 0.55;
};

const demandFactorFor = (demand: CapacityDemand, policy: CapacityEnvelopePolicy): number => {
  const queue = interpolatePressure(
    ratio(demand.queueDepth, demand.queueCapacity),
    policy.queueSoftLimit,
    policy.queueHardLimit,
  );
  const active = interpolatePressure(
    ratio(demand.active, demand.activeCapacity),
    policy.activeSoftLimit,
    policy.activeHardLimit,
  );
  const cost = interpolatePressure(
    ratio(demand.activeCost, demand.costCapacity),
    policy.costSoftLimit,
    policy.costHardLimit,
  );
  return Math.max(0.35, Math.min(queue, active, cost));
};

const normalizedWeights = <TKey extends string>(
  source: Readonly<Record<TKey, number>>,
): Readonly<Record<TKey, number>> => {
  const entries = Object.entries(source) as Array<[TKey, number]>;
  const sum = entries.reduce((total, [, value]) => total + Math.max(0, finite(value)), 0);
  if (sum <= 0) {
    const equal = 1 / Math.max(1, entries.length);
    return Object.freeze(Object.fromEntries(entries.map(([key]) => [key, equal])) as Record<TKey, number>);
  }
  return Object.freeze(Object.fromEntries(
    entries.map(([key, value]) => [key, Math.max(0, finite(value)) / sum]),
  ) as Record<TKey, number>);
};

const laneEnabled = (
  lane: CapacityLane,
  pressure: RuntimePressureLevel,
  demand: CapacityDemand,
): boolean => {
  const background = lane === 'background' || lane === 'prefetch' || lane === 'maintenance';
  if (pressure === 'critical' && background) return false;
  if (lane === 'prefetch' && (demand.online === false || demand.saveData === true)) return false;
  return true;
};

const allocateLaneCapacity = (
  total: number,
  weights: Readonly<Record<CapacityLane, number>>,
  enabled: ReadonlySet<CapacityLane>,
): Readonly<Record<CapacityLane, number>> => {
  const capacity = Math.max(0, Math.floor(total));
  const allocations = Object.fromEntries(LANES.map((lane) => [lane, 0])) as Record<CapacityLane, number>;
  const lanes = LANES.filter((lane) => enabled.has(lane));
  if (capacity === 0 || lanes.length === 0) return Object.freeze(allocations);

  const weightTotal = lanes.reduce((sum, lane) => sum + Math.max(0, finite(weights[lane])), 0);
  const equalShare = 1 / lanes.length;
  const ranked = lanes.map((lane, order) => {
    const share = weightTotal > 0 ? Math.max(0, finite(weights[lane])) / weightTotal : equalShare;
    const exact = capacity * share;
    const floor = Math.floor(exact);
    allocations[lane] = floor;
    return { lane, order, remainder: exact - floor };
  });

  let remaining = capacity - lanes.reduce((sum, lane) => sum + allocations[lane], 0);
  ranked.sort((left, right) => right.remainder - left.remainder || left.order - right.order);
  for (let index = 0; remaining > 0 && ranked.length > 0; index += 1, remaining -= 1) {
    const candidate = ranked[index % ranked.length];
    if (candidate) allocations[candidate.lane] += 1;
  }

  return Object.freeze(allocations);
};

const normalizedPolicy = (overrides: Partial<CapacityEnvelopePolicy> = {}): CapacityEnvelopePolicy => {
  const factor = (value: number | undefined, fallback: number): number =>
    Math.max(0.2, Math.min(1, finite(value ?? fallback, fallback)));
  const threshold = (value: number | undefined, fallback: number): number =>
    Math.max(0.05, Math.min(1.5, finite(value ?? fallback, fallback)));
  return Object.freeze({
    nominalFactor: factor(overrides.nominalFactor, DEFAULT_POLICY.nominalFactor),
    elevatedFactor: factor(overrides.elevatedFactor, DEFAULT_POLICY.elevatedFactor),
    highFactor: factor(overrides.highFactor, DEFAULT_POLICY.highFactor),
    criticalFactor: factor(overrides.criticalFactor, DEFAULT_POLICY.criticalFactor),
    queueSoftLimit: threshold(overrides.queueSoftLimit, DEFAULT_POLICY.queueSoftLimit),
    queueHardLimit: threshold(overrides.queueHardLimit, DEFAULT_POLICY.queueHardLimit),
    activeSoftLimit: threshold(overrides.activeSoftLimit, DEFAULT_POLICY.activeSoftLimit),
    activeHardLimit: threshold(overrides.activeHardLimit, DEFAULT_POLICY.activeHardLimit),
    costSoftLimit: threshold(overrides.costSoftLimit, DEFAULT_POLICY.costSoftLimit),
    costHardLimit: threshold(overrides.costHardLimit, DEFAULT_POLICY.costHardLimit),
    queueAgeMs: positiveInt(overrides.queueAgeMs ?? DEFAULT_POLICY.queueAgeMs, DEFAULT_POLICY.queueAgeMs),
    laneWeights: normalizedWeights({ ...DEFAULT_POLICY.laneWeights, ...overrides.laneWeights }),
    laneQueueWeights: normalizedWeights({ ...DEFAULT_POLICY.laneQueueWeights, ...overrides.laneQueueWeights }),
    laneReserveWeights: normalizedWeights({ ...DEFAULT_POLICY.laneReserveWeights, ...overrides.laneReserveWeights }),
  });
};

const scaled = (value: number, factor: number, minimum: number): number =>
  Math.max(minimum, Math.floor(Math.max(0, value) * factor));

const lanePolicy = (
  lane: CapacityLane,
  laneActive: number,
  laneQueued: number,
  maxActive: number,
  enabled: boolean,
  policy: CapacityEnvelopePolicy,
): CapacityLanePolicy => {
  const reserveShare = policy.laneReserveWeights[lane];
  const background = lane === 'background' || lane === 'prefetch' || lane === 'maintenance';
  const reservedActive = enabled && !background
    ? Math.min(laneActive, Math.max(0, Math.floor(maxActive * reserveShare)))
    : 0;
  const priorityBias = lane === 'interactive'
    ? -30
    : lane === 'foreground'
      ? -20
      : lane === 'default'
        ? -10
        : lane === 'maintenance'
          ? 20
          : 10;
  return Object.freeze({
    lane,
    maxActive: laneActive,
    maxQueued: laneQueued,
    reservedActive,
    priorityBias,
    enabled,
  });
};

const derivedBudgetFor = (
  base: RuntimeBudget,
  factor: number,
  demand: CapacityDemand,
): RuntimeBudget => {
  const dataFactor = demand.saveData ? Math.min(factor, 0.7) : factor;
  const renderFactor = demand.reducedMotion ? Math.min(factor, 0.75) : factor;
  return Object.freeze({
    ...base,
    maxConcurrentNetwork: scaled(base.maxConcurrentNetwork, dataFactor, 1),
    maxConcurrentCpu: scaled(base.maxConcurrentCpu, factor, 1),
    maxQueuedTasks: scaled(base.maxQueuedTasks, factor, 8),
    maxCacheEntries: scaled(base.maxCacheEntries, dataFactor, 16),
    maxCacheBytes: scaled(base.maxCacheBytes, dataFactor, 1024 * 1024),
    maxVisibleFeatures2d: scaled(base.maxVisibleFeatures2d, renderFactor, 250),
    maxVisibleFeatures3d: scaled(base.maxVisibleFeatures3d, renderFactor, 100),
    maxGpuHeavyLayers: scaled(base.maxGpuHeavyLayers, renderFactor, 1),
    frameBudgetMs: base.frameBudgetMs,
    backgroundSliceMs: scaled(base.backgroundSliceMs, factor, 1),
    telemetryCapacity: scaled(base.telemetryCapacity, factor, 50),
  });
};

const reasonsFor = (
  pressure: RuntimePressureLevel,
  demand: CapacityDemand,
  policy: CapacityEnvelopePolicy,
): readonly string[] => {
  const reasons: string[] = [];
  if (pressure !== 'nominal') reasons.push(`pressure:${pressure}`);
  if (ratio(demand.queueDepth, demand.queueCapacity) >= policy.queueSoftLimit) reasons.push('queue');
  if (ratio(demand.active, demand.activeCapacity) >= policy.activeSoftLimit) reasons.push('active');
  if (ratio(demand.activeCost, demand.costCapacity) >= policy.costSoftLimit) reasons.push('cost');
  if (demand.online === false) reasons.push('offline');
  if (demand.saveData === true) reasons.push('save-data');
  if (demand.reducedMotion === true) reasons.push('reduced-motion');
  return Object.freeze(reasons);
};

export const createCapacityEnvelopePlanner = (
  baseBudget: RuntimeBudget,
  options: CapacityEnvelopePlannerOptions = {},
): CapacityEnvelopePlanner => {
  const policy = normalizedPolicy(options.policy);
  const minimumActive = positiveInt(options.minimumActive ?? 2, 2);
  const minimumQueued = positiveInt(options.minimumQueued ?? 8, 8);
  const minimumCost = positiveInt(options.minimumCost ?? 4, 4);

  const create = (pressure: RuntimePressureLevel, demand: CapacityDemand): CapacityEnvelope => {
    const pFactor = pressureFactor(pressure, policy);
    const dFactor = demandFactorFor(demand, policy);
    const networkFactor = demand.online === false ? Math.min(pFactor, 0.3) : pFactor;
    const effectiveFactor = Math.max(0.2, Math.min(networkFactor, dFactor));
    const maxActive = scaled(
      baseBudget.maxConcurrentNetwork + baseBudget.maxConcurrentCpu,
      effectiveFactor,
      minimumActive,
    );
    const maxQueued = scaled(baseBudget.maxQueuedTasks, effectiveFactor, minimumQueued);
    const maxCost = scaled(
      baseBudget.maxConcurrentNetwork + baseBudget.maxConcurrentCpu * 2,
      effectiveFactor,
      minimumCost,
    );
    const enabledLanes = new Set(
      LANES.filter((lane) => laneEnabled(lane, pressure, demand)),
    );
    const activeAllocation = allocateLaneCapacity(maxActive, policy.laneWeights, enabledLanes);
    const queueAllocation = allocateLaneCapacity(maxQueued, policy.laneQueueWeights, enabledLanes);
    const lanes = Object.fromEntries(
      LANES.map((lane) => [
        lane,
        lanePolicy(
          lane,
          activeAllocation[lane],
          queueAllocation[lane],
          maxActive,
          enabledLanes.has(lane),
          policy,
        ),
      ]),
    ) as Record<CapacityLane, CapacityLanePolicy>;
    const laneMaxActive = Object.fromEntries(
      LANES.map((lane) => [lane, lanes[lane].enabled ? lanes[lane].maxActive : 0]),
    );
    const laneMaxQueued = Object.fromEntries(
      LANES.map((lane) => [lane, lanes[lane].enabled ? lanes[lane].maxQueued : 0]),
    );
    const admission: AdmissionPolicy = Object.freeze({
      maxActive,
      maxQueued,
      maxCost,
      maxQueueAgeMs: policy.queueAgeMs,
      laneMaxActive: Object.freeze(laneMaxActive),
      laneMaxQueued: Object.freeze(laneMaxQueued),
    });
    return Object.freeze({
      pressure,
      pressureFactor: pFactor,
      demandFactor: dFactor,
      effectiveFactor,
      maxActive,
      maxQueued,
      maxCost,
      maxQueueAgeMs: policy.queueAgeMs,
      lanes: Object.freeze(lanes),
      admission,
      derivedBudget: derivedBudgetFor(baseBudget, effectiveFactor, demand),
      reasons: reasonsFor(pressure, demand, policy),
    });
  };

  const baselineDemand: CapacityDemand = Object.freeze({
    queueDepth: 0,
    queueCapacity: Math.max(1, baseBudget.maxQueuedTasks),
    active: 0,
    activeCapacity: Math.max(1, baseBudget.maxConcurrentNetwork + baseBudget.maxConcurrentCpu),
    activeCost: 0,
    costCapacity: Math.max(1, baseBudget.maxConcurrentNetwork + baseBudget.maxConcurrentCpu * 2),
    online: true,
    saveData: false,
    reducedMotion: false,
  });
  let current = create('nominal', baselineDemand);

  const plan = (pressure: RuntimePressureLevel, demand: CapacityDemand): CapacityEnvelope => {
    current = create(pressure, demand);
    return current;
  };

  const reset = (): CapacityEnvelope => {
    current = create('nominal', baselineDemand);
    return current;
  };

  return Object.freeze({ plan, snapshot: () => current, reset });
};

export const compareCapacityPressure = (
  left: RuntimePressureLevel,
  right: RuntimePressureLevel,
): number => pressureRank[left] - pressureRank[right];
