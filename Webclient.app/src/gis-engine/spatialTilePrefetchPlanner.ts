export type SpatialTilePrefetchPriority = 'visible' | 'nearby' | 'speculative';

export interface SpatialTileCoordinate {
  readonly level: number;
  readonly row: number;
  readonly column: number;
}

export interface SpatialTilePrefetchCandidate extends SpatialTileCoordinate {
  readonly layerId: string;
  readonly priority: SpatialTilePrefetchPriority;
  readonly distance: number;
  readonly estimatedBytes: number;
  readonly variant?: string;
}

export interface SpatialTilePrefetchLimits {
  readonly maxCandidates: number;
  readonly maxSelected: number;
  readonly maxEstimatedBytes: number;
  readonly maxPerLayer: number;
  readonly maxLevel: number;
  readonly maxDistance: number;
}

export interface SpatialTilePrefetchPlan {
  readonly selected: readonly SpatialTilePrefetchCandidate[];
  readonly estimatedBytes: number;
  readonly considered: number;
  readonly rejectedInvalid: number;
  readonly rejectedDuplicate: number;
  readonly rejectedBudget: number;
  readonly rejectedLayerBudget: number;
  readonly truncated: boolean;
}

const DEFAULT_LIMITS: SpatialTilePrefetchLimits = Object.freeze({
  maxCandidates: 2048,
  maxSelected: 128,
  maxEstimatedBytes: 24 * 1024 * 1024,
  maxPerLayer: 48,
  maxLevel: 32,
  maxDistance: 64,
});

const PRIORITY_RANK: Readonly<Record<SpatialTilePrefetchPriority, number>> = Object.freeze({
  visible: 0,
  nearby: 1,
  speculative: 2,
});

const isFiniteNumber = (value: number): boolean => Number.isFinite(value);
const isInteger = (value: number): boolean => Number.isInteger(value);

const normalizeText = (value: string): string | undefined => {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 160) return undefined;
  if (!/^[\p{L}\p{N}_.:@/ -]+$/u.test(normalized)) return undefined;
  return normalized;
};

const normalizeCandidate = (
  candidate: SpatialTilePrefetchCandidate,
  limits: SpatialTilePrefetchLimits,
): SpatialTilePrefetchCandidate | undefined => {
  const layerId = normalizeText(candidate.layerId);
  if (!layerId) return undefined;
  if (!isInteger(candidate.level) || candidate.level < 0 || candidate.level > limits.maxLevel) return undefined;
  if (!isInteger(candidate.row) || candidate.row < 0 || candidate.row > 0x7fffffff) return undefined;
  if (!isInteger(candidate.column) || candidate.column < 0 || candidate.column > 0x7fffffff) return undefined;
  if (!isFiniteNumber(candidate.distance) || candidate.distance < 0 || candidate.distance > limits.maxDistance) return undefined;
  if (!isInteger(candidate.estimatedBytes) || candidate.estimatedBytes < 1 || candidate.estimatedBytes > limits.maxEstimatedBytes) return undefined;
  if (!(candidate.priority in PRIORITY_RANK)) return undefined;

  const variant = candidate.variant === undefined ? undefined : normalizeText(candidate.variant);
  if (candidate.variant !== undefined && variant === undefined) return undefined;

  return Object.freeze({
    layerId,
    level: candidate.level,
    row: candidate.row,
    column: candidate.column,
    priority: candidate.priority,
    distance: candidate.distance,
    estimatedBytes: candidate.estimatedBytes,
    ...(variant === undefined ? {} : { variant }),
  });
};

const fingerprint = (candidate: SpatialTilePrefetchCandidate): string => [
  candidate.layerId,
  candidate.level,
  candidate.row,
  candidate.column,
  candidate.variant ?? '',
].join(':');

const compareCandidates = (
  left: SpatialTilePrefetchCandidate,
  right: SpatialTilePrefetchCandidate,
): number => {
  const priority = PRIORITY_RANK[left.priority] - PRIORITY_RANK[right.priority];
  if (priority !== 0) return priority;
  const distance = left.distance - right.distance;
  if (distance !== 0) return distance;
  const level = right.level - left.level;
  if (level !== 0) return level;
  const bytes = left.estimatedBytes - right.estimatedBytes;
  if (bytes !== 0) return bytes;
  return fingerprint(left).localeCompare(fingerprint(right));
};

const validateLimits = (input: Partial<SpatialTilePrefetchLimits>): SpatialTilePrefetchLimits => {
  const limits = { ...DEFAULT_LIMITS, ...input };
  if (!isInteger(limits.maxCandidates) || limits.maxCandidates < 1 || limits.maxCandidates > 100_000) throw new RangeError('maxCandidates');
  if (!isInteger(limits.maxSelected) || limits.maxSelected < 1 || limits.maxSelected > limits.maxCandidates) throw new RangeError('maxSelected');
  if (!isInteger(limits.maxEstimatedBytes) || limits.maxEstimatedBytes < 1 || limits.maxEstimatedBytes > 2 * 1024 * 1024 * 1024) throw new RangeError('maxEstimatedBytes');
  if (!isInteger(limits.maxPerLayer) || limits.maxPerLayer < 1 || limits.maxPerLayer > limits.maxSelected) throw new RangeError('maxPerLayer');
  if (!isInteger(limits.maxLevel) || limits.maxLevel < 0 || limits.maxLevel > 64) throw new RangeError('maxLevel');
  if (!isFiniteNumber(limits.maxDistance) || limits.maxDistance < 0 || limits.maxDistance > 1_000_000) throw new RangeError('maxDistance');
  return Object.freeze(limits);
};

/**
 * Deterministic, transport-neutral admission planner for tile prefetch work.
 * It never performs network I/O. Callers execute the returned bounded plan through
 * their existing verified ArcGIS transport and cancellation authority.
 */
export class SpatialTilePrefetchPlanner {
  readonly #limits: SpatialTilePrefetchLimits;

  constructor(limits: Partial<SpatialTilePrefetchLimits> = {}) {
    this.#limits = validateLimits(limits);
  }

  get limits(): SpatialTilePrefetchLimits {
    return this.#limits;
  }

  plan(candidates: readonly SpatialTilePrefetchCandidate[]): SpatialTilePrefetchPlan {
    const bounded = candidates.slice(0, this.#limits.maxCandidates);
    const normalized: SpatialTilePrefetchCandidate[] = [];
    const seen = new Set<string>();
    let rejectedInvalid = 0;
    let rejectedDuplicate = 0;

    for (const candidate of bounded) {
      const valid = normalizeCandidate(candidate, this.#limits);
      if (!valid) {
        rejectedInvalid += 1;
        continue;
      }
      const id = fingerprint(valid);
      if (seen.has(id)) {
        rejectedDuplicate += 1;
        continue;
      }
      seen.add(id);
      normalized.push(valid);
    }

    normalized.sort(compareCandidates);

    const selected: SpatialTilePrefetchCandidate[] = [];
    const perLayer = new Map<string, number>();
    let estimatedBytes = 0;
    let rejectedBudget = 0;
    let rejectedLayerBudget = 0;

    for (const candidate of normalized) {
      if (selected.length >= this.#limits.maxSelected) {
        rejectedBudget += 1;
        continue;
      }

      const layerCount = perLayer.get(candidate.layerId) ?? 0;
      if (layerCount >= this.#limits.maxPerLayer) {
        rejectedLayerBudget += 1;
        continue;
      }

      if (estimatedBytes + candidate.estimatedBytes > this.#limits.maxEstimatedBytes) {
        rejectedBudget += 1;
        continue;
      }

      selected.push(candidate);
      perLayer.set(candidate.layerId, layerCount + 1);
      estimatedBytes += candidate.estimatedBytes;
    }

    return Object.freeze({
      selected: Object.freeze(selected),
      estimatedBytes,
      considered: bounded.length,
      rejectedInvalid,
      rejectedDuplicate,
      rejectedBudget,
      rejectedLayerBudget,
      truncated: candidates.length > bounded.length,
    });
  }
}