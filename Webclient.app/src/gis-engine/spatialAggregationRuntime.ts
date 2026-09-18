export type SpatialAggregationPoint = Readonly<{
  x: number;
  y: number;
  weight?: number;
  category?: string | number | null;
}>;

export type SpatialAggregationBudget = Readonly<{
  maxPoints: number;
  maxCells: number;
  maxCategoriesPerCell: number;
}>;

export type SpatialAggregationCell = Readonly<{
  key: string;
  column: number;
  row: number;
  count: number;
  weight: number;
  centroidX: number;
  centroidY: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  categories: ReadonlyArray<Readonly<{ category: string; count: number; weight: number }>>;
}>;

export type SpatialAggregationResult = Readonly<{
  cells: ReadonlyArray<SpatialAggregationCell>;
  acceptedPoints: number;
  rejectedPoints: number;
  truncated: boolean;
  diagnostics: ReadonlyArray<string>;
}>;

type MutableCategory = { count: number; weight: number };
type MutableCell = {
  key: string;
  column: number;
  row: number;
  count: number;
  weight: number;
  weightedX: number;
  weightedY: number;
  plainX: number;
  plainY: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  categories: Map<string, MutableCategory>;
};

function requirePositiveFinite(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${label} must be finite and > 0`);
}

function requirePositiveInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value <= 0) throw new RangeError(`${label} must be a positive integer`);
}

function categoryKey(value: SpatialAggregationPoint['category']): string | null {
  if (value === null || value === undefined) return null;
  return `${typeof value}:${String(value)}`;
}

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException('Spatial aggregation aborted', 'AbortError');
}

/**
 * Aggregates point observations into deterministic planar grid cells. The runtime is deliberately
 * transport- and renderer-agnostic so MapView and SceneView consumers can share the same bounded
 * analysis result. It never allocates more than maxCells cells and never inspects more than
 * maxPoints input records.
 */
export function aggregateSpatialGrid(
  points: readonly SpatialAggregationPoint[],
  cellSize: number,
  budget: SpatialAggregationBudget,
  options: Readonly<{ originX?: number; originY?: number; signal?: AbortSignal }> = {},
): SpatialAggregationResult {
  requirePositiveFinite(cellSize, 'cellSize');
  requirePositiveInteger(budget.maxPoints, 'maxPoints');
  requirePositiveInteger(budget.maxCells, 'maxCells');
  requirePositiveInteger(budget.maxCategoriesPerCell, 'maxCategoriesPerCell');
  const originX = options.originX ?? 0;
  const originY = options.originY ?? 0;
  if (!Number.isFinite(originX) || !Number.isFinite(originY)) throw new RangeError('grid origin must be finite');

  const cells = new Map<string, MutableCell>();
  const diagnostics: string[] = [];
  let acceptedPoints = 0;
  let rejectedPoints = 0;
  let truncated = false;
  const inspected = Math.min(points.length, budget.maxPoints);
  if (points.length > budget.maxPoints) {
    truncated = true;
    diagnostics.push('point-budget-exhausted');
  }

  for (let index = 0; index < inspected; index += 1) {
    if ((index & 127) === 0) checkAbort(options.signal);
    const point = points[index]!;
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y) || (point.weight !== undefined && !Number.isFinite(point.weight))) {
      rejectedPoints += 1;
      continue;
    }
    const weight = point.weight ?? 1;
    if (weight < 0) {
      rejectedPoints += 1;
      continue;
    }
    const column = Math.floor((point.x - originX) / cellSize);
    const row = Math.floor((point.y - originY) / cellSize);
    const key = `${column}:${row}`;
    let cell = cells.get(key);
    if (!cell) {
      if (cells.size >= budget.maxCells) {
        truncated = true;
        rejectedPoints += 1;
        if (!diagnostics.includes('cell-budget-exhausted')) diagnostics.push('cell-budget-exhausted');
        continue;
      }
      cell = {
        key, column, row, count: 0, weight: 0, weightedX: 0, weightedY: 0, plainX: 0, plainY: 0,
        minX: point.x, minY: point.y, maxX: point.x, maxY: point.y, categories: new Map(),
      };
      cells.set(key, cell);
    }
    cell.count += 1;
    cell.weight += weight;
    cell.weightedX += point.x * weight;
    cell.weightedY += point.y * weight;
    cell.plainX += point.x;
    cell.plainY += point.y;
    cell.minX = Math.min(cell.minX, point.x);
    cell.minY = Math.min(cell.minY, point.y);
    cell.maxX = Math.max(cell.maxX, point.x);
    cell.maxY = Math.max(cell.maxY, point.y);
    acceptedPoints += 1;

    const category = categoryKey(point.category);
    if (category !== null) {
      const existing = cell.categories.get(category);
      if (existing) {
        existing.count += 1;
        existing.weight += weight;
      } else if (cell.categories.size < budget.maxCategoriesPerCell) {
        cell.categories.set(category, { count: 1, weight });
      } else if (!diagnostics.includes('category-budget-exhausted')) {
        diagnostics.push('category-budget-exhausted');
        truncated = true;
      }
    }
  }
  checkAbort(options.signal);

  const output = [...cells.values()]
    .sort((a, b) => a.row - b.row || a.column - b.column)
    .map<SpatialAggregationCell>((cell) => ({
      key: cell.key,
      column: cell.column,
      row: cell.row,
      count: cell.count,
      weight: cell.weight,
      centroidX: cell.weight > 0 ? cell.weightedX / cell.weight : cell.plainX / cell.count,
      centroidY: cell.weight > 0 ? cell.weightedY / cell.weight : cell.plainY / cell.count,
      minX: cell.minX,
      minY: cell.minY,
      maxX: cell.maxX,
      maxY: cell.maxY,
      categories: [...cell.categories.entries()]
        .map(([category, value]) => ({ category, count: value.count, weight: value.weight }))
        .sort((a, b) => b.count - a.count || a.category.localeCompare(b.category)),
    }));

  return { cells: output, acceptedPoints, rejectedPoints, truncated, diagnostics };
}
