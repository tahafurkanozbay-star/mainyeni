import type { SpatialExtent, SpatialFeature, SpatialPoint } from './spatialAnalysisRuntime';

export type SpatialSelectionMode = 'replace' | 'add' | 'remove' | 'toggle';
export type SpatialSelectionBudget = Readonly<{
  maxCandidates: number;
  maxSelected: number;
  maxPolygonVertices: number;
}>;
export type SpatialSelectionDiagnostics = Readonly<{
  inspected: number;
  matched: number;
  selected: number;
  truncated: boolean;
}>;
export type SpatialSelectionResult<T> = Readonly<{
  features: readonly SpatialFeature<T>[];
  diagnostics: SpatialSelectionDiagnostics;
}>;

const positiveInteger = (value: number, name: string): number => {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive safe integer`);
  return value;
};
const finite = (value: number, name: string): number => {
  if (!Number.isFinite(value)) throw new TypeError(`${name} must be finite`);
  return value;
};
const abort = (signal?: AbortSignal): void => {
  if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
};
const identity = (feature: SpatialFeature<unknown>): string => `${typeof feature.id}:${String(feature.id)}`;

export const normalizeSelectionBudget = (budget: SpatialSelectionBudget): SpatialSelectionBudget => ({
  maxCandidates: positiveInteger(budget.maxCandidates, 'maxCandidates'),
  maxSelected: positiveInteger(budget.maxSelected, 'maxSelected'),
  maxPolygonVertices: positiveInteger(budget.maxPolygonVertices, 'maxPolygonVertices'),
});

export const normalizeExtent = (extent: SpatialExtent): SpatialExtent => {
  const xmin = finite(extent.xmin, 'xmin');
  const ymin = finite(extent.ymin, 'ymin');
  const xmax = finite(extent.xmax, 'xmax');
  const ymax = finite(extent.ymax, 'ymax');
  if (xmin > xmax || ymin > ymax) throw new RangeError('extent bounds are inverted');
  return { xmin, ymin, xmax, ymax };
};

export const pointInExtent = (point: SpatialPoint, extentInput: SpatialExtent): boolean => {
  const extent = normalizeExtent(extentInput);
  const x = finite(point.x, 'point.x');
  const y = finite(point.y, 'point.y');
  return x >= extent.xmin && x <= extent.xmax && y >= extent.ymin && y <= extent.ymax;
};

export const pointInPolygon = (point: SpatialPoint, polygon: readonly SpatialPoint[]): boolean => {
  if (polygon.length < 3) throw new RangeError('polygon must contain at least three vertices');
  const px = finite(point.x, 'point.x');
  const py = finite(point.y, 'point.y');
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = finite(polygon[i]!.x, `polygon[${i}].x`);
    const yi = finite(polygon[i]!.y, `polygon[${i}].y`);
    const xj = finite(polygon[j]!.x, `polygon[${j}].x`);
    const yj = finite(polygon[j]!.y, `polygon[${j}].y`);
    const crosses = yi > py !== yj > py;
    if (crosses && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
};

const selectBounded = <T>(
  features: readonly SpatialFeature<T>[],
  predicate: (feature: SpatialFeature<T>) => boolean,
  budgetInput: SpatialSelectionBudget,
  signal?: AbortSignal,
): SpatialSelectionResult<T> => {
  const budget = normalizeSelectionBudget(budgetInput);
  const selected: SpatialFeature<T>[] = [];
  const seen = new Set<string>();
  let inspected = 0;
  let matched = 0;
  for (const feature of features) {
    abort(signal);
    if (inspected >= budget.maxCandidates) break;
    inspected += 1;
    if (!predicate(feature)) continue;
    matched += 1;
    const key = identity(feature);
    if (seen.has(key)) continue;
    seen.add(key);
    if (selected.length < budget.maxSelected) selected.push(feature);
  }
  return {
    features: selected,
    diagnostics: {
      inspected,
      matched,
      selected: selected.length,
      truncated: inspected < features.length || matched > selected.length,
    },
  };
};

export const selectByExtent = <T>(
  features: readonly SpatialFeature<T>[],
  extent: SpatialExtent,
  budget: SpatialSelectionBudget,
  signal?: AbortSignal,
): SpatialSelectionResult<T> => {
  const normalized = normalizeExtent(extent);
  return selectBounded(features, (feature) => pointInExtent(feature.point, normalized), budget, signal);
};

export const selectByPolygon = <T>(
  features: readonly SpatialFeature<T>[],
  polygon: readonly SpatialPoint[],
  budgetInput: SpatialSelectionBudget,
  signal?: AbortSignal,
): SpatialSelectionResult<T> => {
  const budget = normalizeSelectionBudget(budgetInput);
  if (polygon.length > budget.maxPolygonVertices) throw new RangeError('polygon vertex budget exceeded');
  return selectBounded(features, (feature) => pointInPolygon(feature.point, polygon), budget, signal);
};

export const mergeSelection = <T>(
  current: readonly SpatialFeature<T>[],
  incoming: readonly SpatialFeature<T>[],
  mode: SpatialSelectionMode,
  maxSelectedInput: number,
): readonly SpatialFeature<T>[] => {
  const maxSelected = positiveInteger(maxSelectedInput, 'maxSelected');
  const currentMap = new Map(current.map((feature) => [identity(feature), feature]));
  const incomingMap = new Map(incoming.map((feature) => [identity(feature), feature]));
  if (mode === 'replace') return [...incomingMap.values()].slice(0, maxSelected);
  if (mode === 'add') {
    for (const [key, feature] of incomingMap) if (!currentMap.has(key)) currentMap.set(key, feature);
  } else if (mode === 'remove') {
    for (const key of incomingMap.keys()) currentMap.delete(key);
  } else {
    for (const [key, feature] of incomingMap) {
      if (currentMap.has(key)) currentMap.delete(key);
      else currentMap.set(key, feature);
    }
  }
  return [...currentMap.values()].slice(0, maxSelected);
};

export const createSelectionStore = <T>(maxSelectedInput: number) => {
  const maxSelected = positiveInteger(maxSelectedInput, 'maxSelected');
  let selected: readonly SpatialFeature<T>[] = [];
  return Object.freeze({
    getSnapshot: (): readonly SpatialFeature<T>[] => selected,
    clear: (): void => { selected = []; },
    apply: (incoming: readonly SpatialFeature<T>[], mode: SpatialSelectionMode = 'replace'): readonly SpatialFeature<T>[] => {
      selected = mergeSelection(selected, incoming, mode, maxSelected);
      return selected;
    },
  });
};
