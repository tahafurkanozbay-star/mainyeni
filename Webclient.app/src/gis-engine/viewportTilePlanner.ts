import type { ViewportQueryExtent, ViewportQueryPriority } from './viewportQueryPolicy';

export type ViewportTilePressure = 'low' | 'medium' | 'high';

export interface ViewportTilePlannerConfiguration {
  readonly maximumTiles: number;
  readonly maximumRows: number;
  readonly maximumColumns: number;
  readonly maximumEstimatedFeaturesPerTile: number;
  readonly minimumTileWidth: number;
  readonly minimumTileHeight: number;
  readonly overlapRatio: number;
  readonly precision: number;
}

export interface ViewportTilePlannerInput {
  readonly extent: ViewportQueryExtent;
  readonly pixelWidth: number;
  readonly pixelHeight: number;
  readonly maxFeatures: number;
  readonly estimatedFeatureDensity?: number | null;
  readonly priority?: ViewportQueryPriority;
  readonly moving?: boolean;
  readonly preferredAspectRatio?: number;
}

export interface ViewportQueryTile {
  readonly id: string;
  readonly row: number;
  readonly column: number;
  readonly index: number;
  readonly extent: ViewportQueryExtent;
  readonly coreExtent: ViewportQueryExtent;
  readonly pixelWidth: number;
  readonly pixelHeight: number;
  readonly estimatedFeatures: number | null;
  readonly featureBudget: number;
  readonly priorityScore: number;
  readonly pressure: ViewportTilePressure;
  readonly edge: boolean;
}

export interface ViewportTilePlan {
  readonly key: string;
  readonly extent: ViewportQueryExtent;
  readonly rows: number;
  readonly columns: number;
  readonly tileCount: number;
  readonly featureBudget: number;
  readonly estimatedFeatures: number | null;
  readonly estimatedFeaturesPerTile: number | null;
  readonly pressure: ViewportTilePressure;
  readonly warnings: readonly string[];
  readonly tiles: readonly ViewportQueryTile[];
}

const DEFAULT_CONFIGURATION: ViewportTilePlannerConfiguration = Object.freeze({
  maximumTiles: 64,
  maximumRows: 16,
  maximumColumns: 16,
  maximumEstimatedFeaturesPerTile: 2_500,
  minimumTileWidth: 0.000001,
  minimumTileHeight: 0.000001,
  overlapRatio: 0.01,
  precision: 6,
});

const finitePositive = (value: number, name: string): number => {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a finite positive number`);
  }
  return value;
};

const positiveSafeInteger = (value: number, name: string, maximum: number): number => {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new RangeError(`${name} must be a positive safe integer <= ${maximum}`);
  }
  return value;
};

const ratio = (value: number, name: string): number => {
  if (!Number.isFinite(value) || value < 0 || value > 0.25) {
    throw new RangeError(`${name} must be between 0 and 0.25`);
  }
  return value;
};

const normalizeConfiguration = (
  input: Partial<ViewportTilePlannerConfiguration> = {},
): ViewportTilePlannerConfiguration => {
  const resolved = { ...DEFAULT_CONFIGURATION, ...input };
  const maximumTiles = positiveSafeInteger(resolved.maximumTiles, 'maximumTiles', 1_024);
  const maximumRows = positiveSafeInteger(resolved.maximumRows, 'maximumRows', 128);
  const maximumColumns = positiveSafeInteger(resolved.maximumColumns, 'maximumColumns', 128);
  const maximumEstimatedFeaturesPerTile = positiveSafeInteger(
    resolved.maximumEstimatedFeaturesPerTile,
    'maximumEstimatedFeaturesPerTile',
    1_000_000,
  );
  const minimumTileWidth = finitePositive(resolved.minimumTileWidth, 'minimumTileWidth');
  const minimumTileHeight = finitePositive(resolved.minimumTileHeight, 'minimumTileHeight');
  const overlapRatio = ratio(resolved.overlapRatio, 'overlapRatio');
  if (!Number.isSafeInteger(resolved.precision) || resolved.precision < 0 || resolved.precision > 12) {
    throw new RangeError('precision must be a safe integer between 0 and 12');
  }
  if (maximumRows * maximumColumns < maximumTiles) {
    throw new RangeError('maximumRows * maximumColumns must cover maximumTiles');
  }
  return Object.freeze({
    maximumTiles,
    maximumRows,
    maximumColumns,
    maximumEstimatedFeaturesPerTile,
    minimumTileWidth,
    minimumTileHeight,
    overlapRatio,
    precision: resolved.precision,
  });
};

const normalizeExtent = (extent: ViewportQueryExtent): ViewportQueryExtent => {
  const values = [extent.xmin, extent.ymin, extent.xmax, extent.ymax];
  if (!values.every(Number.isFinite)) throw new TypeError('viewport tile extent coordinates must be finite');
  if (extent.xmin >= extent.xmax || extent.ymin >= extent.ymax) {
    throw new RangeError('viewport tile extent must have positive width and height');
  }
  const spatialReference = extent.spatialReference.trim();
  if (!spatialReference) throw new TypeError('viewport tile spatialReference is required');
  if (spatialReference.length > 128) throw new RangeError('viewport tile spatialReference exceeds 128 characters');
  return Object.freeze({ ...extent, spatialReference });
};

const extentWidth = (extent: ViewportQueryExtent): number => extent.xmax - extent.xmin;
const extentHeight = (extent: ViewportQueryExtent): number => extent.ymax - extent.ymin;

const extentArea = (extent: ViewportQueryExtent): number => {
  const value = extentWidth(extent) * extentHeight(extent);
  return Number.isFinite(value) ? value : Number.POSITIVE_INFINITY;
};

const boundedDensity = (value: number | null | undefined): number | null => {
  if (value === null || value === undefined) return null;
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError('estimatedFeatureDensity must be finite and non-negative');
  }
  return value;
};

const priorityBase = (priority: ViewportQueryPriority): number => {
  switch (priority) {
    case 'interactive':
      return 300;
    case 'foreground':
      return 200;
    case 'prefetch':
      return 100;
  }
};

const fnv1a = (value: string): string => {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
};

const coordinate = (value: number, precision: number): string => value.toFixed(precision);

const planKey = (
  extent: ViewportQueryExtent,
  rows: number,
  columns: number,
  featureBudget: number,
  precision: number,
): string => fnv1a([
  extent.spatialReference,
  coordinate(extent.xmin, precision),
  coordinate(extent.ymin, precision),
  coordinate(extent.xmax, precision),
  coordinate(extent.ymax, precision),
  rows,
  columns,
  featureBudget,
].join('|'));

const pressureFor = (estimated: number | null, capacity: number): ViewportTilePressure => {
  if (estimated === null || estimated <= capacity * 0.55) return 'low';
  if (estimated <= capacity) return 'medium';
  return 'high';
};

const targetTileCount = (
  estimatedFeatures: number | null,
  maxFeatures: number,
  config: ViewportTilePlannerConfiguration,
): number => {
  if (estimatedFeatures === null || estimatedFeatures <= 0) return 1;
  const perTile = Math.max(1, Math.min(maxFeatures, config.maximumEstimatedFeaturesPerTile));
  return Math.max(1, Math.min(config.maximumTiles, Math.ceil(estimatedFeatures / perTile)));
};

const gridDimensions = (
  target: number,
  extent: ViewportQueryExtent,
  pixelWidth: number,
  pixelHeight: number,
  preferredAspectRatio: number | undefined,
  config: ViewportTilePlannerConfiguration,
): Readonly<{ rows: number; columns: number }> => {
  const worldAspect = extentWidth(extent) / extentHeight(extent);
  const pixelAspect = pixelWidth / pixelHeight;
  const requestedAspect = preferredAspectRatio === undefined
    ? Math.sqrt(Math.max(0.000001, worldAspect * pixelAspect))
    : finitePositive(preferredAspectRatio, 'preferredAspectRatio');
  let bestRows = 1;
  let bestColumns = 1;
  let bestScore = Number.POSITIVE_INFINITY;

  for (let rows = 1; rows <= Math.min(config.maximumRows, target); rows += 1) {
    const columns = Math.ceil(target / rows);
    if (columns > config.maximumColumns || rows * columns > config.maximumTiles) continue;
    const tileWidth = extentWidth(extent) / columns;
    const tileHeight = extentHeight(extent) / rows;
    if (tileWidth < config.minimumTileWidth || tileHeight < config.minimumTileHeight) continue;
    const tileAspect = tileWidth / tileHeight;
    const waste = rows * columns - target;
    const aspectError = Math.abs(Math.log(Math.max(0.000001, tileAspect / requestedAspect)));
    const score = aspectError * 100 + waste;
    if (score < bestScore) {
      bestRows = rows;
      bestColumns = columns;
      bestScore = score;
    }
  }
  return Object.freeze({ rows: bestRows, columns: bestColumns });
};

const coreExtent = (
  extent: ViewportQueryExtent,
  row: number,
  column: number,
  rows: number,
  columns: number,
): ViewportQueryExtent => {
  const width = extentWidth(extent) / columns;
  const height = extentHeight(extent) / rows;
  const xmin = column === 0 ? extent.xmin : extent.xmin + width * column;
  const xmax = column === columns - 1 ? extent.xmax : extent.xmin + width * (column + 1);
  const ymin = row === 0 ? extent.ymin : extent.ymin + height * row;
  const ymax = row === rows - 1 ? extent.ymax : extent.ymin + height * (row + 1);
  return Object.freeze({
    xmin,
    ymin,
    xmax,
    ymax,
    spatialReference: extent.spatialReference,
  });
};

const overlapExtent = (
  core: ViewportQueryExtent,
  full: ViewportQueryExtent,
  overlapRatio: number,
): ViewportQueryExtent => {
  if (overlapRatio <= 0) return core;
  const dx = extentWidth(core) * overlapRatio;
  const dy = extentHeight(core) * overlapRatio;
  return Object.freeze({
    xmin: Math.max(full.xmin, core.xmin - dx),
    ymin: Math.max(full.ymin, core.ymin - dy),
    xmax: Math.min(full.xmax, core.xmax + dx),
    ymax: Math.min(full.ymax, core.ymax + dy),
    spatialReference: core.spatialReference,
  });
};

const centerDistance = (
  row: number,
  column: number,
  rows: number,
  columns: number,
): number => {
  const x = column + 0.5 - columns / 2;
  const y = row + 0.5 - rows / 2;
  return Math.sqrt(x * x + y * y);
};

const tileId = (
  planId: string,
  row: number,
  column: number,
  core: ViewportQueryExtent,
  precision: number,
): string => `${planId}:${row}:${column}:${fnv1a([
  coordinate(core.xmin, precision),
  coordinate(core.ymin, precision),
  coordinate(core.xmax, precision),
  coordinate(core.ymax, precision),
].join('|'))}`;

const buildTiles = (
  extent: ViewportQueryExtent,
  rows: number,
  columns: number,
  pixelWidth: number,
  pixelHeight: number,
  estimatedFeatures: number | null,
  maxFeatures: number,
  priority: ViewportQueryPriority,
  moving: boolean,
  planId: string,
  config: ViewportTilePlannerConfiguration,
): readonly ViewportQueryTile[] => {
  const count = rows * columns;
  const featureBudget = Math.max(1, Math.floor(maxFeatures / count));
  const estimatedPerTile = estimatedFeatures === null ? null : Math.ceil(estimatedFeatures / count);
  const tiles: ViewportQueryTile[] = [];

  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const core = coreExtent(extent, row, column, rows, columns);
      const expanded = overlapExtent(core, extent, config.overlapRatio);
      const distance = centerDistance(row, column, rows, columns);
      const edge = row === 0 || column === 0 || row === rows - 1 || column === columns - 1;
      const movementPenalty = moving && priority !== 'interactive' ? 40 : 0;
      const score = priorityBase(priority) - distance * 10 - movementPenalty - (edge ? 1 : 0);
      tiles.push(Object.freeze({
        id: tileId(planId, row, column, core, config.precision),
        row,
        column,
        index: row * columns + column,
        extent: expanded,
        coreExtent: core,
        pixelWidth: Math.max(1, Math.ceil(pixelWidth / columns)),
        pixelHeight: Math.max(1, Math.ceil(pixelHeight / rows)),
        estimatedFeatures: estimatedPerTile,
        featureBudget,
        priorityScore: Number(score.toFixed(4)),
        pressure: pressureFor(estimatedPerTile, featureBudget),
        edge,
      }));
    }
  }

  return Object.freeze(tiles.sort((left, right) => (
    right.priorityScore - left.priorityScore
    || left.row - right.row
    || left.column - right.column
  )));
};

export class ViewportTilePlanner {
  readonly #configuration: ViewportTilePlannerConfiguration;

  constructor(configuration: Partial<ViewportTilePlannerConfiguration> = {}) {
    this.#configuration = normalizeConfiguration(configuration);
  }

  get configuration(): ViewportTilePlannerConfiguration {
    return this.#configuration;
  }

  plan(input: ViewportTilePlannerInput): ViewportTilePlan {
    const extent = normalizeExtent(input.extent);
    const pixelWidth = finitePositive(input.pixelWidth, 'pixelWidth');
    const pixelHeight = finitePositive(input.pixelHeight, 'pixelHeight');
    const maxFeatures = positiveSafeInteger(input.maxFeatures, 'maxFeatures', 10_000_000);
    const density = boundedDensity(input.estimatedFeatureDensity);
    const estimatedFeatures = density === null
      ? null
      : Math.max(0, Math.ceil(extentArea(extent) * density));
    const priority = input.priority ?? 'foreground';
    const target = targetTileCount(estimatedFeatures, maxFeatures, this.#configuration);
    const dimensions = gridDimensions(
      target,
      extent,
      pixelWidth,
      pixelHeight,
      input.preferredAspectRatio,
      this.#configuration,
    );
    const tileCount = dimensions.rows * dimensions.columns;
    const featureBudget = Math.max(1, Math.floor(maxFeatures / tileCount));
    const estimatedFeaturesPerTile = estimatedFeatures === null
      ? null
      : Math.ceil(estimatedFeatures / tileCount);
    const warnings: string[] = [];

    if (target >= this.#configuration.maximumTiles && estimatedFeatures !== null) {
      warnings.push('tile-count-budget-saturated');
    }
    if (
      estimatedFeaturesPerTile !== null
      && estimatedFeaturesPerTile > featureBudget
    ) {
      warnings.push('estimated-features-exceed-tile-budget');
    }
    if (input.moving === true && tileCount > 1) warnings.push('moving-viewport-tiled');
    if (this.#configuration.overlapRatio > 0 && tileCount > 1) warnings.push('tile-overlap-enabled');

    const key = planKey(extent, dimensions.rows, dimensions.columns, featureBudget, this.#configuration.precision);
    const tiles = buildTiles(
      extent,
      dimensions.rows,
      dimensions.columns,
      pixelWidth,
      pixelHeight,
      estimatedFeatures,
      maxFeatures,
      priority,
      input.moving === true,
      key,
      this.#configuration,
    );

    return Object.freeze({
      key,
      extent,
      rows: dimensions.rows,
      columns: dimensions.columns,
      tileCount,
      featureBudget,
      estimatedFeatures,
      estimatedFeaturesPerTile,
      pressure: pressureFor(estimatedFeaturesPerTile, featureBudget),
      warnings: Object.freeze(warnings),
      tiles,
    });
  }
}

export const createViewportTilePlanner = (
  configuration: Partial<ViewportTilePlannerConfiguration> = {},
): ViewportTilePlanner => new ViewportTilePlanner(configuration);
