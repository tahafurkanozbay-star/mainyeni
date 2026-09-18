import type { AdmissionPriority, AdmissionRequest } from './admissionController';
import type { RuntimePressureLevel } from './pressureController';

export interface QueuedRuntimeWork {
  readonly id: string;
  readonly key: string;
  readonly lane: string;
  readonly priority: AdmissionPriority;
  readonly cost: number;
  readonly enqueuedAt: number;
  readonly deadlineAt?: number;
  readonly protected?: boolean;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface LoadSheddingPolicy {
  readonly maxItemsPerDecision: number;
  readonly maxCostPerDecision: number;
  readonly minimumAgeMs: number;
  readonly deadlineProtectionMs: number;
  readonly protectedLanes: readonly string[];
  readonly backgroundLanes: readonly string[];
  readonly pressureLevels: readonly RuntimePressureLevel[];
  readonly laneWeights: Readonly<Record<string, number>>;
  readonly priorityWeights: Readonly<Record<AdmissionPriority, number>>;
  readonly ageWeight: number;
  readonly costWeight: number;
  readonly laneWeight: number;
  readonly priorityWeight: number;
}

export interface LoadSheddingCandidate {
  readonly work: QueuedRuntimeWork;
  readonly ageMs: number;
  readonly score: number;
  readonly reasons: readonly string[];
}

export interface LoadSheddingDecision {
  readonly pressure: RuntimePressureLevel;
  readonly considered: number;
  readonly selected: readonly LoadSheddingCandidate[];
  readonly selectedIds: readonly string[];
  readonly selectedCost: number;
  readonly skippedProtected: number;
  readonly skippedYoung: number;
  readonly skippedDeadline: number;
  readonly exhaustedItemBudget: boolean;
  readonly exhaustedCostBudget: boolean;
}

export interface LoadSheddingPlanner {
  readonly decide: (
    pressure: RuntimePressureLevel,
    queue: readonly QueuedRuntimeWork[],
    now?: number,
  ) => LoadSheddingDecision;
  readonly predicate: (decision: LoadSheddingDecision) => (request: Readonly<AdmissionRequest>) => boolean;
}

const PRIORITIES: readonly AdmissionPriority[] = Object.freeze([
  'critical',
  'high',
  'normal',
  'background',
]);

const DEFAULT_PRIORITY_WEIGHTS: Readonly<Record<AdmissionPriority, number>> = Object.freeze({
  critical: -100,
  high: -40,
  normal: 20,
  background: 80,
});

const DEFAULT_POLICY: LoadSheddingPolicy = Object.freeze({
  maxItemsPerDecision: 32,
  maxCostPerDecision: 64,
  minimumAgeMs: 250,
  deadlineProtectionMs: 1_500,
  protectedLanes: Object.freeze(['interactive', 'foreground']),
  backgroundLanes: Object.freeze(['background', 'prefetch', 'maintenance']),
  pressureLevels: Object.freeze(['high', 'critical']),
  laneWeights: Object.freeze({
    interactive: -100,
    foreground: -60,
    default: 0,
    background: 50,
    prefetch: 80,
    maintenance: 65,
  }),
  priorityWeights: DEFAULT_PRIORITY_WEIGHTS,
  ageWeight: 0.5,
  costWeight: 2,
  laneWeight: 1,
  priorityWeight: 1,
});

const finite = (value: number, fallback = 0): number =>
  Number.isFinite(value) ? Number(value) : fallback;

const nonNegative = (value: number, fallback = 0): number =>
  Math.max(0, finite(value, fallback));

const positiveInt = (value: number | undefined, fallback: number): number => {
  if (!Number.isFinite(value) || Number(value) <= 0) return fallback;
  return Math.max(1, Math.floor(Number(value)));
};

const boundedWeight = (value: number | undefined, fallback: number): number => {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(-1_000, Math.min(1_000, Number(value)));
};

const normalizeStrings = (values: readonly string[] | undefined, fallback: readonly string[]): readonly string[] => {
  const normalized = values
    ?.map((value) => value.trim())
    .filter((value) => value.length > 0);
  return Object.freeze(normalized?.length ? [...new Set(normalized)] : [...fallback]);
};

const normalizePriorityWeights = (
  overrides: Partial<Record<AdmissionPriority, number>> | undefined,
): Readonly<Record<AdmissionPriority, number>> => Object.freeze(
  Object.fromEntries(PRIORITIES.map((priority) => [
    priority,
    boundedWeight(overrides?.[priority], DEFAULT_PRIORITY_WEIGHTS[priority]),
  ])) as Record<AdmissionPriority, number>,
);

const normalizePolicy = (overrides: Partial<LoadSheddingPolicy> = {}): LoadSheddingPolicy => {
  const laneWeights = { ...DEFAULT_POLICY.laneWeights, ...overrides.laneWeights };
  const normalizedLaneWeights = Object.freeze(Object.fromEntries(
    Object.entries(laneWeights).map(([lane, value]) => [lane, boundedWeight(value, 0)]),
  ));
  const levels = overrides.pressureLevels?.filter(
    (level): level is RuntimePressureLevel =>
      level === 'nominal' || level === 'elevated' || level === 'high' || level === 'critical',
  );
  return Object.freeze({
    maxItemsPerDecision: positiveInt(overrides.maxItemsPerDecision, DEFAULT_POLICY.maxItemsPerDecision),
    maxCostPerDecision: positiveInt(overrides.maxCostPerDecision, DEFAULT_POLICY.maxCostPerDecision),
    minimumAgeMs: nonNegative(overrides.minimumAgeMs ?? DEFAULT_POLICY.minimumAgeMs),
    deadlineProtectionMs: nonNegative(overrides.deadlineProtectionMs ?? DEFAULT_POLICY.deadlineProtectionMs),
    protectedLanes: normalizeStrings(overrides.protectedLanes, DEFAULT_POLICY.protectedLanes),
    backgroundLanes: normalizeStrings(overrides.backgroundLanes, DEFAULT_POLICY.backgroundLanes),
    pressureLevels: Object.freeze(levels?.length ? [...new Set(levels)] : [...DEFAULT_POLICY.pressureLevels]),
    laneWeights: normalizedLaneWeights,
    priorityWeights: normalizePriorityWeights(overrides.priorityWeights),
    ageWeight: boundedWeight(overrides.ageWeight, DEFAULT_POLICY.ageWeight),
    costWeight: boundedWeight(overrides.costWeight, DEFAULT_POLICY.costWeight),
    laneWeight: boundedWeight(overrides.laneWeight, DEFAULT_POLICY.laneWeight),
    priorityWeight: boundedWeight(overrides.priorityWeight, DEFAULT_POLICY.priorityWeight),
  });
};

const normalizeWork = (work: QueuedRuntimeWork): QueuedRuntimeWork => Object.freeze({
  id: work.id.trim(),
  key: work.key.trim(),
  lane: work.lane.trim() || 'default',
  priority: PRIORITIES.includes(work.priority) ? work.priority : 'normal',
  cost: Math.max(1, Math.floor(nonNegative(work.cost, 1))),
  enqueuedAt: finite(work.enqueuedAt),
  ...(Number.isFinite(work.deadlineAt) ? { deadlineAt: Number(work.deadlineAt) } : {}),
  ...(work.protected ? { protected: true } : {}),
  ...(work.metadata ? { metadata: work.metadata } : {}),
});

const candidateReasons = (
  work: QueuedRuntimeWork,
  ageMs: number,
  policy: LoadSheddingPolicy,
): readonly string[] => {
  const reasons: string[] = [];
  if (policy.backgroundLanes.includes(work.lane)) reasons.push('background-lane');
  if (work.priority === 'background') reasons.push('background-priority');
  if (ageMs >= policy.minimumAgeMs * 4) reasons.push('old');
  if (work.cost >= Math.max(2, policy.maxCostPerDecision / 8)) reasons.push('expensive');
  return Object.freeze(reasons);
};

const candidateScore = (
  work: QueuedRuntimeWork,
  ageMs: number,
  policy: LoadSheddingPolicy,
): number => {
  const normalizedAge = Math.min(10, ageMs / Math.max(1, policy.minimumAgeMs));
  const laneScore = policy.laneWeights[work.lane] ?? 0;
  const priorityScore = policy.priorityWeights[work.priority];
  return normalizedAge * policy.ageWeight
    + work.cost * policy.costWeight
    + laneScore * policy.laneWeight
    + priorityScore * policy.priorityWeight;
};

const compareCandidates = (left: LoadSheddingCandidate, right: LoadSheddingCandidate): number => {
  const score = right.score - left.score;
  if (score !== 0) return score;
  const age = right.ageMs - left.ageMs;
  if (age !== 0) return age;
  const cost = right.work.cost - left.work.cost;
  if (cost !== 0) return cost;
  return left.work.id.localeCompare(right.work.id);
};

export const createLoadSheddingPlanner = (
  overrides: Partial<LoadSheddingPolicy> = {},
): LoadSheddingPlanner => {
  const policy = normalizePolicy(overrides);

  const decide = (
    pressure: RuntimePressureLevel,
    queue: readonly QueuedRuntimeWork[],
    timestamp = Date.now(),
  ): LoadSheddingDecision => {
    if (!policy.pressureLevels.includes(pressure) || queue.length === 0) {
      return Object.freeze({
        pressure,
        considered: queue.length,
        selected: Object.freeze([]),
        selectedIds: Object.freeze([]),
        selectedCost: 0,
        skippedProtected: 0,
        skippedYoung: 0,
        skippedDeadline: 0,
        exhaustedItemBudget: false,
        exhaustedCostBudget: false,
      });
    }

    const protectedLanes = new Set(policy.protectedLanes);
    const candidates: LoadSheddingCandidate[] = [];
    let skippedProtected = 0;
    let skippedYoung = 0;
    let skippedDeadline = 0;

    for (const rawWork of queue) {
      const work = normalizeWork(rawWork);
      if (!work.id || !work.key) {
        skippedProtected += 1;
        continue;
      }
      if (work.protected || protectedLanes.has(work.lane) || work.priority === 'critical') {
        skippedProtected += 1;
        continue;
      }
      const ageMs = Math.max(0, timestamp - work.enqueuedAt);
      if (ageMs < policy.minimumAgeMs) {
        skippedYoung += 1;
        continue;
      }
      if (
        work.deadlineAt !== undefined
        && work.deadlineAt >= timestamp
        && work.deadlineAt - timestamp <= policy.deadlineProtectionMs
      ) {
        skippedDeadline += 1;
        continue;
      }
      candidates.push(Object.freeze({
        work,
        ageMs,
        score: candidateScore(work, ageMs, policy),
        reasons: candidateReasons(work, ageMs, policy),
      }));
    }

    candidates.sort(compareCandidates);
    const selected: LoadSheddingCandidate[] = [];
    let selectedCost = 0;
    let exhaustedItemBudget = false;
    let exhaustedCostBudget = false;

    for (const candidate of candidates) {
      if (selected.length >= policy.maxItemsPerDecision) {
        exhaustedItemBudget = true;
        break;
      }
      if (selectedCost + candidate.work.cost > policy.maxCostPerDecision) {
        exhaustedCostBudget = true;
        continue;
      }
      selected.push(candidate);
      selectedCost += candidate.work.cost;
    }

    return Object.freeze({
      pressure,
      considered: queue.length,
      selected: Object.freeze(selected),
      selectedIds: Object.freeze(selected.map((candidate) => candidate.work.id)),
      selectedCost,
      skippedProtected,
      skippedYoung,
      skippedDeadline,
      exhaustedItemBudget,
      exhaustedCostBudget,
    });
  };

  const predicate = (decision: LoadSheddingDecision) => {
    const ids = new Set(decision.selected.map((candidate) => candidate.work.key));
    return (request: Readonly<AdmissionRequest>): boolean => ids.has(request.key);
  };

  return Object.freeze({ decide, predicate });
};

export const loadSheddingScore = (
  work: QueuedRuntimeWork,
  now: number,
  overrides: Partial<LoadSheddingPolicy> = {},
): number => {
  const policy = normalizePolicy(overrides);
  const normalized = normalizeWork(work);
  return candidateScore(normalized, Math.max(0, now - normalized.enqueuedAt), policy);
};
