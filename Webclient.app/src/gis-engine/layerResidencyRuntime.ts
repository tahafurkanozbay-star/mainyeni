export type LayerResidencyMode = '2d' | '3d';
export type LayerResidencyPriority = 'critical' | 'high' | 'normal' | 'low';
export type LayerResidencyState = 'registered' | 'resident' | 'suspended' | 'disposed';

export interface LayerResidencyCost {
  readonly cpuBytes: number;
  readonly gpuBytes: number;
  readonly featureCount: number;
  readonly drawCalls: number;
}

export interface LayerResidencyDescriptor {
  readonly id: string;
  readonly mode: LayerResidencyMode;
  readonly priority: LayerResidencyPriority;
  readonly minScale?: number;
  readonly maxScale?: number;
  readonly cost: LayerResidencyCost;
}

export interface LayerResidencyBudget extends LayerResidencyCost {
  readonly maxResidentLayers: number;
}

export interface LayerResidencyAdmission {
  readonly admitted: boolean;
  readonly layerId: string;
  readonly evictedLayerIds: readonly string[];
  readonly reason?: 'not-registered' | 'disposed' | 'scale' | 'single-layer-budget' | 'capacity';
}

export interface LayerResidencySnapshotEntry {
  readonly descriptor: LayerResidencyDescriptor;
  readonly state: LayerResidencyState;
  readonly lastTouchedAt: number;
  readonly residentSince?: number;
}

export interface LayerResidencySnapshot {
  readonly entries: readonly LayerResidencySnapshotEntry[];
  readonly usage: Readonly<LayerResidencyCost & { residentLayers: number }>;
  readonly budget: Readonly<LayerResidencyBudget>;
  readonly revision: number;
}

export interface LayerResidencyRuntimeOptions {
  readonly budget: LayerResidencyBudget;
  readonly now?: () => number;
  readonly maxEntries?: number;
}

type MutableEntry = {
  descriptor: LayerResidencyDescriptor;
  state: LayerResidencyState;
  lastTouchedAt: number;
  residentSince?: number;
};

const PRIORITY_WEIGHT: Readonly<Record<LayerResidencyPriority, number>> = Object.freeze({
  critical: 4,
  high: 3,
  normal: 2,
  low: 1,
});

const ZERO_USAGE = (): LayerResidencyCost & { residentLayers: number } => ({
  cpuBytes: 0,
  gpuBytes: 0,
  featureCount: 0,
  drawCalls: 0,
  residentLayers: 0,
});

const finiteNonNegative = (value: number, field: string): number => {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${field} must be finite and non-negative`);
  return value;
};

const positiveInteger = (value: number, field: string): number => {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${field} must be a positive integer`);
  return value;
};

const normalizeCost = (cost: LayerResidencyCost): LayerResidencyCost => Object.freeze({
  cpuBytes: finiteNonNegative(cost.cpuBytes, 'cpuBytes'),
  gpuBytes: finiteNonNegative(cost.gpuBytes, 'gpuBytes'),
  featureCount: finiteNonNegative(cost.featureCount, 'featureCount'),
  drawCalls: finiteNonNegative(cost.drawCalls, 'drawCalls'),
});

const normalizeDescriptor = (descriptor: LayerResidencyDescriptor): LayerResidencyDescriptor => {
  const id = descriptor.id.trim();
  if (!id) throw new Error('layer id must not be empty');
  if (descriptor.minScale !== undefined) finiteNonNegative(descriptor.minScale, 'minScale');
  if (descriptor.maxScale !== undefined) finiteNonNegative(descriptor.maxScale, 'maxScale');
  if (descriptor.minScale !== undefined && descriptor.maxScale !== undefined && descriptor.minScale > descriptor.maxScale) {
    throw new Error('minScale must be <= maxScale');
  }
  return Object.freeze({ ...descriptor, id, cost: normalizeCost(descriptor.cost) });
};

const withinScale = (descriptor: LayerResidencyDescriptor, scale: number): boolean => {
  finiteNonNegative(scale, 'scale');
  if (descriptor.minScale !== undefined && scale < descriptor.minScale) return false;
  if (descriptor.maxScale !== undefined && scale > descriptor.maxScale) return false;
  return true;
};

const fitsCost = (cost: LayerResidencyCost, budget: LayerResidencyBudget): boolean =>
  cost.cpuBytes <= budget.cpuBytes &&
  cost.gpuBytes <= budget.gpuBytes &&
  cost.featureCount <= budget.featureCount &&
  cost.drawCalls <= budget.drawCalls;

const addCost = (usage: LayerResidencyCost & { residentLayers: number }, cost: LayerResidencyCost, delta: 1 | -1): void => {
  usage.cpuBytes += cost.cpuBytes * delta;
  usage.gpuBytes += cost.gpuBytes * delta;
  usage.featureCount += cost.featureCount * delta;
  usage.drawCalls += cost.drawCalls * delta;
  usage.residentLayers += delta;
};

const cloneDescriptor = (descriptor: LayerResidencyDescriptor): LayerResidencyDescriptor => Object.freeze({
  ...descriptor,
  cost: Object.freeze({ ...descriptor.cost }),
});

export class LayerResidencyRuntime {
  private readonly entries = new Map<string, MutableEntry>();
  private readonly budget: LayerResidencyBudget;
  private readonly now: () => number;
  private readonly maxEntries: number;
  private revision = 0;
  private disposed = false;

  constructor(options: LayerResidencyRuntimeOptions) {
    this.budget = Object.freeze({
      cpuBytes: finiteNonNegative(options.budget.cpuBytes, 'budget.cpuBytes'),
      gpuBytes: finiteNonNegative(options.budget.gpuBytes, 'budget.gpuBytes'),
      featureCount: finiteNonNegative(options.budget.featureCount, 'budget.featureCount'),
      drawCalls: finiteNonNegative(options.budget.drawCalls, 'budget.drawCalls'),
      maxResidentLayers: positiveInteger(options.budget.maxResidentLayers, 'budget.maxResidentLayers'),
    });
    this.now = options.now ?? Date.now;
    this.maxEntries = positiveInteger(options.maxEntries ?? 512, 'maxEntries');
  }

  register(input: LayerResidencyDescriptor): LayerResidencySnapshotEntry {
    this.assertActive();
    const descriptor = normalizeDescriptor(input);
    const existing = this.entries.get(descriptor.id);
    if (!existing && this.entries.size >= this.maxEntries) this.evictRegistration();
    const timestamp = this.now();
    if (existing?.state === 'resident') {
      existing.descriptor = descriptor;
      existing.lastTouchedAt = timestamp;
      this.revision += 1;
      return this.toSnapshotEntry(existing);
    }
    const entry: MutableEntry = { descriptor, state: 'registered', lastTouchedAt: timestamp };
    this.entries.set(descriptor.id, entry);
    this.revision += 1;
    return this.toSnapshotEntry(entry);
  }

  admit(layerId: string, scale: number): LayerResidencyAdmission {
    this.assertActive();
    const entry = this.entries.get(layerId);
    if (!entry) return Object.freeze({ admitted: false, layerId, evictedLayerIds: Object.freeze([]), reason: 'not-registered' });
    if (entry.state === 'disposed') return Object.freeze({ admitted: false, layerId, evictedLayerIds: Object.freeze([]), reason: 'disposed' });
    if (!withinScale(entry.descriptor, scale)) {
      if (entry.state === 'resident') this.suspend(layerId);
      return Object.freeze({ admitted: false, layerId, evictedLayerIds: Object.freeze([]), reason: 'scale' });
    }
    if (!fitsCost(entry.descriptor.cost, this.budget)) {
      return Object.freeze({ admitted: false, layerId, evictedLayerIds: Object.freeze([]), reason: 'single-layer-budget' });
    }
    if (entry.state === 'resident') {
      entry.lastTouchedAt = this.now();
      this.revision += 1;
      return Object.freeze({ admitted: true, layerId, evictedLayerIds: Object.freeze([]) });
    }

    const evicted: string[] = [];
    while (!this.canFit(entry.descriptor.cost)) {
      const victim = this.pickVictim(entry);
      if (!victim) return Object.freeze({ admitted: false, layerId, evictedLayerIds: Object.freeze(evicted), reason: 'capacity' });
      victim.state = 'suspended';
      victim.residentSince = undefined;
      victim.lastTouchedAt = this.now();
      evicted.push(victim.descriptor.id);
      this.revision += 1;
    }
    const timestamp = this.now();
    entry.state = 'resident';
    entry.lastTouchedAt = timestamp;
    entry.residentSince = timestamp;
    this.revision += 1;
    return Object.freeze({ admitted: true, layerId, evictedLayerIds: Object.freeze(evicted) });
  }

  touch(layerId: string): boolean {
    this.assertActive();
    const entry = this.entries.get(layerId);
    if (!entry || entry.state === 'disposed') return false;
    entry.lastTouchedAt = this.now();
    this.revision += 1;
    return true;
  }

  suspend(layerId: string): boolean {
    this.assertActive();
    const entry = this.entries.get(layerId);
    if (!entry || entry.state !== 'resident') return false;
    entry.state = 'suspended';
    entry.residentSince = undefined;
    entry.lastTouchedAt = this.now();
    this.revision += 1;
    return true;
  }

  remove(layerId: string): boolean {
    this.assertActive();
    const entry = this.entries.get(layerId);
    if (!entry) return false;
    entry.state = 'disposed';
    entry.residentSince = undefined;
    entry.lastTouchedAt = this.now();
    this.entries.delete(layerId);
    this.revision += 1;
    return true;
  }

  reconcileScale(scale: number): readonly string[] {
    this.assertActive();
    finiteNonNegative(scale, 'scale');
    const suspended: string[] = [];
    for (const entry of this.entries.values()) {
      if (entry.state === 'resident' && !withinScale(entry.descriptor, scale)) {
        entry.state = 'suspended';
        entry.residentSince = undefined;
        entry.lastTouchedAt = this.now();
        suspended.push(entry.descriptor.id);
        this.revision += 1;
      }
    }
    return Object.freeze(suspended.sort());
  }

  snapshot(): LayerResidencySnapshot {
    const usage = this.currentUsage();
    const entries = Array.from(this.entries.values())
      .sort((a, b) => a.descriptor.id.localeCompare(b.descriptor.id))
      .map((entry) => this.toSnapshotEntry(entry));
    return Object.freeze({
      entries: Object.freeze(entries),
      usage: Object.freeze({ ...usage }),
      budget: this.budget,
      revision: this.revision,
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.entries.clear();
    this.disposed = true;
    this.revision += 1;
  }

  private currentUsage(): LayerResidencyCost & { residentLayers: number } {
    const usage = ZERO_USAGE();
    for (const entry of this.entries.values()) if (entry.state === 'resident') addCost(usage, entry.descriptor.cost, 1);
    return usage;
  }

  private canFit(cost: LayerResidencyCost): boolean {
    const usage = this.currentUsage();
    return usage.residentLayers + 1 <= this.budget.maxResidentLayers &&
      usage.cpuBytes + cost.cpuBytes <= this.budget.cpuBytes &&
      usage.gpuBytes + cost.gpuBytes <= this.budget.gpuBytes &&
      usage.featureCount + cost.featureCount <= this.budget.featureCount &&
      usage.drawCalls + cost.drawCalls <= this.budget.drawCalls;
  }

  private pickVictim(incoming: MutableEntry): MutableEntry | undefined {
    const incomingWeight = PRIORITY_WEIGHT[incoming.descriptor.priority];
    return Array.from(this.entries.values())
      .filter((candidate) => candidate.state === 'resident' && PRIORITY_WEIGHT[candidate.descriptor.priority] <= incomingWeight)
      .sort((a, b) => {
        const priority = PRIORITY_WEIGHT[a.descriptor.priority] - PRIORITY_WEIGHT[b.descriptor.priority];
        if (priority !== 0) return priority;
        if (a.lastTouchedAt !== b.lastTouchedAt) return a.lastTouchedAt - b.lastTouchedAt;
        return a.descriptor.id.localeCompare(b.descriptor.id);
      })[0];
  }

  private evictRegistration(): void {
    const victim = Array.from(this.entries.values())
      .filter((entry) => entry.state !== 'resident')
      .sort((a, b) => a.lastTouchedAt - b.lastTouchedAt || a.descriptor.id.localeCompare(b.descriptor.id))[0];
    if (!victim) throw new Error('layer registry capacity exhausted by resident layers');
    this.entries.delete(victim.descriptor.id);
    this.revision += 1;
  }

  private toSnapshotEntry(entry: MutableEntry): LayerResidencySnapshotEntry {
    return Object.freeze({
      descriptor: cloneDescriptor(entry.descriptor),
      state: entry.state,
      lastTouchedAt: entry.lastTouchedAt,
      ...(entry.residentSince === undefined ? {} : { residentSince: entry.residentSince }),
    });
  }

  private assertActive(): void {
    if (this.disposed) throw new Error('layer residency runtime is disposed');
  }
}
