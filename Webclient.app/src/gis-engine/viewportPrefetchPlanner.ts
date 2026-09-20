import type { ViewportQueryExtent } from './viewportQueryPolicy';
import type { ViewportBudgetProfile } from './viewportBudgetController';

export type ViewportPrefetchViewMode = '2d' | '3d';

export interface ViewportMotionVector {
  readonly velocityXPxPerSecond: number;
  readonly velocityYPxPerSecond: number;
  readonly zoomVelocityPerSecond?: number;
}

export interface ViewportPrefetchInput {
  readonly extent: ViewportQueryExtent;
  readonly scale: number;
  readonly pixelWidth: number;
  readonly pixelHeight: number;
  readonly viewMode: ViewportPrefetchViewMode;
  readonly motion: ViewportMotionVector;
  readonly budgetProfile?: Pick<ViewportBudgetProfile, 'pressure' | 'prefetchFactor'>;
}

export type ViewportPrefetchReason =
  | 'pan-primary'
  | 'pan-forward'
  | 'pan-left'
  | 'pan-right'
  | 'pan-forward-left'
  | 'pan-forward-right'
  | 'zoom-out';

export interface ViewportPrefetchCandidate {
  readonly key: string;
  readonly extent: ViewportQueryExtent;
  readonly scale: number;
  readonly score: number;
  readonly reason: ViewportPrefetchReason;
  readonly viewMode: ViewportPrefetchViewMode;
  readonly predictedDistancePx: number;
}

export interface ViewportPrefetchPlan {
  readonly fingerprint: string;
  readonly moving: boolean;
  readonly speedPxPerSecond: number;
  readonly candidateBudget: number;
  readonly candidates: readonly ViewportPrefetchCandidate[];
  readonly suppressedCandidates: number;
}

export interface ViewportPrefetchPlannerConfiguration {
  readonly maxCandidates: number;
  readonly lookaheadMs: number;
  readonly maximumShiftViewports: number;
  readonly neighborStrideFactor: number;
  readonly minimumVelocityPxPerSecond: number;
  readonly minimumZoomVelocityPerSecond: number;
  readonly maximumZoomOutFactor: number;
  readonly coordinatePrecision: number;
  readonly maximumSpatialReferenceLength: number;
}

export interface ViewportPrefetchPlannerSnapshot {
  readonly plans: number;
  readonly movingPlans: number;
  readonly idlePlans: number;
  readonly candidates: number;
  readonly suppressedCandidates: number;
  readonly lastFingerprint: string | null;
}

const DEFAULT_CONFIGURATION: ViewportPrefetchPlannerConfiguration = Object.freeze({
  maxCandidates: 8,
  lookaheadMs: 650,
  maximumShiftViewports: 1.5,
  neighborStrideFactor: 0.7,
  minimumVelocityPxPerSecond: 24,
  minimumZoomVelocityPerSecond: 0.08,
  maximumZoomOutFactor: 1.8,
  coordinatePrecision: 6,
  maximumSpatialReferenceLength: 128,
});

interface CandidateSeed {
  readonly extent: ViewportQueryExtent;
  readonly scale: number;
  readonly score: number;
  readonly reason: ViewportPrefetchReason;
  readonly predictedDistancePx: number;
}

const finitePositive = (value: number, label: string): number => {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(label + ' must be a finite positive number');
  }
  return value;
};

const finiteNonNegative = (value: number, label: string): number => {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(label + ' must be finite and non-negative');
  }
  return Object.is(value, -0) ? 0 : value;
};

const finite = (value: number, label: string): number => {
  if (!Number.isFinite(value)) throw new RangeError(label + ' must be finite');
  return Object.is(value, -0) ? 0 : value;
};

const positiveSafeInteger = (value: number, label: string): number => {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(label + ' must be a positive safe integer');
  }
  return value;
};

const normalizeConfiguration = (
  input: Partial<ViewportPrefetchPlannerConfiguration>,
): ViewportPrefetchPlannerConfiguration => {
  const resolved = { ...DEFAULT_CONFIGURATION, ...input };
  const maxCandidates = positiveSafeInteger(resolved.maxCandidates, 'maxCandidates');
  const lookaheadMs = finitePositive(resolved.lookaheadMs, 'lookaheadMs');
  const maximumShiftViewports = finitePositive(
    resolved.maximumShiftViewports,
    'maximumShiftViewports',
  );
  const neighborStrideFactor = finitePositive(
    resolved.neighborStrideFactor,
    'neighborStrideFactor',
  );
  const minimumVelocityPxPerSecond = finiteNonNegative(
    resolved.minimumVelocityPxPerSecond,
    'minimumVelocityPxPerSecond',
  );
  const minimumZoomVelocityPerSecond = finiteNonNegative(
    resolved.minimumZoomVelocityPerSecond,
    'minimumZoomVelocityPerSecond',
  );
  const maximumZoomOutFactor = finitePositive(
    resolved.maximumZoomOutFactor,
    'maximumZoomOutFactor',
  );
  const coordinatePrecision = resolved.coordinatePrecision;
  const maximumSpatialReferenceLength = positiveSafeInteger(
    resolved.maximumSpatialReferenceLength,
    'maximumSpatialReferenceLength',
  );

  if (maxCandidates > 64) {
    throw new RangeError('maxCandidates exceeds the bounded prefetch budget');
  }
  if (lookaheadMs > 10_000) {
    throw new RangeError('lookaheadMs exceeds the bounded prediction horizon');
  }
  if (maximumShiftViewports > 8) {
    throw new RangeError('maximumShiftViewports exceeds the safe prediction bound');
  }
  if (neighborStrideFactor > 4) {
    throw new RangeError('neighborStrideFactor exceeds the safe prediction bound');
  }
  if (maximumZoomOutFactor < 1 || maximumZoomOutFactor > 4) {
    throw new RangeError('maximumZoomOutFactor must be between 1 and 4');
  }
  if (
    !Number.isInteger(coordinatePrecision)
    || coordinatePrecision < 0
    || coordinatePrecision > 12
  ) {
    throw new RangeError('coordinatePrecision must be an integer from 0 through 12');
  }

  return Object.freeze({
    maxCandidates,
    lookaheadMs,
    maximumShiftViewports,
    neighborStrideFactor,
    minimumVelocityPxPerSecond,
    minimumZoomVelocityPerSecond,
    maximumZoomOutFactor,
    coordinatePrecision,
    maximumSpatialReferenceLength,
  });
};

const normalizeSpatialReference = (value: string, maxLength: number): string => {
  const normalized = value.trim();
  if (!normalized) throw new TypeError('prefetch spatialReference is required');
  if (normalized.length > maxLength) {
    throw new RangeError('prefetch spatialReference exceeds configured length budget');
  }
  return normalized;
};

const normalizeExtent = (
  extent: ViewportQueryExtent,
  maxSpatialReferenceLength: number,
): ViewportQueryExtent => {
  const values = [extent.xmin, extent.ymin, extent.xmax, extent.ymax];
  if (!values.every(Number.isFinite)) {
    throw new TypeError('prefetch extent coordinates must be finite');
  }
  if (extent.xmin >= extent.xmax || extent.ymin >= extent.ymax) {
    throw new RangeError('prefetch extent must have positive width and height');
  }
  return Object.freeze({
    xmin: extent.xmin,
    ymin: extent.ymin,
    xmax: extent.xmax,
    ymax: extent.ymax,
    spatialReference: normalizeSpatialReference(
      extent.spatialReference,
      maxSpatialReferenceLength,
    ),
  });
};

const translateExtent = (
  extent: ViewportQueryExtent,
  dx: number,
  dy: number,
): ViewportQueryExtent => Object.freeze({
  xmin: extent.xmin + dx,
  ymin: extent.ymin + dy,
  xmax: extent.xmax + dx,
  ymax: extent.ymax + dy,
  spatialReference: extent.spatialReference,
});

const expandExtent = (
  extent: ViewportQueryExtent,
  factor: number,
): ViewportQueryExtent => {
  const centerX = (extent.xmin + extent.xmax) / 2;
  const centerY = (extent.ymin + extent.ymax) / 2;
  const halfWidth = (extent.xmax - extent.xmin) * factor / 2;
  const halfHeight = (extent.ymax - extent.ymin) * factor / 2;
  return Object.freeze({
    xmin: centerX - halfWidth,
    ymin: centerY - halfHeight,
    xmax: centerX + halfWidth,
    ymax: centerY + halfHeight,
    spatialReference: extent.spatialReference,
  });
};

const clamp = (value: number, min: number, max: number): number => (
  Math.min(max, Math.max(min, value))
);

const length = (x: number, y: number): number => Math.sqrt(x * x + y * y);

const stableHash = (value: string): string => {
  let state = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    state = Math.imul(state ^ value.charCodeAt(index), 0x01000193);
  }
  return (state >>> 0).toString(16).padStart(8, '0');
};

const rounded = (value: number, precision: number): string => value.toFixed(precision);

const candidateKey = (
  extent: ViewportQueryExtent,
  scale: number,
  viewMode: ViewportPrefetchViewMode,
  precision: number,
): string => [
  'viewport-prefetch',
  viewMode,
  extent.spatialReference,
  rounded(extent.xmin, precision),
  rounded(extent.ymin, precision),
  rounded(extent.xmax, precision),
  rounded(extent.ymax, precision),
  Math.round(scale),
].join('|');

const dedupeSeeds = (
  seeds: readonly CandidateSeed[],
  viewMode: ViewportPrefetchViewMode,
  precision: number,
): readonly ViewportPrefetchCandidate[] => {
  const seen = new Set<string>();
  const output: ViewportPrefetchCandidate[] = [];
  for (const seed of seeds) {
    const key = candidateKey(seed.extent, seed.scale, viewMode, precision);
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(Object.freeze({
      key,
      extent: seed.extent,
      scale: seed.scale,
      score: seed.score,
      reason: seed.reason,
      viewMode,
      predictedDistancePx: seed.predictedDistancePx,
    }));
  }
  return Object.freeze(output);
};

const normalizedBudgetFactor = (
  profile: ViewportPrefetchInput['budgetProfile'],
): number => {
  if (!profile) return 1;
  const factor = profile.prefetchFactor;
  if (!Number.isFinite(factor) || factor < 0 || factor > 1) {
    throw new RangeError('prefetchFactor must be between 0 and 1');
  }
  return factor;
};

const compareCandidate = (
  left: ViewportPrefetchCandidate,
  right: ViewportPrefetchCandidate,
): number => (
  right.score - left.score
  || left.predictedDistancePx - right.predictedDistancePx
  || left.key.localeCompare(right.key)
);

export class ViewportPrefetchPlanner {
  readonly #configuration: ViewportPrefetchPlannerConfiguration;
  #plans = 0;
  #movingPlans = 0;
  #idlePlans = 0;
  #candidates = 0;
  #suppressedCandidates = 0;
  #lastFingerprint: string | null = null;

  constructor(configuration: Partial<ViewportPrefetchPlannerConfiguration> = {}) {
    this.#configuration = normalizeConfiguration(configuration);
  }

  get configuration(): ViewportPrefetchPlannerConfiguration {
    return this.#configuration;
  }

  plan(input: ViewportPrefetchInput): ViewportPrefetchPlan {
    const extent = normalizeExtent(
      input.extent,
      this.#configuration.maximumSpatialReferenceLength,
    );
    const scale = finitePositive(input.scale, 'prefetch scale');
    const pixelWidth = finitePositive(input.pixelWidth, 'prefetch pixelWidth');
    const pixelHeight = finitePositive(input.pixelHeight, 'prefetch pixelHeight');
    const velocityX = finite(
      input.motion.velocityXPxPerSecond,
      'velocityXPxPerSecond',
    );
    const velocityY = finite(
      input.motion.velocityYPxPerSecond,
      'velocityYPxPerSecond',
    );
    const zoomVelocity = input.motion.zoomVelocityPerSecond === undefined
      ? 0
      : finite(input.motion.zoomVelocityPerSecond, 'zoomVelocityPerSecond');
    const speed = length(velocityX, velocityY);
    const moving = speed >= this.#configuration.minimumVelocityPxPerSecond
      || Math.abs(zoomVelocity) >= this.#configuration.minimumZoomVelocityPerSecond;
    const budgetFactor = normalizedBudgetFactor(input.budgetProfile);
    const candidateBudget = moving && budgetFactor > 0
      ? Math.max(1, Math.min(
        this.#configuration.maxCandidates,
        Math.floor(this.#configuration.maxCandidates * budgetFactor),
      ))
      : 0;

    this.#plans += 1;
    if (!moving || candidateBudget === 0) {
      this.#idlePlans += 1;
      const fingerprint = stableHash([
        'idle',
        input.viewMode,
        extent.spatialReference,
        rounded(extent.xmin, this.#configuration.coordinatePrecision),
        rounded(extent.ymin, this.#configuration.coordinatePrecision),
        rounded(extent.xmax, this.#configuration.coordinatePrecision),
        rounded(extent.ymax, this.#configuration.coordinatePrecision),
        Math.round(scale),
      ].join('|'));
      this.#lastFingerprint = fingerprint;
      return Object.freeze({
        fingerprint,
        moving: false,
        speedPxPerSecond: speed,
        candidateBudget,
        candidates: Object.freeze([]),
        suppressedCandidates: 0,
      });
    }

    this.#movingPlans += 1;
    const viewportWidth = extent.xmax - extent.xmin;
    const viewportHeight = extent.ymax - extent.ymin;
    const mapUnitsPerPixelX = viewportWidth / pixelWidth;
    const mapUnitsPerPixelY = viewportHeight / pixelHeight;
    const lookaheadSeconds = this.#configuration.lookaheadMs / 1_000;
    const maximumShiftX = viewportWidth * this.#configuration.maximumShiftViewports;
    const maximumShiftY = viewportHeight * this.#configuration.maximumShiftViewports;
    const primaryDx = clamp(
      velocityX * lookaheadSeconds * mapUnitsPerPixelX,
      -maximumShiftX,
      maximumShiftX,
    );
    const primaryDy = clamp(
      -velocityY * lookaheadSeconds * mapUnitsPerPixelY,
      -maximumShiftY,
      maximumShiftY,
    );
    const primaryDistancePx = length(
      primaryDx / mapUnitsPerPixelX,
      primaryDy / mapUnitsPerPixelY,
    );

    const directionLength = length(primaryDx, primaryDy);
    const unitX = directionLength > 0 ? primaryDx / directionLength : 0;
    const unitY = directionLength > 0 ? primaryDy / directionLength : 0;
    const perpendicularX = -unitY;
    const perpendicularY = unitX;
    const strideX = viewportWidth * this.#configuration.neighborStrideFactor;
    const strideY = viewportHeight * this.#configuration.neighborStrideFactor;
    const sideDx = perpendicularX * strideX;
    const sideDy = perpendicularY * strideY;
    const forwardDx = unitX * strideX;
    const forwardDy = unitY * strideY;
    const primary = translateExtent(extent, primaryDx, primaryDy);
    const seeds: CandidateSeed[] = [];

    if (speed >= this.#configuration.minimumVelocityPxPerSecond) {
      seeds.push({
        extent: primary,
        scale,
        score: input.viewMode === '3d' ? 110 : 100,
        reason: 'pan-primary',
        predictedDistancePx: primaryDistancePx,
      });
      seeds.push({
        extent: translateExtent(primary, forwardDx, forwardDy),
        scale,
        score: input.viewMode === '3d' ? 96 : 90,
        reason: 'pan-forward',
        predictedDistancePx: primaryDistancePx + this.#configuration.neighborStrideFactor * pixelWidth,
      });
      seeds.push({
        extent: translateExtent(primary, sideDx, sideDy),
        scale,
        score: input.viewMode === '3d' ? 58 : 64,
        reason: 'pan-left',
        predictedDistancePx: primaryDistancePx + this.#configuration.neighborStrideFactor * pixelWidth,
      });
      seeds.push({
        extent: translateExtent(primary, -sideDx, -sideDy),
        scale,
        score: input.viewMode === '3d' ? 58 : 64,
        reason: 'pan-right',
        predictedDistancePx: primaryDistancePx + this.#configuration.neighborStrideFactor * pixelWidth,
      });
      seeds.push({
        extent: translateExtent(primary, forwardDx + sideDx, forwardDy + sideDy),
        scale,
        score: input.viewMode === '3d' ? 72 : 76,
        reason: 'pan-forward-left',
        predictedDistancePx: primaryDistancePx + this.#configuration.neighborStrideFactor * pixelWidth * 1.4,
      });
      seeds.push({
        extent: translateExtent(primary, forwardDx - sideDx, forwardDy - sideDy),
        scale,
        score: input.viewMode === '3d' ? 72 : 76,
        reason: 'pan-forward-right',
        predictedDistancePx: primaryDistancePx + this.#configuration.neighborStrideFactor * pixelWidth * 1.4,
      });
    }

    if (zoomVelocity > 0 && zoomVelocity >= this.#configuration.minimumZoomVelocityPerSecond) {
      const expansion = clamp(
        1 + zoomVelocity * lookaheadSeconds * 0.35,
        1,
        this.#configuration.maximumZoomOutFactor,
      );
      seeds.push({
        extent: expandExtent(primary, expansion),
        scale: scale * expansion,
        score: input.viewMode === '3d' ? 88 : 82,
        reason: 'zoom-out',
        predictedDistancePx: primaryDistancePx,
      });
    }

    const unique = dedupeSeeds(
      seeds,
      input.viewMode,
      this.#configuration.coordinatePrecision,
    );
    const sorted = [...unique].sort(compareCandidate);
    const selected = Object.freeze(sorted.slice(0, candidateBudget));
    const suppressedCandidates = Math.max(0, sorted.length - selected.length);
    const fingerprint = stableHash(selected.map((candidate) => candidate.key).join('||'));

    this.#candidates += selected.length;
    this.#suppressedCandidates += suppressedCandidates;
    this.#lastFingerprint = fingerprint;

    return Object.freeze({
      fingerprint,
      moving: true,
      speedPxPerSecond: speed,
      candidateBudget,
      candidates: selected,
      suppressedCandidates,
    });
  }

  cancelKeys(
    previousKeys: readonly string[],
    nextPlan: ViewportPrefetchPlan,
  ): readonly string[] {
    const current = new Set(nextPlan.candidates.map((candidate) => candidate.key));
    const stale = new Set<string>();
    for (const key of previousKeys) {
      const normalized = String(key).trim();
      if (!normalized || current.has(normalized)) continue;
      stale.add(normalized);
    }
    return Object.freeze([...stale].sort((left, right) => left.localeCompare(right)));
  }

  snapshot(): ViewportPrefetchPlannerSnapshot {
    return Object.freeze({
      plans: this.#plans,
      movingPlans: this.#movingPlans,
      idlePlans: this.#idlePlans,
      candidates: this.#candidates,
      suppressedCandidates: this.#suppressedCandidates,
      lastFingerprint: this.#lastFingerprint,
    });
  }

  reset(): ViewportPrefetchPlannerSnapshot {
    this.#plans = 0;
    this.#movingPlans = 0;
    this.#idlePlans = 0;
    this.#candidates = 0;
    this.#suppressedCandidates = 0;
    this.#lastFingerprint = null;
    return this.snapshot();
  }
}

export const createViewportPrefetchPlanner = (
  configuration: Partial<ViewportPrefetchPlannerConfiguration> = {},
): ViewportPrefetchPlanner => new ViewportPrefetchPlanner(configuration);
