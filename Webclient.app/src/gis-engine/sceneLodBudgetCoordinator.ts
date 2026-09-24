export type SceneLodPressure = 'normal' | 'elevated' | 'critical';
export type SceneLodKind = 'feature' | 'scene' | 'mesh' | 'point-cloud' | 'voxel' | 'imagery' | 'elevation';

export interface SceneLodLevel {
  readonly id: string;
  readonly minScale: number;
  readonly maxScale: number;
  readonly estimatedGpuBytes: number;
  readonly estimatedCpuBytes: number;
  readonly estimatedDrawCalls: number;
  readonly estimatedFeatures: number;
  readonly quality: number;
}

export interface SceneLodResource {
  readonly id: string;
  readonly kind: SceneLodKind;
  readonly visible: boolean;
  readonly priority: number;
  readonly levels: readonly SceneLodLevel[];
}

export interface SceneLodBudget {
  readonly maxGpuBytes: number;
  readonly maxCpuBytes: number;
  readonly maxDrawCalls: number;
  readonly maxFeatures: number;
  readonly maxResources?: number;
  readonly elevatedRatio?: number;
  readonly criticalRatio?: number;
}

export interface SceneLodDecision {
  readonly resourceId: string;
  readonly admitted: boolean;
  readonly levelId?: string;
  readonly reason: 'admitted' | 'hidden' | 'scale' | 'gpu-budget' | 'cpu-budget' | 'draw-budget' | 'feature-budget';
}

export interface SceneLodUsage {
  readonly gpuBytes: number;
  readonly cpuBytes: number;
  readonly drawCalls: number;
  readonly features: number;
}

export interface SceneLodSnapshot {
  readonly scale: number;
  readonly pressure: SceneLodPressure;
  readonly decisions: readonly SceneLodDecision[];
  readonly usage: SceneLodUsage;
  readonly revision: number;
}

type Entry = { resource: SceneLodResource; sequence: number };
type MutableUsage = { gpuBytes: number; cpuBytes: number; drawCalls: number; features: number };

const finite = (value: number, name: string): number => {
  if (!Number.isFinite(value)) throw new Error(`${name} must be finite`);
  return value;
};
const positive = (value: number, name: string): number => {
  finite(value, name);
  if (value <= 0) throw new Error(`${name} must be positive`);
  return value;
};
const nonNegative = (value: number, name: string): number => {
  finite(value, name);
  if (value < 0) throw new Error(`${name} must be non-negative`);
  return value;
};
const positiveInteger = (value: number, name: string): number => {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
};
const boundedRatio = (value: number, name: string): number => {
  finite(value, name);
  if (value <= 0 || value > 1) throw new Error(`${name} must be in (0, 1]`);
  return value;
};

const normalizeLevel = (level: SceneLodLevel): SceneLodLevel => {
  const id = level.id.trim();
  if (!id) throw new Error('LOD level id must not be empty');
  const minScale = nonNegative(level.minScale, 'minScale');
  const maxScale = nonNegative(level.maxScale, 'maxScale');
  if (minScale > 0 && maxScale > 0 && minScale < maxScale) throw new Error('minScale must be >= maxScale when both are set');
  return Object.freeze({
    id,
    minScale,
    maxScale,
    estimatedGpuBytes: nonNegative(level.estimatedGpuBytes, 'estimatedGpuBytes'),
    estimatedCpuBytes: nonNegative(level.estimatedCpuBytes, 'estimatedCpuBytes'),
    estimatedDrawCalls: nonNegative(level.estimatedDrawCalls, 'estimatedDrawCalls'),
    estimatedFeatures: nonNegative(level.estimatedFeatures, 'estimatedFeatures'),
    quality: nonNegative(level.quality, 'quality'),
  });
};

const normalizeResource = (resource: SceneLodResource): SceneLodResource => {
  const id = resource.id.trim();
  if (!id) throw new Error('resource id must not be empty');
  if (resource.levels.length === 0) throw new Error('resource must define at least one LOD level');
  const seen = new Set<string>();
  const levels = resource.levels.map(normalizeLevel);
  for (const level of levels) {
    if (seen.has(level.id)) throw new Error(`duplicate LOD level id: ${level.id}`);
    seen.add(level.id);
  }
  levels.sort((a, b) => b.quality - a.quality || a.id.localeCompare(b.id));
  return Object.freeze({ id, kind: resource.kind, visible: resource.visible, priority: finite(resource.priority, 'priority'), levels: Object.freeze(levels) });
};

const inScale = (level: SceneLodLevel, scale: number): boolean =>
  (level.minScale === 0 || scale <= level.minScale) && (level.maxScale === 0 || scale >= level.maxScale);

const fits = (usage: MutableUsage, level: SceneLodLevel, budget: Required<SceneLodBudget>): SceneLodDecision['reason'] | undefined => {
  if (usage.gpuBytes + level.estimatedGpuBytes > budget.maxGpuBytes) return 'gpu-budget';
  if (usage.cpuBytes + level.estimatedCpuBytes > budget.maxCpuBytes) return 'cpu-budget';
  if (usage.drawCalls + level.estimatedDrawCalls > budget.maxDrawCalls) return 'draw-budget';
  if (usage.features + level.estimatedFeatures > budget.maxFeatures) return 'feature-budget';
  return undefined;
};

/**
 * Pure deterministic admission policy for SceneView LOD resources. It owns no
 * ArcGIS objects and performs no I/O; SceneView adapters provide estimates and
 * apply the selected level. Higher-priority resources are considered first,
 * while each resource degrades from highest to lowest quality until it fits.
 */
export class SceneLodBudgetCoordinator {
  private readonly resources = new Map<string, Entry>();
  private readonly budget: Required<SceneLodBudget>;
  private scale: number;
  private sequence = 0;
  private revision = 0;

  constructor(initialScale: number, budget: SceneLodBudget) {
    this.scale = positive(initialScale, 'scale');
    const elevatedRatio = boundedRatio(budget.elevatedRatio ?? 0.7, 'elevatedRatio');
    const criticalRatio = boundedRatio(budget.criticalRatio ?? 0.9, 'criticalRatio');
    if (elevatedRatio >= criticalRatio) throw new Error('elevatedRatio must be lower than criticalRatio');
    this.budget = Object.freeze({
      maxGpuBytes: positiveInteger(budget.maxGpuBytes, 'maxGpuBytes'),
      maxCpuBytes: positiveInteger(budget.maxCpuBytes, 'maxCpuBytes'),
      maxDrawCalls: positiveInteger(budget.maxDrawCalls, 'maxDrawCalls'),
      maxFeatures: positiveInteger(budget.maxFeatures, 'maxFeatures'),
      maxResources: positiveInteger(budget.maxResources ?? 256, 'maxResources'),
      elevatedRatio,
      criticalRatio,
    });
  }

  setScale(scale: number): SceneLodSnapshot {
    this.scale = positive(scale, 'scale');
    this.revision += 1;
    return this.snapshot();
  }

  upsert(resourceInput: SceneLodResource): SceneLodSnapshot {
    const resource = normalizeResource(resourceInput);
    const existing = this.resources.get(resource.id);
    if (!existing && this.resources.size >= this.budget.maxResources) throw new Error('scene LOD resource capacity exhausted');
    if (existing) existing.resource = resource;
    else this.resources.set(resource.id, { resource, sequence: ++this.sequence });
    this.revision += 1;
    return this.snapshot();
  }

  remove(resourceIdInput: string): boolean {
    const resourceId = resourceIdInput.trim();
    if (!resourceId) return false;
    const removed = this.resources.delete(resourceId);
    if (removed) this.revision += 1;
    return removed;
  }

  clear(): void {
    if (this.resources.size === 0) return;
    this.resources.clear();
    this.revision += 1;
  }

  snapshot(): SceneLodSnapshot {
    const entries = Array.from(this.resources.values()).sort((a, b) =>
      b.resource.priority - a.resource.priority || a.sequence - b.sequence || a.resource.id.localeCompare(b.resource.id));
    const usage: MutableUsage = { gpuBytes: 0, cpuBytes: 0, drawCalls: 0, features: 0 };
    const decisions: SceneLodDecision[] = [];
    for (const entry of entries) {
      const resource = entry.resource;
      if (!resource.visible) {
        decisions.push(Object.freeze({ resourceId: resource.id, admitted: false, reason: 'hidden' }));
        continue;
      }
      const candidates = resource.levels.filter(level => inScale(level, this.scale));
      if (candidates.length === 0) {
        decisions.push(Object.freeze({ resourceId: resource.id, admitted: false, reason: 'scale' }));
        continue;
      }
      let rejection: SceneLodDecision['reason'] = 'gpu-budget';
      let admitted: SceneLodLevel | undefined;
      for (const level of candidates) {
        const failure = fits(usage, level, this.budget);
        if (!failure) { admitted = level; break; }
        rejection = failure;
      }
      if (!admitted) {
        decisions.push(Object.freeze({ resourceId: resource.id, admitted: false, reason: rejection }));
        continue;
      }
      usage.gpuBytes += admitted.estimatedGpuBytes;
      usage.cpuBytes += admitted.estimatedCpuBytes;
      usage.drawCalls += admitted.estimatedDrawCalls;
      usage.features += admitted.estimatedFeatures;
      decisions.push(Object.freeze({ resourceId: resource.id, admitted: true, levelId: admitted.id, reason: 'admitted' }));
    }
    decisions.sort((a, b) => a.resourceId.localeCompare(b.resourceId));
    const pressureRatio = Math.max(
      usage.gpuBytes / this.budget.maxGpuBytes,
      usage.cpuBytes / this.budget.maxCpuBytes,
      usage.drawCalls / this.budget.maxDrawCalls,
      usage.features / this.budget.maxFeatures,
    );
    const pressure: SceneLodPressure = pressureRatio >= this.budget.criticalRatio ? 'critical' : pressureRatio >= this.budget.elevatedRatio ? 'elevated' : 'normal';
    return Object.freeze({
      scale: this.scale,
      pressure,
      decisions: Object.freeze(decisions),
      usage: Object.freeze({ ...usage }),
      revision: this.revision,
    });
  }
}
