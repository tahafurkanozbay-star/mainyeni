export type SpatialLodPriority = 'critical' | 'interactive' | 'foreground' | 'background';

export interface SpatialLodResource {
  readonly id: string;
  readonly layerId: string;
  readonly priority: SpatialLodPriority;
  readonly estimatedCpuBytes: number;
  readonly estimatedGpuBytes: number;
  readonly estimatedVertices: number;
  readonly estimatedDrawCalls: number;
  readonly minScale?: number;
  readonly maxScale?: number;
  readonly distanceMeters?: number;
  readonly selected?: boolean;
  readonly visible?: boolean;
}

export interface SpatialLodBudget {
  readonly maxResources: number;
  readonly maxCpuBytes: number;
  readonly maxGpuBytes: number;
  readonly maxVertices: number;
  readonly maxDrawCalls: number;
  readonly maxLayerResources: number;
  readonly maxIdLength: number;
}

export interface SpatialLodPressure {
  readonly resources: number;
  readonly cpu: number;
  readonly gpu: number;
  readonly vertices: number;
  readonly drawCalls: number;
  readonly maximum: number;
}

export interface SpatialLodAdmission {
  readonly admitted: boolean;
  readonly reason: 'admitted' | 'hidden' | 'out-of-scale' | 'resource-too-large' | 'layer-budget';
  readonly evictedIds: readonly string[];
  readonly pressure: SpatialLodPressure;
}

export interface SpatialLodSnapshot {
  readonly resources: number;
  readonly cpuBytes: number;
  readonly gpuBytes: number;
  readonly vertices: number;
  readonly drawCalls: number;
  readonly admissions: number;
  readonly rejections: number;
  readonly evictions: number;
  readonly pressure: SpatialLodPressure;
}

interface StoredResource extends SpatialLodResource {
  readonly sequence: number;
}

const DEFAULT_BUDGET: SpatialLodBudget = Object.freeze({
  maxResources: 20_000,
  maxCpuBytes: 256 * 1024 * 1024,
  maxGpuBytes: 384 * 1024 * 1024,
  maxVertices: 8_000_000,
  maxDrawCalls: 2_000,
  maxLayerResources: 5_000,
  maxIdLength: 256,
});

const PRIORITY_WEIGHT: Readonly<Record<SpatialLodPriority, number>> = Object.freeze({
  critical: 4,
  interactive: 3,
  foreground: 2,
  background: 1,
});

function positiveSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive safe integer`);
  return value;
}

function nonNegativeSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${name} must be a non-negative safe integer`);
  return value;
}

function finiteNonNegative(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) throw new RangeError(`${name} must be finite and non-negative`);
  return Object.is(value, -0) ? 0 : value;
}

function normalizeText(value: string, name: string, maxLength: number): string {
  if (typeof value !== 'string') throw new TypeError(`${name} must be a string`);
  const normalized = value.trim();
  if (normalized.length === 0) throw new TypeError(`${name} must not be empty`);
  if (normalized.length > maxLength) throw new RangeError(`${name} exceeds length budget`);
  return normalized;
}

function normalizeBudget(input: Partial<SpatialLodBudget>): SpatialLodBudget {
  return Object.freeze({
    maxResources: positiveSafeInteger(input.maxResources ?? DEFAULT_BUDGET.maxResources, 'maxResources'),
    maxCpuBytes: positiveSafeInteger(input.maxCpuBytes ?? DEFAULT_BUDGET.maxCpuBytes, 'maxCpuBytes'),
    maxGpuBytes: positiveSafeInteger(input.maxGpuBytes ?? DEFAULT_BUDGET.maxGpuBytes, 'maxGpuBytes'),
    maxVertices: positiveSafeInteger(input.maxVertices ?? DEFAULT_BUDGET.maxVertices, 'maxVertices'),
    maxDrawCalls: positiveSafeInteger(input.maxDrawCalls ?? DEFAULT_BUDGET.maxDrawCalls, 'maxDrawCalls'),
    maxLayerResources: positiveSafeInteger(input.maxLayerResources ?? DEFAULT_BUDGET.maxLayerResources, 'maxLayerResources'),
    maxIdLength: positiveSafeInteger(input.maxIdLength ?? DEFAULT_BUDGET.maxIdLength, 'maxIdLength'),
  });
}

function normalizeResource(input: SpatialLodResource, maxIdLength: number): SpatialLodResource {
  const minScale = input.minScale === undefined ? undefined : finiteNonNegative(input.minScale, 'minScale');
  const maxScale = input.maxScale === undefined ? undefined : finiteNonNegative(input.maxScale, 'maxScale');
  if (minScale !== undefined && maxScale !== undefined && minScale < maxScale) {
    throw new RangeError('minScale must be greater than or equal to maxScale when both are provided');
  }
  return Object.freeze({
    id: normalizeText(input.id, 'id', maxIdLength),
    layerId: normalizeText(input.layerId, 'layerId', maxIdLength),
    priority: input.priority,
    estimatedCpuBytes: nonNegativeSafeInteger(input.estimatedCpuBytes, 'estimatedCpuBytes'),
    estimatedGpuBytes: nonNegativeSafeInteger(input.estimatedGpuBytes, 'estimatedGpuBytes'),
    estimatedVertices: nonNegativeSafeInteger(input.estimatedVertices, 'estimatedVertices'),
    estimatedDrawCalls: nonNegativeSafeInteger(input.estimatedDrawCalls, 'estimatedDrawCalls'),
    ...(minScale === undefined ? {} : { minScale }),
    ...(maxScale === undefined ? {} : { maxScale }),
    ...(input.distanceMeters === undefined ? {} : { distanceMeters: finiteNonNegative(input.distanceMeters, 'distanceMeters') }),
    selected: input.selected === true,
    visible: input.visible !== false,
  });
}

export function isSpatialLodResourceInScale(resource: SpatialLodResource, scale: number): boolean {
  const safeScale = finiteNonNegative(scale, 'scale');
  if (resource.minScale !== undefined && safeScale > resource.minScale) return false;
  if (resource.maxScale !== undefined && safeScale < resource.maxScale) return false;
  return true;
}

function ratio(value: number, maximum: number): number {
  return maximum === 0 ? 1 : value / maximum;
}

export class SpatialLodBudgetRuntime {
  readonly #budget: SpatialLodBudget;
  readonly #resources = new Map<string, StoredResource>();
  readonly #layerCounts = new Map<string, number>();
  #cpuBytes = 0;
  #gpuBytes = 0;
  #vertices = 0;
  #drawCalls = 0;
  #sequence = 0;
  #admissions = 0;
  #rejections = 0;
  #evictions = 0;

  constructor(budget: Partial<SpatialLodBudget> = {}) {
    this.#budget = normalizeBudget(budget);
  }

  admit(input: SpatialLodResource, scale: number): SpatialLodAdmission {
    const resource = normalizeResource(input, this.#budget.maxIdLength);
    if (resource.visible === false) return this.#reject('hidden');
    if (!isSpatialLodResourceInScale(resource, scale)) return this.#reject('out-of-scale');
    if (this.#exceedsSingleResourceBudget(resource)) return this.#reject('resource-too-large');

    const previous = this.#resources.get(resource.id);
    if (previous !== undefined) this.#removeStored(previous);

    const layerCount = this.#layerCounts.get(resource.layerId) ?? 0;
    if (layerCount >= this.#budget.maxLayerResources) {
      if (previous !== undefined) this.#insertStored(previous);
      return this.#reject('layer-budget');
    }

    const stored: StoredResource = Object.freeze({ ...resource, sequence: ++this.#sequence });
    this.#insertStored(stored);
    const evictedIds: string[] = [];

    while (this.#isOverBudget()) {
      const candidate = this.#selectEvictionCandidate(stored.id);
      if (candidate === undefined) {
        this.#removeStored(stored);
        if (previous !== undefined) this.#insertStored(previous);
        return this.#reject('resource-too-large');
      }
      this.#removeStored(candidate);
      this.#evictions += 1;
      evictedIds.push(candidate.id);
    }

    this.#admissions += 1;
    return Object.freeze({
      admitted: true,
      reason: 'admitted',
      evictedIds: Object.freeze(evictedIds),
      pressure: this.pressure(),
    });
  }

  remove(id: string): boolean {
    const stored = this.#resources.get(id);
    if (stored === undefined) return false;
    this.#removeStored(stored);
    return true;
  }

  removeLayer(layerId: string): readonly string[] {
    const normalized = normalizeText(layerId, 'layerId', this.#budget.maxIdLength);
    const removed: string[] = [];
    for (const stored of this.#resources.values()) {
      if (stored.layerId !== normalized) continue;
      this.#removeStored(stored);
      removed.push(stored.id);
    }
    return Object.freeze(removed);
  }

  reconcileScale(scale: number): readonly string[] {
    finiteNonNegative(scale, 'scale');
    const removed: string[] = [];
    for (const stored of this.#resources.values()) {
      if (isSpatialLodResourceInScale(stored, scale)) continue;
      this.#removeStored(stored);
      removed.push(stored.id);
    }
    return Object.freeze(removed);
  }

  clear(): void {
    this.#resources.clear();
    this.#layerCounts.clear();
    this.#cpuBytes = 0;
    this.#gpuBytes = 0;
    this.#vertices = 0;
    this.#drawCalls = 0;
  }

  has(id: string): boolean {
    return this.#resources.has(id);
  }

  get(id: string): SpatialLodResource | undefined {
    const stored = this.#resources.get(id);
    return stored === undefined ? undefined : this.#publicResource(stored);
  }

  listLayer(layerId: string): readonly SpatialLodResource[] {
    const normalized = normalizeText(layerId, 'layerId', this.#budget.maxIdLength);
    return Object.freeze(
      [...this.#resources.values()]
        .filter((resource) => resource.layerId === normalized)
        .sort((a, b) => a.sequence - b.sequence)
        .map((resource) => this.#publicResource(resource)),
    );
  }

  pressure(): SpatialLodPressure {
    const resources = ratio(this.#resources.size, this.#budget.maxResources);
    const cpu = ratio(this.#cpuBytes, this.#budget.maxCpuBytes);
    const gpu = ratio(this.#gpuBytes, this.#budget.maxGpuBytes);
    const vertices = ratio(this.#vertices, this.#budget.maxVertices);
    const drawCalls = ratio(this.#drawCalls, this.#budget.maxDrawCalls);
    return Object.freeze({ resources, cpu, gpu, vertices, drawCalls, maximum: Math.max(resources, cpu, gpu, vertices, drawCalls) });
  }

  snapshot(): SpatialLodSnapshot {
    return Object.freeze({
      resources: this.#resources.size,
      cpuBytes: this.#cpuBytes,
      gpuBytes: this.#gpuBytes,
      vertices: this.#vertices,
      drawCalls: this.#drawCalls,
      admissions: this.#admissions,
      rejections: this.#rejections,
      evictions: this.#evictions,
      pressure: this.pressure(),
    });
  }

  #reject(reason: SpatialLodAdmission['reason']): SpatialLodAdmission {
    this.#rejections += 1;
    return Object.freeze({ admitted: false, reason, evictedIds: Object.freeze([]), pressure: this.pressure() });
  }

  #exceedsSingleResourceBudget(resource: SpatialLodResource): boolean {
    return resource.estimatedCpuBytes > this.#budget.maxCpuBytes
      || resource.estimatedGpuBytes > this.#budget.maxGpuBytes
      || resource.estimatedVertices > this.#budget.maxVertices
      || resource.estimatedDrawCalls > this.#budget.maxDrawCalls;
  }

  #isOverBudget(): boolean {
    return this.#resources.size > this.#budget.maxResources
      || this.#cpuBytes > this.#budget.maxCpuBytes
      || this.#gpuBytes > this.#budget.maxGpuBytes
      || this.#vertices > this.#budget.maxVertices
      || this.#drawCalls > this.#budget.maxDrawCalls;
  }

  #selectEvictionCandidate(protectedId: string): StoredResource | undefined {
    let candidate: StoredResource | undefined;
    for (const resource of this.#resources.values()) {
      if (resource.id === protectedId || resource.selected === true || resource.priority === 'critical') continue;
      if (candidate === undefined || this.#compareEviction(resource, candidate) < 0) candidate = resource;
    }
    return candidate;
  }

  #compareEviction(a: StoredResource, b: StoredResource): number {
    const priorityDelta = PRIORITY_WEIGHT[a.priority] - PRIORITY_WEIGHT[b.priority];
    if (priorityDelta !== 0) return priorityDelta;
    const aDistance = a.distanceMeters ?? 0;
    const bDistance = b.distanceMeters ?? 0;
    if (aDistance !== bDistance) return bDistance - aDistance;
    return a.sequence - b.sequence;
  }

  #insertStored(resource: StoredResource): void {
    this.#resources.set(resource.id, resource);
    this.#cpuBytes += resource.estimatedCpuBytes;
    this.#gpuBytes += resource.estimatedGpuBytes;
    this.#vertices += resource.estimatedVertices;
    this.#drawCalls += resource.estimatedDrawCalls;
    this.#layerCounts.set(resource.layerId, (this.#layerCounts.get(resource.layerId) ?? 0) + 1);
  }

  #removeStored(resource: StoredResource): void {
    this.#resources.delete(resource.id);
    this.#cpuBytes -= resource.estimatedCpuBytes;
    this.#gpuBytes -= resource.estimatedGpuBytes;
    this.#vertices -= resource.estimatedVertices;
    this.#drawCalls -= resource.estimatedDrawCalls;
    const nextLayerCount = (this.#layerCounts.get(resource.layerId) ?? 1) - 1;
    if (nextLayerCount <= 0) this.#layerCounts.delete(resource.layerId);
    else this.#layerCounts.set(resource.layerId, nextLayerCount);
  }

  #publicResource(resource: StoredResource): SpatialLodResource {
    const { sequence: _sequence, ...publicResource } = resource;
    return Object.freeze(publicResource);
  }
}
