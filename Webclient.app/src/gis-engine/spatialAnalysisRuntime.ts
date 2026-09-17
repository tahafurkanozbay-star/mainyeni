export type SpatialPoint = Readonly<{ x: number; y: number; z?: number }>;
export type SpatialExtent = Readonly<{ xmin: number; ymin: number; xmax: number; ymax: number }>;
export type SpatialFeature<T = unknown> = Readonly<{ id: string | number; point: SpatialPoint; data: T }>;

export type SpatialAnalysisBudget = Readonly<{
  maxCandidates: number;
  maxResults: number;
  maxDistance: number;
}>;

export type NearestResult<T> = Readonly<{
  feature: SpatialFeature<T>;
  distance: number;
}>;

export type ProximityResult<T> = Readonly<{
  results: readonly NearestResult<T>[];
  inspected: number;
  truncated: boolean;
}>;

const finite = (value: number, name: string): number => {
  if (!Number.isFinite(value)) throw new TypeError(`${name} must be finite`);
  return value;
};

const positiveInteger = (value: number, name: string): number => {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive safe integer`);
  return value;
};

export const normalizeSpatialAnalysisBudget = (budget: SpatialAnalysisBudget): SpatialAnalysisBudget => ({
  maxCandidates: positiveInteger(budget.maxCandidates, 'maxCandidates'),
  maxResults: positiveInteger(budget.maxResults, 'maxResults'),
  maxDistance: Math.max(0, finite(budget.maxDistance, 'maxDistance')),
});

export const squaredDistance = (a: SpatialPoint, b: SpatialPoint): number => {
  const dx = finite(a.x, 'a.x') - finite(b.x, 'b.x');
  const dy = finite(a.y, 'a.y') - finite(b.y, 'b.y');
  return dx * dx + dy * dy;
};

export const extentContainsPoint = (extent: SpatialExtent, point: SpatialPoint): boolean => {
  const xmin = finite(extent.xmin, 'xmin');
  const ymin = finite(extent.ymin, 'ymin');
  const xmax = finite(extent.xmax, 'xmax');
  const ymax = finite(extent.ymax, 'ymax');
  if (xmin > xmax || ymin > ymax) throw new RangeError('extent bounds are inverted');
  const x = finite(point.x, 'point.x');
  const y = finite(point.y, 'point.y');
  return x >= xmin && x <= xmax && y >= ymin && y <= ymax;
};

export const filterByExtent = <T>(
  features: readonly SpatialFeature<T>[],
  extent: SpatialExtent,
  maxResults: number,
): readonly SpatialFeature<T>[] => {
  const limit = positiveInteger(maxResults, 'maxResults');
  const result: SpatialFeature<T>[] = [];
  for (const feature of features) {
    if (extentContainsPoint(extent, feature.point)) result.push(feature);
    if (result.length >= limit) break;
  }
  return result;
};

const throwIfAborted = (signal?: AbortSignal): void => {
  if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
};

export const findNearest = <T>(
  origin: SpatialPoint,
  features: readonly SpatialFeature<T>[],
  budgetInput: SpatialAnalysisBudget,
  signal?: AbortSignal,
): ProximityResult<T> => {
  const budget = normalizeSpatialAnalysisBudget(budgetInput);
  const maxDistanceSquared = budget.maxDistance * budget.maxDistance;
  const ranked: Array<NearestResult<T> & { order: number }> = [];
  let inspected = 0;

  for (const feature of features) {
    throwIfAborted(signal);
    if (inspected >= budget.maxCandidates) break;
    const order = inspected++;
    const distanceSquared = squaredDistance(origin, feature.point);
    if (distanceSquared > maxDistanceSquared) continue;
    ranked.push({ feature, distance: Math.sqrt(distanceSquared), order });
  }

  ranked.sort((a, b) => a.distance - b.distance || a.order - b.order);
  const truncated = ranked.length > budget.maxResults || features.length > inspected;
  return {
    results: ranked.slice(0, budget.maxResults).map(({ feature, distance }) => ({ feature, distance })),
    inspected,
    truncated,
  };
};

export type SpatialGridOptions = Readonly<{ cellSize: number; maxCells: number; maxFeaturesPerCell: number }>;
export type SpatialGrid<T> = ReadonlyMap<string, readonly SpatialFeature<T>[]>;

export const buildSpatialGrid = <T>(
  features: readonly SpatialFeature<T>[],
  options: SpatialGridOptions,
  signal?: AbortSignal,
): SpatialGrid<T> => {
  const cellSize = finite(options.cellSize, 'cellSize');
  if (cellSize <= 0) throw new RangeError('cellSize must be positive');
  const maxCells = positiveInteger(options.maxCells, 'maxCells');
  const maxFeaturesPerCell = positiveInteger(options.maxFeaturesPerCell, 'maxFeaturesPerCell');
  const cells = new Map<string, SpatialFeature<T>[]>();

  for (const feature of features) {
    throwIfAborted(signal);
    const x = Math.floor(finite(feature.point.x, 'point.x') / cellSize);
    const y = Math.floor(finite(feature.point.y, 'point.y') / cellSize);
    const key = `${x}:${y}`;
    let cell = cells.get(key);
    if (!cell) {
      if (cells.size >= maxCells) continue;
      cell = [];
      cells.set(key, cell);
    }
    if (cell.length < maxFeaturesPerCell) cell.push(feature);
  }

  return cells;
};

export const querySpatialGrid = <T>(
  grid: SpatialGrid<T>,
  extent: SpatialExtent,
  cellSizeInput: number,
  maxResultsInput: number,
): readonly SpatialFeature<T>[] => {
  const cellSize = finite(cellSizeInput, 'cellSize');
  if (cellSize <= 0) throw new RangeError('cellSize must be positive');
  const maxResults = positiveInteger(maxResultsInput, 'maxResults');
  if (extent.xmin > extent.xmax || extent.ymin > extent.ymax) throw new RangeError('extent bounds are inverted');
  const minX = Math.floor(extent.xmin / cellSize);
  const maxX = Math.floor(extent.xmax / cellSize);
  const minY = Math.floor(extent.ymin / cellSize);
  const maxY = Math.floor(extent.ymax / cellSize);
  const results: SpatialFeature<T>[] = [];
  const seen = new Set<string>();

  for (let x = minX; x <= maxX && results.length < maxResults; x += 1) {
    for (let y = minY; y <= maxY && results.length < maxResults; y += 1) {
      const cell = grid.get(`${x}:${y}`);
      if (!cell) continue;
      for (const feature of cell) {
        if (!extentContainsPoint(extent, feature.point)) continue;
        const identity = `${typeof feature.id}:${String(feature.id)}`;
        if (seen.has(identity)) continue;
        seen.add(identity);
        results.push(feature);
        if (results.length >= maxResults) break;
      }
    }
  }
  return results;
};
