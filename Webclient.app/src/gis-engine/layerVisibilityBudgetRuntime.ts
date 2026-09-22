export type LayerVisibilityKind = 'feature' | 'scene' | 'graphics' | 'imagery' | 'elevation';
export type LayerVisibilityPriority = 'critical' | 'high' | 'normal' | 'low';

export interface LayerVisibilityCandidate {
  readonly id: string;
  readonly kind: LayerVisibilityKind;
  readonly priority: LayerVisibilityPriority;
  readonly visible: boolean;
  readonly minScale?: number;
  readonly maxScale?: number;
  readonly estimatedFeatures: number;
  readonly estimatedDrawCalls: number;
  readonly estimatedGpuBytes: number;
  readonly estimatedCpuBytes: number;
  readonly lastVisibleAt?: number;
}

export interface LayerVisibilityBudget {
  readonly maxLayers: number;
  readonly maxFeatures: number;
  readonly maxDrawCalls: number;
  readonly maxGpuBytes: number;
  readonly maxCpuBytes: number;
}

export interface LayerVisibilityContext {
  readonly scale: number;
  readonly now: number;
  readonly mode: '2d' | '3d';
}

export type LayerVisibilityRejectionReason =
  | 'hidden'
  | 'outside-scale'
  | 'layer-budget'
  | 'feature-budget'
  | 'draw-call-budget'
  | 'gpu-budget'
  | 'cpu-budget';

export interface LayerVisibilityDecision {
  readonly id: string;
  readonly admitted: boolean;
  readonly reason?: LayerVisibilityRejectionReason;
}

export interface LayerVisibilityUsage {
  readonly layers: number;
  readonly features: number;
  readonly drawCalls: number;
  readonly gpuBytes: number;
  readonly cpuBytes: number;
}

export interface LayerVisibilityPlan {
  readonly decisions: readonly LayerVisibilityDecision[];
  readonly admittedIds: readonly string[];
  readonly rejectedIds: readonly string[];
  readonly usage: LayerVisibilityUsage;
  readonly pressure: number;
}

const PRIORITY_SCORE: Readonly<Record<LayerVisibilityPriority, number>> = Object.freeze({
  critical: 4,
  high: 3,
  normal: 2,
  low: 1,
});

function assertFiniteNonNegative(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) throw new RangeError(`${name} must be finite and >= 0`);
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive integer`);
}

function validateBudget(budget: LayerVisibilityBudget): void {
  assertPositiveInteger(budget.maxLayers, 'maxLayers');
  assertPositiveInteger(budget.maxFeatures, 'maxFeatures');
  assertPositiveInteger(budget.maxDrawCalls, 'maxDrawCalls');
  assertPositiveInteger(budget.maxGpuBytes, 'maxGpuBytes');
  assertPositiveInteger(budget.maxCpuBytes, 'maxCpuBytes');
}

function validateCandidate(candidate: LayerVisibilityCandidate): void {
  if (!candidate.id.trim()) throw new TypeError('layer id must not be empty');
  assertFiniteNonNegative(candidate.estimatedFeatures, 'estimatedFeatures');
  assertFiniteNonNegative(candidate.estimatedDrawCalls, 'estimatedDrawCalls');
  assertFiniteNonNegative(candidate.estimatedGpuBytes, 'estimatedGpuBytes');
  assertFiniteNonNegative(candidate.estimatedCpuBytes, 'estimatedCpuBytes');
  if (candidate.minScale !== undefined) assertFiniteNonNegative(candidate.minScale, 'minScale');
  if (candidate.maxScale !== undefined) assertFiniteNonNegative(candidate.maxScale, 'maxScale');
  if (candidate.lastVisibleAt !== undefined) assertFiniteNonNegative(candidate.lastVisibleAt, 'lastVisibleAt');
}

function isInsideScale(candidate: LayerVisibilityCandidate, scale: number): boolean {
  if (candidate.minScale !== undefined && candidate.minScale > 0 && scale > candidate.minScale) return false;
  if (candidate.maxScale !== undefined && candidate.maxScale > 0 && scale < candidate.maxScale) return false;
  return true;
}

function compareCandidates(a: LayerVisibilityCandidate, b: LayerVisibilityCandidate): number {
  const priority = PRIORITY_SCORE[b.priority] - PRIORITY_SCORE[a.priority];
  if (priority !== 0) return priority;
  const recent = (b.lastVisibleAt ?? 0) - (a.lastVisibleAt ?? 0);
  if (recent !== 0) return recent;
  const costA = a.estimatedDrawCalls + a.estimatedFeatures / 1000;
  const costB = b.estimatedDrawCalls + b.estimatedFeatures / 1000;
  if (costA !== costB) return costA - costB;
  return a.id.localeCompare(b.id);
}

function pressureOf(usage: LayerVisibilityUsage, budget: LayerVisibilityBudget): number {
  return Math.max(
    usage.layers / budget.maxLayers,
    usage.features / budget.maxFeatures,
    usage.drawCalls / budget.maxDrawCalls,
    usage.gpuBytes / budget.maxGpuBytes,
    usage.cpuBytes / budget.maxCpuBytes,
  );
}

function firstBudgetFailure(usage: LayerVisibilityUsage, candidate: LayerVisibilityCandidate, budget: LayerVisibilityBudget): LayerVisibilityRejectionReason | undefined {
  if (usage.layers + 1 > budget.maxLayers) return 'layer-budget';
  if (usage.features + candidate.estimatedFeatures > budget.maxFeatures) return 'feature-budget';
  if (usage.drawCalls + candidate.estimatedDrawCalls > budget.maxDrawCalls) return 'draw-call-budget';
  if (usage.gpuBytes + candidate.estimatedGpuBytes > budget.maxGpuBytes) return 'gpu-budget';
  if (usage.cpuBytes + candidate.estimatedCpuBytes > budget.maxCpuBytes) return 'cpu-budget';
  return undefined;
}

export function planLayerVisibility(
  candidates: readonly LayerVisibilityCandidate[],
  budget: LayerVisibilityBudget,
  context: LayerVisibilityContext,
): LayerVisibilityPlan {
  validateBudget(budget);
  assertFiniteNonNegative(context.scale, 'scale');
  assertFiniteNonNegative(context.now, 'now');

  const seen = new Set<string>();
  for (const candidate of candidates) {
    validateCandidate(candidate);
    if (seen.has(candidate.id)) throw new TypeError(`duplicate layer id: ${candidate.id}`);
    seen.add(candidate.id);
  }

  const decisions = new Map<string, LayerVisibilityDecision>();
  const eligible: LayerVisibilityCandidate[] = [];
  for (const candidate of candidates) {
    if (!candidate.visible) {
      decisions.set(candidate.id, Object.freeze({ id: candidate.id, admitted: false, reason: 'hidden' }));
    } else if (!isInsideScale(candidate, context.scale)) {
      decisions.set(candidate.id, Object.freeze({ id: candidate.id, admitted: false, reason: 'outside-scale' }));
    } else {
      eligible.push(candidate);
    }
  }
  eligible.sort(compareCandidates);

  const mutableUsage = { layers: 0, features: 0, drawCalls: 0, gpuBytes: 0, cpuBytes: 0 };
  const admittedIds: string[] = [];
  for (const candidate of eligible) {
    const reason = firstBudgetFailure(mutableUsage, candidate, budget);
    if (reason !== undefined) {
      decisions.set(candidate.id, Object.freeze({ id: candidate.id, admitted: false, reason }));
      continue;
    }
    mutableUsage.layers += 1;
    mutableUsage.features += candidate.estimatedFeatures;
    mutableUsage.drawCalls += candidate.estimatedDrawCalls;
    mutableUsage.gpuBytes += candidate.estimatedGpuBytes;
    mutableUsage.cpuBytes += candidate.estimatedCpuBytes;
    admittedIds.push(candidate.id);
    decisions.set(candidate.id, Object.freeze({ id: candidate.id, admitted: true }));
  }

  const orderedDecisions = candidates.map((candidate) => decisions.get(candidate.id)!);
  const rejectedIds = orderedDecisions.filter((decision) => !decision.admitted).map((decision) => decision.id);
  const usage: LayerVisibilityUsage = Object.freeze({ ...mutableUsage });
  return Object.freeze({
    decisions: Object.freeze(orderedDecisions),
    admittedIds: Object.freeze(admittedIds),
    rejectedIds: Object.freeze(rejectedIds),
    usage,
    pressure: pressureOf(usage, budget),
  });
}

export interface LayerVisibilityBudgetProfile {
  readonly mode2d: LayerVisibilityBudget;
  readonly mode3d: LayerVisibilityBudget;
}

export function selectLayerVisibilityBudget(profile: LayerVisibilityBudgetProfile, mode: '2d' | '3d'): LayerVisibilityBudget {
  const budget = mode === '3d' ? profile.mode3d : profile.mode2d;
  validateBudget(budget);
  return budget;
}

export function scaleLayerVisibilityBudget(budget: LayerVisibilityBudget, factor: number): LayerVisibilityBudget {
  validateBudget(budget);
  if (!Number.isFinite(factor) || factor <= 0 || factor > 1) throw new RangeError('factor must be > 0 and <= 1');
  return Object.freeze({
    maxLayers: Math.max(1, Math.floor(budget.maxLayers * factor)),
    maxFeatures: Math.max(1, Math.floor(budget.maxFeatures * factor)),
    maxDrawCalls: Math.max(1, Math.floor(budget.maxDrawCalls * factor)),
    maxGpuBytes: Math.max(1, Math.floor(budget.maxGpuBytes * factor)),
    maxCpuBytes: Math.max(1, Math.floor(budget.maxCpuBytes * factor)),
  });
}
