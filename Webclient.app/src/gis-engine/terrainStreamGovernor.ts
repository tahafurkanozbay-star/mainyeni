export type TerrainQuality = 'eco' | 'balanced' | 'quality';
export type TerrainPressure = 'normal' | 'elevated' | 'critical';

export interface TerrainTileSample {
  id: string;
  level: number;
  distanceMeters: number;
  screenPixels: number;
  estimatedBytes: number;
  visible: boolean;
  requestedAt?: number;
  lastUsedAt?: number;
}

export interface TerrainBudget {
  maxResidentBytes: number;
  maxResidentTiles: number;
  maxConcurrentRequests: number;
  maxLevel: number;
  minScreenPixels: number;
  prefetchRadiusMeters: number;
}

export interface TerrainDecision {
  tileId: string;
  action: 'request' | 'keep' | 'evict' | 'defer';
  score: number;
  reason: string;
}

export interface TerrainGovernorSnapshot {
  quality: TerrainQuality;
  pressure: TerrainPressure;
  residentBytes: number;
  residentTiles: number;
  activeRequests: number;
  averageFrameMs: number;
  p95FrameMs: number;
  decisions: readonly TerrainDecision[];
}

export interface TerrainStreamGovernorOptions {
  quality?: TerrainQuality;
  now?: () => number;
  frameHistorySize?: number;
  maxTilesPerPlan?: number;
  maxTileBytes?: number;
  maxTileIdLength?: number;
}

const MIB = 1024 * 1024;
const DEFAULT_MAX_TILES_PER_PLAN = 20_000;
const DEFAULT_MAX_TILE_BYTES = 128 * MIB;
const DEFAULT_MAX_TILE_ID_LENGTH = 256;

const QUALITY_BUDGETS: Readonly<Record<TerrainQuality, TerrainBudget>> = Object.freeze({
  eco: Object.freeze({
    maxResidentBytes: 192 * MIB,
    maxResidentTiles: 256,
    maxConcurrentRequests: 3,
    maxLevel: 15,
    minScreenPixels: 28,
    prefetchRadiusMeters: 800,
  }),
  balanced: Object.freeze({
    maxResidentBytes: 384 * MIB,
    maxResidentTiles: 512,
    maxConcurrentRequests: 6,
    maxLevel: 17,
    minScreenPixels: 18,
    prefetchRadiusMeters: 1_500,
  }),
  quality: Object.freeze({
    maxResidentBytes: 640 * MIB,
    maxResidentTiles: 900,
    maxConcurrentRequests: 10,
    maxLevel: 19,
    minScreenPixels: 10,
    prefetchRadiusMeters: 2_500,
  }),
});

const finite = (value: unknown, fallback = 0): number => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
};

const positiveSafeInteger = (value: unknown, fallback: number, label: string): number => {
  const resolved = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new RangeError(`${label} must be a positive safe integer`);
  }
  return resolved;
};

const finiteNonNegative = (value: unknown, label: string): number => {
  const resolved = Number(value);
  if (!Number.isFinite(resolved) || resolved < 0) {
    throw new RangeError(`${label} must be finite and non-negative`);
  }
  return Object.is(resolved, -0) ? 0 : resolved;
};

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

const percentile = (values: readonly number[], ratio: number): number => {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = clamp(Math.ceil(sorted.length * ratio) - 1, 0, sorted.length - 1);
  return sorted[index] ?? 0;
};

const tileScore = (tile: TerrainTileSample, budget: TerrainBudget, timestamp: number): number => {
  const visibility = tile.visible ? 1_000 : 0;
  const screen = clamp(finite(tile.screenPixels), 0, 4_000) * 2;
  const level = clamp(finite(tile.level), 0, budget.maxLevel) * 8;
  const distancePenalty = Math.min(500, Math.max(0, finite(tile.distanceMeters)) / 25);
  const recency = tile.lastUsedAt ? Math.max(0, 300 - (timestamp - tile.lastUsedAt) / 100) : 0;
  return visibility + screen + level + recency - distancePenalty;
};

export const terrainBudgetForQuality = (quality: TerrainQuality): TerrainBudget => QUALITY_BUDGETS[quality];

export class TerrainStreamGovernor {
  private quality: TerrainQuality;
  private pressure: TerrainPressure = 'normal';
  private readonly now: () => number;
  private readonly frameHistorySize: number;
  private readonly maxTilesPerPlan: number;
  private readonly maxTileBytes: number;
  private readonly maxTileIdLength: number;
  private readonly frames: number[] = [];
  private residentBytes = 0;
  private residentTiles = 0;
  private activeRequests = 0;
  private decisions: TerrainDecision[] = [];

  public constructor(options: TerrainStreamGovernorOptions = {}) {
    this.quality = options.quality ?? 'balanced';
    this.now = options.now ?? Date.now;
    this.frameHistorySize = Math.max(16, Math.min(240, Math.floor(finite(options.frameHistorySize, 90))));
    this.maxTilesPerPlan = positiveSafeInteger(
      options.maxTilesPerPlan,
      DEFAULT_MAX_TILES_PER_PLAN,
      'maxTilesPerPlan',
    );
    this.maxTileBytes = positiveSafeInteger(options.maxTileBytes, DEFAULT_MAX_TILE_BYTES, 'maxTileBytes');
    this.maxTileIdLength = positiveSafeInteger(
      options.maxTileIdLength,
      DEFAULT_MAX_TILE_ID_LENGTH,
      'maxTileIdLength',
    );
  }

  public setQuality(quality: TerrainQuality): TerrainGovernorSnapshot {
    this.quality = quality;
    this.recalculatePressure();
    return this.getSnapshot();
  }

  public recordFrame(durationMs: unknown): TerrainGovernorSnapshot {
    const duration = finite(durationMs, -1);
    if (duration > 0 && duration < 2_000) {
      this.frames.push(duration);
      if (this.frames.length > this.frameHistorySize) {
        this.frames.splice(0, this.frames.length - this.frameHistorySize);
      }
      this.recalculatePressure();
    }
    return this.getSnapshot();
  }

  public setResidentUsage(bytes: unknown, tiles: unknown): TerrainGovernorSnapshot {
    this.residentBytes = Math.max(0, Math.floor(finite(bytes)));
    this.residentTiles = Math.max(0, Math.floor(finite(tiles)));
    this.recalculatePressure();
    return this.getSnapshot();
  }

  public setActiveRequests(count: unknown): TerrainGovernorSnapshot {
    this.activeRequests = Math.max(0, Math.floor(finite(count)));
    this.recalculatePressure();
    return this.getSnapshot();
  }

  public plan(tiles: readonly TerrainTileSample[]): TerrainGovernorSnapshot {
    if (tiles.length > this.maxTilesPerPlan) {
      throw new RangeError('terrain plan exceeds configured tile budget');
    }

    const budget = terrainBudgetForQuality(this.quality);
    const timestamp = finiteNonNegative(this.now(), 'terrain clock');
    const pressureMultiplier = this.pressure === 'critical' ? 0.55 : this.pressure === 'elevated' ? 0.8 : 1;
    const effectiveMinPixels = budget.minScreenPixels / pressureMultiplier;
    const requestSlots = Math.max(
      0,
      Math.floor(budget.maxConcurrentRequests * pressureMultiplier) - this.activeRequests,
    );

    const seenIds = new Set<string>();
    const scored = tiles.map((input) => {
      if (typeof input.id !== 'string') throw new TypeError('terrain tile id must be a string');
      const id = input.id.trim();
      if (id.length === 0) throw new TypeError('terrain tile id is required');
      if (id.length > this.maxTileIdLength) throw new RangeError('terrain tile id exceeds length budget');
      if (seenIds.has(id)) throw new TypeError(`duplicate terrain tile id: ${id}`);
      seenIds.add(id);

      const estimatedBytes = Math.floor(finiteNonNegative(input.estimatedBytes, 'terrain tile estimatedBytes'));
      if (estimatedBytes > this.maxTileBytes) {
        return {
          tile: Object.freeze({
            ...input,
            id,
            level: finiteNonNegative(input.level, 'terrain tile level'),
            distanceMeters: finiteNonNegative(input.distanceMeters, 'terrain tile distanceMeters'),
            screenPixels: finiteNonNegative(input.screenPixels, 'terrain tile screenPixels'),
            estimatedBytes,
            ...(input.requestedAt === undefined
              ? {}
              : { requestedAt: finiteNonNegative(input.requestedAt, 'terrain tile requestedAt') }),
            ...(input.lastUsedAt === undefined
              ? {}
              : { lastUsedAt: finiteNonNegative(input.lastUsedAt, 'terrain tile lastUsedAt') }),
          }),
          score: Number.NEGATIVE_INFINITY,
          oversized: true,
        };
      }

      const tile: TerrainTileSample = Object.freeze({
        ...input,
        id,
        level: finiteNonNegative(input.level, 'terrain tile level'),
        distanceMeters: finiteNonNegative(input.distanceMeters, 'terrain tile distanceMeters'),
        screenPixels: finiteNonNegative(input.screenPixels, 'terrain tile screenPixels'),
        estimatedBytes,
        ...(input.requestedAt === undefined
          ? {}
          : { requestedAt: finiteNonNegative(input.requestedAt, 'terrain tile requestedAt') }),
        ...(input.lastUsedAt === undefined
          ? {}
          : { lastUsedAt: finiteNonNegative(input.lastUsedAt, 'terrain tile lastUsedAt') }),
      });
      return { tile, score: tileScore(tile, budget, timestamp), oversized: false };
    });

    scored.sort((left, right) => {
      if (left.score !== right.score) return right.score - left.score;
      return left.tile.id.localeCompare(right.tile.id);
    });

    let requestsRemaining = requestSlots;
    let projectedBytes = this.residentBytes;
    let projectedTiles = this.residentTiles;
    const decisions: TerrainDecision[] = [];

    for (const { tile, score, oversized } of scored) {
      const bytes = tile.estimatedBytes;
      if (oversized) {
        decisions.push(Object.freeze({
          tileId: tile.id,
          action: tile.visible ? 'defer' : 'evict',
          score,
          reason: 'tile-memory-budget',
        }));
        continue;
      }

      const tooDetailed = tile.level > budget.maxLevel;
      const tooSmall = tile.screenPixels < effectiveMinPixels;
      const tooFar = !tile.visible && tile.distanceMeters > budget.prefetchRadiusMeters;
      const overByteBudget = projectedBytes + bytes > budget.maxResidentBytes;
      const overTileBudget = projectedTiles + 1 > budget.maxResidentTiles;

      if (tooDetailed || tooSmall || tooFar) {
        decisions.push(Object.freeze({
          tileId: tile.id,
          action: tile.visible ? 'defer' : 'evict',
          score,
          reason: tooDetailed ? 'lod-cap' : tooSmall ? 'screen-error' : 'prefetch-radius',
        }));
        continue;
      }

      if (overByteBudget || overTileBudget) {
        decisions.push(Object.freeze({
          tileId: tile.id,
          action: tile.visible ? 'defer' : 'evict',
          score,
          reason: overByteBudget ? 'memory-budget' : 'tile-budget',
        }));
        continue;
      }

      if (tile.requestedAt !== undefined) {
        decisions.push(Object.freeze({
          tileId: tile.id,
          action: 'keep',
          score,
          reason: 'already-requested',
        }));
        projectedBytes += bytes;
        projectedTiles += 1;
        continue;
      }

      if (requestsRemaining > 0) {
        decisions.push(Object.freeze({
          tileId: tile.id,
          action: 'request',
          score,
          reason: tile.visible ? 'visible' : 'prefetch',
        }));
        requestsRemaining -= 1;
        projectedBytes += bytes;
        projectedTiles += 1;
      } else {
        decisions.push(Object.freeze({
          tileId: tile.id,
          action: 'defer',
          score,
          reason: 'request-concurrency',
        }));
      }
    }

    this.decisions = decisions;
    return this.getSnapshot();
  }

  private recalculatePressure(): void {
    const budget = terrainBudgetForQuality(this.quality);
    const p95 = percentile(this.frames, 0.95);
    const memoryRatio = budget.maxResidentBytes > 0 ? this.residentBytes / budget.maxResidentBytes : 0;
    const tileRatio = budget.maxResidentTiles > 0 ? this.residentTiles / budget.maxResidentTiles : 0;
    const requestRatio = budget.maxConcurrentRequests > 0 ? this.activeRequests / budget.maxConcurrentRequests : 0;
    const frameTarget = this.quality === 'eco' ? 33.34 : this.quality === 'balanced' ? 20 : 16.67;
    const frameRatio = p95 > 0 ? p95 / frameTarget : 0;
    const worst = Math.max(memoryRatio, tileRatio, requestRatio, frameRatio);
    this.pressure = worst >= 1.15 ? 'critical' : worst >= 0.85 ? 'elevated' : 'normal';
  }

  public getSnapshot(): TerrainGovernorSnapshot {
    const averageFrameMs = this.frames.length
      ? this.frames.reduce((sum, value) => sum + value, 0) / this.frames.length
      : 0;
    return Object.freeze({
      quality: this.quality,
      pressure: this.pressure,
      residentBytes: this.residentBytes,
      residentTiles: this.residentTiles,
      activeRequests: this.activeRequests,
      averageFrameMs,
      p95FrameMs: percentile(this.frames, 0.95),
      decisions: Object.freeze([...this.decisions]),
    });
  }
}
