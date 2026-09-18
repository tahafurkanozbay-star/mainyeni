export type SpatialLayerPhase = 'registered' | 'loading' | 'ready' | 'suspended' | 'failed' | 'disposed';
export type SpatialLayerPriority = 'critical' | 'interactive' | 'foreground' | 'background';

export interface SpatialLayerDescriptor {
  readonly id: string;
  readonly priority: SpatialLayerPriority;
  readonly estimatedCpuBytes: number;
  readonly estimatedGpuBytes: number;
  readonly minScale?: number;
  readonly maxScale?: number;
  readonly visible?: boolean;
}

export interface SpatialLayerLifecycleBudget {
  readonly maxLayers: number;
  readonly maxActiveLayers: number;
  readonly maxCpuBytes: number;
  readonly maxGpuBytes: number;
  readonly maxFailuresPerLayer: number;
  readonly retryLimit: number;
  readonly maxIdLength: number;
}

export interface SpatialLayerLifecycleSnapshot {
  readonly layers: number;
  readonly activeLayers: number;
  readonly cpuBytes: number;
  readonly gpuBytes: number;
  readonly transitions: number;
  readonly failures: number;
  readonly evictions: number;
}

interface StoredLayer extends SpatialLayerDescriptor {
  phase: SpatialLayerPhase;
  sequence: number;
  failures: number;
  lastTouched: number;
}

const DEFAULT_BUDGET: SpatialLayerLifecycleBudget = Object.freeze({
  maxLayers: 512,
  maxActiveLayers: 64,
  maxCpuBytes: 512 * 1024 * 1024,
  maxGpuBytes: 768 * 1024 * 1024,
  maxFailuresPerLayer: 3,
  retryLimit: 2,
  maxIdLength: 256,
});

const PRIORITY: Readonly<Record<SpatialLayerPriority, number>> = Object.freeze({
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

function normalizeText(value: string, maxLength: number): string {
  if (typeof value !== 'string') throw new TypeError('layer id must be a string');
  const normalized = value.trim();
  if (normalized.length === 0) throw new TypeError('layer id must not be empty');
  if (normalized.length > maxLength) throw new RangeError('layer id exceeds length budget');
  return normalized;
}

function normalizeBudget(input: Partial<SpatialLayerLifecycleBudget>): SpatialLayerLifecycleBudget {
  const budget = Object.freeze({
    maxLayers: positiveSafeInteger(input.maxLayers ?? DEFAULT_BUDGET.maxLayers, 'maxLayers'),
    maxActiveLayers: positiveSafeInteger(input.maxActiveLayers ?? DEFAULT_BUDGET.maxActiveLayers, 'maxActiveLayers'),
    maxCpuBytes: positiveSafeInteger(input.maxCpuBytes ?? DEFAULT_BUDGET.maxCpuBytes, 'maxCpuBytes'),
    maxGpuBytes: positiveSafeInteger(input.maxGpuBytes ?? DEFAULT_BUDGET.maxGpuBytes, 'maxGpuBytes'),
    maxFailuresPerLayer: positiveSafeInteger(input.maxFailuresPerLayer ?? DEFAULT_BUDGET.maxFailuresPerLayer, 'maxFailuresPerLayer'),
    retryLimit: nonNegativeSafeInteger(input.retryLimit ?? DEFAULT_BUDGET.retryLimit, 'retryLimit'),
    maxIdLength: positiveSafeInteger(input.maxIdLength ?? DEFAULT_BUDGET.maxIdLength, 'maxIdLength'),
  });
  if (budget.maxActiveLayers > budget.maxLayers) throw new RangeError('maxActiveLayers must not exceed maxLayers');
  return budget;
}

function inScale(layer: SpatialLayerDescriptor, scale: number): boolean {
  const safeScale = finiteNonNegative(scale, 'scale');
  if (layer.minScale !== undefined && safeScale > layer.minScale) return false;
  if (layer.maxScale !== undefined && safeScale < layer.maxScale) return false;
  return true;
}

function isActive(phase: SpatialLayerPhase): boolean {
  return phase === 'loading' || phase === 'ready';
}

export class SpatialLayerLifecycleRuntime {
  readonly #budget: SpatialLayerLifecycleBudget;
  readonly #layers = new Map<string, StoredLayer>();
  #sequence = 0;
  #clock = 0;
  #cpuBytes = 0;
  #gpuBytes = 0;
  #transitions = 0;
  #failures = 0;
  #evictions = 0;

  constructor(budget: Partial<SpatialLayerLifecycleBudget> = {}) {
    this.#budget = normalizeBudget(budget);
  }

  register(input: SpatialLayerDescriptor): readonly string[] {
    const id = normalizeText(input.id, this.#budget.maxIdLength);
    const minScale = input.minScale === undefined ? undefined : finiteNonNegative(input.minScale, 'minScale');
    const maxScale = input.maxScale === undefined ? undefined : finiteNonNegative(input.maxScale, 'maxScale');
    if (minScale !== undefined && maxScale !== undefined && minScale < maxScale) throw new RangeError('minScale must be >= maxScale');
    const layer: StoredLayer = {
      ...input,
      id,
      estimatedCpuBytes: nonNegativeSafeInteger(input.estimatedCpuBytes, 'estimatedCpuBytes'),
      estimatedGpuBytes: nonNegativeSafeInteger(input.estimatedGpuBytes, 'estimatedGpuBytes'),
      ...(minScale === undefined ? {} : { minScale }),
      ...(maxScale === undefined ? {} : { maxScale }),
      visible: input.visible !== false,
      phase: 'registered',
      sequence: ++this.#sequence,
      failures: 0,
      lastTouched: ++this.#clock,
    };
    if (layer.estimatedCpuBytes > this.#budget.maxCpuBytes || layer.estimatedGpuBytes > this.#budget.maxGpuBytes) {
      throw new RangeError('layer exceeds lifecycle memory budget');
    }
    const previous = this.#layers.get(id);
    if (previous !== undefined) this.#remove(previous);
    this.#insert(layer);
    return this.#enforceBudgets(id);
  }

  transition(id: string, next: SpatialLayerPhase): readonly string[] {
    const layer = this.#require(id);
    if (layer.phase === 'disposed') throw new Error('disposed layer cannot transition');
    if (!this.#canTransition(layer.phase, next)) throw new Error(`invalid layer transition ${layer.phase} -> ${next}`);
    layer.phase = next;
    layer.lastTouched = ++this.#clock;
    this.#transitions += 1;
    return this.#enforceBudgets(layer.id);
  }

  markFailed(id: string): boolean {
    const layer = this.#require(id);
    if (layer.phase === 'disposed') return false;
    layer.failures += 1;
    this.#failures += 1;
    const retryBudgetExhausted = layer.failures > this.#budget.retryLimit;
    const failureBudgetExhausted = layer.failures >= this.#budget.maxFailuresPerLayer;
    layer.phase = retryBudgetExhausted || failureBudgetExhausted ? 'suspended' : 'failed';
    layer.lastTouched = ++this.#clock;
    this.#transitions += 1;
    return layer.phase === 'suspended';
  }

  retry(id: string): void {
    const layer = this.#require(id);
    if (layer.phase !== 'failed') throw new Error('only failed layers can retry');
    if (layer.failures > this.#budget.retryLimit) {
      layer.phase = 'suspended';
      throw new Error('layer retry budget exhausted');
    }
    layer.phase = 'loading';
    layer.lastTouched = ++this.#clock;
    this.#transitions += 1;
    this.#enforceBudgets(layer.id);
  }

  reconcileScale(scale: number): readonly string[] {
    finiteNonNegative(scale, 'scale');
    const suspended: string[] = [];
    for (const layer of this.#layers.values()) {
      if (layer.phase === 'disposed' || layer.visible === false) continue;
      if (inScale(layer, scale)) continue;
      if (isActive(layer.phase)) {
        layer.phase = 'suspended';
        layer.lastTouched = ++this.#clock;
        this.#transitions += 1;
        suspended.push(layer.id);
      }
    }
    return Object.freeze(suspended);
  }

  setVisible(id: string, visible: boolean): void {
    const layer = this.#require(id);
    layer.visible = visible;
    layer.lastTouched = ++this.#clock;
    if (!visible && isActive(layer.phase)) {
      layer.phase = 'suspended';
      this.#transitions += 1;
    }
  }

  dispose(id: string): boolean {
    const layer = this.#layers.get(id);
    if (layer === undefined) return false;
    layer.phase = 'disposed';
    this.#remove(layer);
    this.#transitions += 1;
    return true;
  }

  clear(): void {
    this.#layers.clear();
    this.#cpuBytes = 0;
    this.#gpuBytes = 0;
  }

  has(id: string): boolean {
    return this.#layers.has(id);
  }

  phase(id: string): SpatialLayerPhase | undefined {
    return this.#layers.get(id)?.phase;
  }

  list(): readonly Readonly<SpatialLayerDescriptor & { phase: SpatialLayerPhase; failures: number }>[] {
    return Object.freeze([...this.#layers.values()].sort((a, b) => a.sequence - b.sequence).map((layer) => Object.freeze({
      id: layer.id,
      priority: layer.priority,
      estimatedCpuBytes: layer.estimatedCpuBytes,
      estimatedGpuBytes: layer.estimatedGpuBytes,
      ...(layer.minScale === undefined ? {} : { minScale: layer.minScale }),
      ...(layer.maxScale === undefined ? {} : { maxScale: layer.maxScale }),
      visible: layer.visible,
      phase: layer.phase,
      failures: layer.failures,
    })));
  }

  snapshot(): SpatialLayerLifecycleSnapshot {
    let activeLayers = 0;
    for (const layer of this.#layers.values()) if (isActive(layer.phase)) activeLayers += 1;
    return Object.freeze({
      layers: this.#layers.size,
      activeLayers,
      cpuBytes: this.#cpuBytes,
      gpuBytes: this.#gpuBytes,
      transitions: this.#transitions,
      failures: this.#failures,
      evictions: this.#evictions,
    });
  }

  #require(id: string): StoredLayer {
    const layer = this.#layers.get(id);
    if (layer === undefined) throw new Error(`unknown spatial layer: ${id}`);
    return layer;
  }

  #canTransition(current: SpatialLayerPhase, next: SpatialLayerPhase): boolean {
    if (current === next) return true;
    if (next === 'disposed') return true;
    switch (current) {
      case 'registered': return next === 'loading' || next === 'suspended';
      case 'loading': return next === 'ready' || next === 'failed' || next === 'suspended';
      case 'ready': return next === 'loading' || next === 'failed' || next === 'suspended';
      case 'failed': return next === 'loading' || next === 'suspended';
      case 'suspended': return next === 'loading' || next === 'registered';
      case 'disposed': return false;
    }
  }

  #insert(layer: StoredLayer): void {
    this.#layers.set(layer.id, layer);
    this.#cpuBytes += layer.estimatedCpuBytes;
    this.#gpuBytes += layer.estimatedGpuBytes;
  }

  #remove(layer: StoredLayer): void {
    this.#layers.delete(layer.id);
    this.#cpuBytes -= layer.estimatedCpuBytes;
    this.#gpuBytes -= layer.estimatedGpuBytes;
  }

  #enforceBudgets(protectedId: string): readonly string[] {
    const evicted: string[] = [];
    while (this.#overBudget()) {
      const candidate = this.#selectEviction(protectedId);
      if (candidate === undefined) {
        const protectedLayer = this.#layers.get(protectedId);
        if (protectedLayer !== undefined) this.#remove(protectedLayer);
        throw new RangeError('spatial layer lifecycle budget cannot admit protected layer');
      }
      this.#remove(candidate);
      this.#evictions += 1;
      evicted.push(candidate.id);
    }
    return Object.freeze(evicted);
  }

  #overBudget(): boolean {
    let active = 0;
    for (const layer of this.#layers.values()) if (isActive(layer.phase)) active += 1;
    return this.#layers.size > this.#budget.maxLayers
      || active > this.#budget.maxActiveLayers
      || this.#cpuBytes > this.#budget.maxCpuBytes
      || this.#gpuBytes > this.#budget.maxGpuBytes;
  }

  #selectEviction(protectedId: string): StoredLayer | undefined {
    let candidate: StoredLayer | undefined;
    for (const layer of this.#layers.values()) {
      if (layer.id === protectedId || layer.priority === 'critical') continue;
      if (candidate === undefined || this.#compareEviction(layer, candidate) < 0) candidate = layer;
    }
    return candidate;
  }

  #compareEviction(a: StoredLayer, b: StoredLayer): number {
    const priority = PRIORITY[a.priority] - PRIORITY[b.priority];
    if (priority !== 0) return priority;
    const activeDelta = Number(isActive(a.phase)) - Number(isActive(b.phase));
    if (activeDelta !== 0) return activeDelta;
    if (a.lastTouched !== b.lastTouched) return a.lastTouched - b.lastTouched;
    return a.sequence - b.sequence;
  }
}
