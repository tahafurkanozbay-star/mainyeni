export type ViewportQueryPriority = 'interactive' | 'foreground' | 'prefetch';

export interface ViewportQueryExtent {
  readonly xmin: number;
  readonly ymin: number;
  readonly xmax: number;
  readonly ymax: number;
  readonly spatialReference: string;
}

export interface ViewportQueryInput {
  readonly layerId: string;
  readonly extent: ViewportQueryExtent;
  readonly scale: number;
  readonly pixelWidth: number;
  readonly pixelHeight: number;
  readonly priority?: ViewportQueryPriority;
  readonly requestedFields?: readonly string[];
  readonly includeGeometry?: boolean;
  readonly estimatedFeatureDensity?: number;
  readonly moving?: boolean;
}

export interface ViewportQueryPolicyConfiguration {
  readonly maxFeatures: number;
  readonly maxFields: number;
  readonly maxPixelArea: number;
  readonly maxExtentArea: number;
  readonly minScale: number;
  readonly maxScale: number;
  readonly movingFeatureFactor: number;
  readonly prefetchFeatureFactor: number;
  readonly extentPrecision: number;
}

export interface ViewportQueryPlan {
  readonly key: string;
  readonly layerId: string;
  readonly extent: ViewportQueryExtent;
  readonly scale: number;
  readonly priority: ViewportQueryPriority;
  readonly maxFeatures: number;
  readonly fields: readonly string[];
  readonly includeGeometry: boolean;
  readonly estimatedFeatures: number | null;
  readonly pressure: 'low' | 'medium' | 'high';
  readonly warnings: readonly string[];
}

const DEFAULTS: ViewportQueryPolicyConfiguration = Object.freeze({
  maxFeatures: 5_000,
  maxFields: 32,
  maxPixelArea: 8_294_400,
  maxExtentArea: Number.MAX_SAFE_INTEGER,
  minScale: 1,
  maxScale: 1_000_000_000,
  movingFeatureFactor: 0.35,
  prefetchFeatureFactor: 0.5,
  extentPrecision: 6,
});

const finitePositive = (value: number, name: string): number => {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${name} must be a finite positive number`);
  return value;
};

const normalizeConfiguration = (
  input: Partial<ViewportQueryPolicyConfiguration> = {},
): ViewportQueryPolicyConfiguration => {
  const configuration = { ...DEFAULTS, ...input };
  finitePositive(configuration.maxFeatures, 'maxFeatures');
  finitePositive(configuration.maxFields, 'maxFields');
  finitePositive(configuration.maxPixelArea, 'maxPixelArea');
  finitePositive(configuration.maxExtentArea, 'maxExtentArea');
  finitePositive(configuration.minScale, 'minScale');
  finitePositive(configuration.maxScale, 'maxScale');
  finitePositive(configuration.movingFeatureFactor, 'movingFeatureFactor');
  finitePositive(configuration.prefetchFeatureFactor, 'prefetchFeatureFactor');
  if (configuration.minScale > configuration.maxScale) throw new RangeError('minScale cannot exceed maxScale');
  if (!Number.isInteger(configuration.extentPrecision) || configuration.extentPrecision < 0 || configuration.extentPrecision > 12) {
    throw new RangeError('extentPrecision must be an integer from 0 through 12');
  }
  return Object.freeze(configuration);
};

const normalizeLayerId = (value: string): string => {
  const normalized = value.trim();
  if (!normalized) throw new TypeError('layerId is required');
  if (normalized.length > 256) throw new RangeError('layerId exceeds 256 characters');
  return normalized;
};

const normalizeSpatialReference = (value: string): string => {
  const normalized = value.trim();
  if (!normalized) throw new TypeError('extent spatialReference is required');
  if (normalized.length > 128) throw new RangeError('extent spatialReference exceeds 128 characters');
  return normalized;
};

const normalizeExtent = (extent: ViewportQueryExtent): ViewportQueryExtent => {
  const coordinates = [extent.xmin, extent.ymin, extent.xmax, extent.ymax];
  if (!coordinates.every(Number.isFinite)) throw new TypeError('extent coordinates must be finite');
  if (extent.xmin >= extent.xmax || extent.ymin >= extent.ymax) throw new RangeError('extent must have positive width and height');
  return Object.freeze({
    xmin: extent.xmin,
    ymin: extent.ymin,
    xmax: extent.xmax,
    ymax: extent.ymax,
    spatialReference: normalizeSpatialReference(extent.spatialReference),
  });
};

const extentArea = (extent: ViewportQueryExtent): number => {
  const width = extent.xmax - extent.xmin;
  const height = extent.ymax - extent.ymin;
  const area = width * height;
  return Number.isFinite(area) ? area : Number.POSITIVE_INFINITY;
};

const normalizeFields = (fields: readonly string[] | undefined, maxFields: number): readonly string[] => {
  if (!fields) return Object.freeze([]);
  const unique = new Set<string>();
  for (const field of fields) {
    const normalized = field.trim();
    if (!normalized) continue;
    if (normalized.length > 128) throw new RangeError('field name exceeds 128 characters');
    unique.add(normalized);
    if (unique.size > maxFields) throw new RangeError(`requested fields exceed maxFields (${maxFields})`);
  }
  return Object.freeze([...unique].sort((left, right) => left.localeCompare(right)));
};

const priorityFactor = (priority: ViewportQueryPriority, configuration: ViewportQueryPolicyConfiguration): number =>
  priority === 'prefetch' ? configuration.prefetchFeatureFactor : 1;

const clampBudget = (value: number, maximum: number): number => Math.max(1, Math.min(maximum, Math.floor(value)));

const queryKey = (
  layerId: string,
  extent: ViewportQueryExtent,
  scale: number,
  fields: readonly string[],
  includeGeometry: boolean,
  precision: number,
): string => {
  const coordinate = (value: number) => value.toFixed(precision);
  return [
    layerId,
    extent.spatialReference,
    coordinate(extent.xmin),
    coordinate(extent.ymin),
    coordinate(extent.xmax),
    coordinate(extent.ymax),
    Math.round(scale),
    includeGeometry ? 'g1' : 'g0',
    fields.join(','),
  ].join('|');
};

export class ViewportQueryPolicy {
  readonly #configuration: ViewportQueryPolicyConfiguration;

  constructor(configuration: Partial<ViewportQueryPolicyConfiguration> = {}) {
    this.#configuration = normalizeConfiguration(configuration);
  }

  get configuration(): ViewportQueryPolicyConfiguration {
    return this.#configuration;
  }

  plan(input: ViewportQueryInput): ViewportQueryPlan {
    const layerId = normalizeLayerId(input.layerId);
    const extent = normalizeExtent(input.extent);
    const scale = finitePositive(input.scale, 'scale');
    const pixelWidth = finitePositive(input.pixelWidth, 'pixelWidth');
    const pixelHeight = finitePositive(input.pixelHeight, 'pixelHeight');
    const pixelArea = pixelWidth * pixelHeight;
    if (!Number.isFinite(pixelArea) || pixelArea > this.#configuration.maxPixelArea) {
      throw new RangeError(`viewport pixel area exceeds maxPixelArea (${this.#configuration.maxPixelArea})`);
    }
    if (scale < this.#configuration.minScale || scale > this.#configuration.maxScale) {
      throw new RangeError(`scale ${scale} is outside configured query range`);
    }
    const area = extentArea(extent);
    if (area > this.#configuration.maxExtentArea) {
      throw new RangeError(`extent area exceeds maxExtentArea (${this.#configuration.maxExtentArea})`);
    }

    const priority = input.priority ?? 'foreground';
    const fields = normalizeFields(input.requestedFields, this.#configuration.maxFields);
    const includeGeometry = input.includeGeometry !== false;
    const warnings: string[] = [];
    let factor = priorityFactor(priority, this.#configuration);
    if (input.moving === true) {
      factor *= this.#configuration.movingFeatureFactor;
      warnings.push('viewport-moving-budget-reduced');
    }
    const maxFeatures = clampBudget(this.#configuration.maxFeatures * factor, this.#configuration.maxFeatures);
    const density = input.estimatedFeatureDensity;
    const estimatedFeatures = density === undefined
      ? null
      : Math.max(0, Math.ceil(finiteNonNegative(density, 'estimatedFeatureDensity') * area));
    if (estimatedFeatures !== null && estimatedFeatures > maxFeatures) warnings.push('estimated-feature-budget-exceeded');
    if (fields.length === this.#configuration.maxFields) warnings.push('field-budget-saturated');

    const ratio = estimatedFeatures === null ? 0 : estimatedFeatures / maxFeatures;
    const pressure = ratio >= 1 ? 'high' : ratio >= 0.65 ? 'medium' : 'low';
    return Object.freeze({
      key: queryKey(layerId, extent, scale, fields, includeGeometry, this.#configuration.extentPrecision),
      layerId,
      extent,
      scale,
      priority,
      maxFeatures,
      fields,
      includeGeometry,
      estimatedFeatures,
      pressure,
      warnings: Object.freeze(warnings),
    });
  }
}

export const createViewportQueryPolicy = (
  configuration: Partial<ViewportQueryPolicyConfiguration> = {},
): ViewportQueryPolicy => new ViewportQueryPolicy(configuration);
