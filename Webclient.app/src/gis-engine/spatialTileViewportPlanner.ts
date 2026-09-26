export type SpatialTileViewportPriority = 'visible' | 'nearby' | 'speculative';

export interface SpatialTileViewportCandidate {
  readonly key: string;
  readonly layerId: string;
  readonly level: number;
  readonly row: number;
  readonly column: number;
  readonly estimatedBytes: number;
  readonly priority: SpatialTileViewportPriority;
  readonly screenDistance: number;
  readonly projectedPixels: number;
  readonly variant?: string;
}

export interface SpatialTileViewportLimits {
  readonly maxCandidates: number;
  readonly maxSelected: number;
  readonly maxSelectedBytes: number;
  readonly maxPerLayer: number;
  readonly maxPerLayerBytes: number;
  readonly maxVisible: number;
  readonly maxNearby: number;
  readonly maxSpeculative: number;
  readonly minProjectedPixels: number;
  readonly maxScreenDistance: number;
  readonly minLevel: number;
  readonly maxLevel: number;
}

export interface SpatialTileViewportSelection extends SpatialTileViewportCandidate {
  readonly rank: number;
}

export interface SpatialTileViewportPlan {
  readonly selected: readonly SpatialTileViewportSelection[];
  readonly rejected: number;
  readonly duplicateCount: number;
  readonly candidateCount: number;
  readonly selectedBytes: number;
  readonly selectedByLayer: Readonly<Record<string, number>>;
  readonly selectedBytesByLayer: Readonly<Record<string, number>>;
  readonly visibleCount: number;
  readonly nearbyCount: number;
  readonly speculativeCount: number;
  readonly truncated: boolean;
}

const DEFAULT_LIMITS: SpatialTileViewportLimits = Object.freeze({
  maxCandidates: 4_096,
  maxSelected: 256,
  maxSelectedBytes: 64 * 1024 * 1024,
  maxPerLayer: 96,
  maxPerLayerBytes: 24 * 1024 * 1024,
  maxVisible: 192,
  maxNearby: 96,
  maxSpeculative: 32,
  minProjectedPixels: 1,
  maxScreenDistance: 8_192,
  minLevel: 0,
  maxLevel: 32,
});

const PRIORITY_RANK: Readonly<Record<SpatialTileViewportPriority, number>> = Object.freeze({
  visible: 0,
  nearby: 1,
  speculative: 2,
});

const KEY_PATTERN = /^[\p{L}\p{N}_.:@/ -]+$/u;

const normalizeText = (value: string, maxLength: number): string | undefined => {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maxLength || !KEY_PATTERN.test(normalized)) return undefined;
  return normalized;
};

const positiveInteger = (value: number): boolean => Number.isInteger(value) && value > 0;
const nonNegativeInteger = (value: number): boolean => Number.isInteger(value) && value >= 0;
const finiteNonNegative = (value: number): boolean => Number.isFinite(value) && value >= 0;

const validateLimits = (input: Partial<SpatialTileViewportLimits>): SpatialTileViewportLimits => {
  const limits = { ...DEFAULT_LIMITS, ...input };
  if (!positiveInteger(limits.maxCandidates) || limits.maxCandidates > 100_000) throw new RangeError('maxCandidates');
  if (!positiveInteger(limits.maxSelected) || limits.maxSelected > limits.maxCandidates) throw new RangeError('maxSelected');
  if (!positiveInteger(limits.maxSelectedBytes) || limits.maxSelectedBytes > 2 * 1024 * 1024 * 1024) throw new RangeError('maxSelectedBytes');
  if (!positiveInteger(limits.maxPerLayer) || limits.maxPerLayer > limits.maxSelected) throw new RangeError('maxPerLayer');
  if (!positiveInteger(limits.maxPerLayerBytes) || limits.maxPerLayerBytes > limits.maxSelectedBytes) throw new RangeError('maxPerLayerBytes');
  if (!nonNegativeInteger(limits.maxVisible) || limits.maxVisible > limits.maxSelected) throw new RangeError('maxVisible');
  if (!nonNegativeInteger(limits.maxNearby) || limits.maxNearby > limits.maxSelected) throw new RangeError('maxNearby');
  if (!nonNegativeInteger(limits.maxSpeculative) || limits.maxSpeculative > limits.maxSelected) throw new RangeError('maxSpeculative');
  if (!finiteNonNegative(limits.minProjectedPixels) || limits.minProjectedPixels > 1_000_000) throw new RangeError('minProjectedPixels');
  if (!finiteNonNegative(limits.maxScreenDistance) || limits.maxScreenDistance > 10_000_000) throw new RangeError('maxScreenDistance');
  if (!nonNegativeInteger(limits.minLevel) || limits.minLevel > 64) throw new RangeError('minLevel');
  if (!nonNegativeInteger(limits.maxLevel) || limits.maxLevel < limits.minLevel || limits.maxLevel > 64) throw new RangeError('maxLevel');
  return Object.freeze(limits);
};

const normalizeCandidate = (input: SpatialTileViewportCandidate): SpatialTileViewportCandidate | undefined => {
  const key = normalizeText(input.key, 180);
  const layerId = normalizeText(input.layerId, 160);
  if (!key || !layerId) return undefined;
  if (!nonNegativeInteger(input.level) || input.level > 64) return undefined;
  if (!nonNegativeInteger(input.row) || input.row > 0x7fffffff) return undefined;
  if (!nonNegativeInteger(input.column) || input.column > 0x7fffffff) return undefined;
  if (!positiveInteger(input.estimatedBytes) || input.estimatedBytes > 2 * 1024 * 1024 * 1024) return undefined;
  if (!(input.priority in PRIORITY_RANK)) return undefined;
  if (!finiteNonNegative(input.screenDistance)) return undefined;
  if (!finiteNonNegative(input.projectedPixels)) return undefined;
  const variant = input.variant === undefined ? undefined : normalizeText(input.variant, 160);
  if (input.variant !== undefined && variant === undefined) return undefined;
  return Object.freeze({
    key,
    layerId,
    level: input.level,
    row: input.row,
    column: input.column,
    estimatedBytes: input.estimatedBytes,
    priority: input.priority,
    screenDistance: input.screenDistance,
    projectedPixels: input.projectedPixels,
    ...(variant === undefined ? {} : { variant }),
  });
};

const identity = (candidate: SpatialTileViewportCandidate): string =>
  `${candidate.layerId}\u0000${candidate.level}\u0000${candidate.row}\u0000${candidate.column}\u0000${candidate.variant ?? ''}`;

const compareCandidates = (left: SpatialTileViewportCandidate, right: SpatialTileViewportCandidate): number => {
  const priority = PRIORITY_RANK[left.priority] - PRIORITY_RANK[right.priority];
  if (priority !== 0) return priority;
  if (left.screenDistance !== right.screenDistance) return left.screenDistance - right.screenDistance;
  if (left.projectedPixels !== right.projectedPixels) return right.projectedPixels - left.projectedPixels;
  if (left.level !== right.level) return right.level - left.level;
  return identity(left).localeCompare(identity(right));
};

/**
 * Pure, transport-neutral viewport planner for bounded 2D/3D tile residency.
 * It deliberately owns no ArcGIS endpoint or request carrier. The caller supplies
 * verified candidates and receives a deterministic, immutable admission plan.
 */
export class SpatialTileViewportPlanner {
  readonly #limits: SpatialTileViewportLimits;

  constructor(limits: Partial<SpatialTileViewportLimits> = {}) {
    this.#limits = validateLimits(limits);
  }

  get limits(): SpatialTileViewportLimits {
    return this.#limits;
  }

  plan(candidates: readonly SpatialTileViewportCandidate[]): SpatialTileViewportPlan {
    const boundedInput = candidates.slice(0, this.#limits.maxCandidates);
    const normalized: SpatialTileViewportCandidate[] = [];
    const seen = new Set<string>();
    let rejected = 0;
    let duplicateCount = 0;

    for (const candidate of boundedInput) {
      const clean = normalizeCandidate(candidate);
      if (!clean || !this.#withinViewportBudget(clean)) {
        rejected += 1;
        continue;
      }
      const id = identity(clean);
      if (seen.has(id)) {
        duplicateCount += 1;
        continue;
      }
      seen.add(id);
      normalized.push(clean);
    }

    normalized.sort(compareCandidates);
    const selected: SpatialTileViewportSelection[] = [];
    const selectedByLayer: Record<string, number> = {};
    const selectedBytesByLayer: Record<string, number> = {};
    const selectedByPriority: Record<SpatialTileViewportPriority, number> = {
      visible: 0,
      nearby: 0,
      speculative: 0,
    };
    let selectedBytes = 0;

    for (const candidate of normalized) {
      if (selected.length >= this.#limits.maxSelected) break;
      if (selectedBytes + candidate.estimatedBytes > this.#limits.maxSelectedBytes) continue;
      const layerCount = selectedByLayer[candidate.layerId] ?? 0;
      const layerBytes = selectedBytesByLayer[candidate.layerId] ?? 0;
      if (layerCount >= this.#limits.maxPerLayer) continue;
      if (layerBytes + candidate.estimatedBytes > this.#limits.maxPerLayerBytes) continue;
      if (selectedByPriority[candidate.priority] >= this.#priorityLimit(candidate.priority)) continue;

      selected.push(Object.freeze({ ...candidate, rank: selected.length }));
      selectedBytes += candidate.estimatedBytes;
      selectedByLayer[candidate.layerId] = layerCount + 1;
      selectedBytesByLayer[candidate.layerId] = layerBytes + candidate.estimatedBytes;
      selectedByPriority[candidate.priority] += 1;
    }

    return Object.freeze({
      selected: Object.freeze(selected),
      rejected,
      duplicateCount,
      candidateCount: boundedInput.length,
      selectedBytes,
      selectedByLayer: Object.freeze(selectedByLayer),
      selectedBytesByLayer: Object.freeze(selectedBytesByLayer),
      visibleCount: selectedByPriority.visible,
      nearbyCount: selectedByPriority.nearby,
      speculativeCount: selectedByPriority.speculative,
      truncated: candidates.length > this.#limits.maxCandidates || selected.length < normalized.length,
    });
  }

  #withinViewportBudget(candidate: SpatialTileViewportCandidate): boolean {
    if (candidate.level < this.#limits.minLevel || candidate.level > this.#limits.maxLevel) return false;
    if (candidate.projectedPixels < this.#limits.minProjectedPixels) return false;
    return candidate.screenDistance <= this.#limits.maxScreenDistance;
  }

  #priorityLimit(priority: SpatialTileViewportPriority): number {
    if (priority === 'visible') return this.#limits.maxVisible;
    if (priority === 'nearby') return this.#limits.maxNearby;
    return this.#limits.maxSpeculative;
  }
}
