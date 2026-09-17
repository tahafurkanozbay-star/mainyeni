import { loadModules } from 'esri-loader';
import type {
  AnalysisInput,
  ArcGisFeatureSetLike,
  ArcGisGeometryLike,
  ArcGisLayerLike,
  DedupeExecutor,
  DistanceQueryOptions,
  FeatureSummary,
  ParsedAnalysisInput,
  ServiceHealthSnapshot,
  SpatialQueryOptions,
  SpatialRelation,
  TimeSliderState,
} from './contracts';

interface GeometryEngineLike {
  geodesicDistance: (a: ArcGisGeometryLike, b: ArcGisGeometryLike, unit: string) => number;
  geodesicArea: (geometry: ArcGisGeometryLike, unit: string) => number;
  buffer: (geometry: ArcGisGeometryLike, distance: number, unit: string) => ArcGisGeometryLike;
  distance: (a: ArcGisGeometryLike, b: ArcGisGeometryLike, unit: string) => number;
  intersects: (a: ArcGisGeometryLike, b: ArcGisGeometryLike) => boolean;
  [key: string]: unknown;
}

interface ProjectionLike {
  load: () => Promise<void>;
  project: (geometry: ArcGisGeometryLike, spatialReference: unknown) => ArcGisGeometryLike;
}

type SpatialReferenceCtor = new (options: { wkid: number }) => unknown;

const modulePromises = new Map<string, Promise<unknown>>();
const SPATIAL_RELATIONS = new Set<SpatialRelation>([
  'contains', 'crosses', 'disjoint', 'equals', 'intersects', 'overlaps', 'touches', 'within',
]);

const loadModule = <T = unknown>(name: string): Promise<T> => {
  if (!modulePromises.has(name)) {
    const promise = loadModules([name])
      .then((values) => values[0])
      .catch((error) => {
        modulePromises.delete(name);
        throw error;
      });
    modulePromises.set(name, promise);
  }
  return modulePromises.get(name) as Promise<T>;
};

const modules = <T extends unknown[]>(names: string[]): Promise<T> => Promise.all(
  names.map((name) => loadModule(name)),
) as Promise<T>;

const stable = (value: unknown, seen = new WeakSet<object>()): string => {
  if (value === null || value === undefined) return String(value);
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map((item) => stable(item, seen)).join(',')}]`;
  if (typeof value === 'object') {
    const objectValue = value as Record<string, unknown> & { toJSON?: () => unknown };
    if (typeof objectValue.toJSON === 'function') return stable(objectValue.toJSON(), seen);
    if (seen.has(objectValue)) return '"[Circular]"';
    seen.add(objectValue);
    const result = `{${Object.keys(objectValue)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stable(objectValue[key], seen)}`)
      .join(',')}}`;
    seen.delete(objectValue);
    return result;
  }
  return JSON.stringify(value);
};

const cancelledError = (): Error & { code: string } => Object.assign(new Error('Query cancelled.'), { code: 'CANCELLED' });

const throwIfAborted = (signal?: AbortSignal): void => {
  if (signal?.aborted) throw cancelledError();
};

function requireGeometry(
  geometry: ArcGisGeometryLike | null | undefined,
  message = 'Geometry is required.',
): asserts geometry is ArcGisGeometryLike {
  if (!geometry) throw new Error(message);
}

export const distance = async (
  a: ArcGisGeometryLike,
  b: ArcGisGeometryLike,
  unit = 'meters',
): Promise<number> => {
  if (!a || !b) throw new Error('Two geometries are required.');
  const [geometryEngine] = await modules<[GeometryEngineLike]>(['esri/geometry/geometryEngine']);
  return geometryEngine.geodesicDistance(a, b, unit);
};

export const area = async (geometry: ArcGisGeometryLike, unit = 'square-meters'): Promise<number> => {
  requireGeometry(geometry);
  const [geometryEngine] = await modules<[GeometryEngineLike]>(['esri/geometry/geometryEngine']);
  return geometryEngine.geodesicArea(geometry, unit);
};

export const buffer = async (
  geometry: ArcGisGeometryLike,
  distanceValue: number,
  unit = 'meters',
): Promise<ArcGisGeometryLike> => {
  if (!geometry || !Number.isFinite(distanceValue) || distanceValue < 0) {
    throw new Error('Valid geometry and buffer distance are required.');
  }
  const [geometryEngine] = await modules<[GeometryEngineLike]>(['esri/geometry/geometryEngine']);
  return geometryEngine.buffer(geometry, distanceValue, unit);
};

export interface NearestResult {
  index: number;
  geometry: ArcGisGeometryLike;
  distance: number;
}

export const nearest = async (
  source: ArcGisGeometryLike,
  candidates: ArcGisGeometryLike[] = [],
  unit = 'meters',
): Promise<NearestResult | null> => {
  requireGeometry(source, 'Source geometry is required.');
  const [geometryEngine] = await modules<[GeometryEngineLike]>(['esri/geometry/geometryEngine']);
  let best: NearestResult | null = null;
  (candidates || []).forEach((geometry, index) => {
    if (!geometry) return;
    const candidateDistance = geometryEngine.distance(source, geometry, unit);
    if (Number.isFinite(candidateDistance) && (!best || candidateDistance < best.distance)) {
      best = { index, geometry, distance: candidateDistance };
    }
  });
  return best;
};

export const proximity = async (
  source: ArcGisGeometryLike,
  candidates: ArcGisGeometryLike[],
  distanceValue: number,
  unit = 'meters',
): Promise<ArcGisGeometryLike[]> => {
  const buffered = await buffer(source, distanceValue, unit);
  const [geometryEngine] = await modules<[GeometryEngineLike]>(['esri/geometry/geometryEngine']);
  return (candidates || []).filter((geometry) => geometry && geometryEngine.intersects(buffered, geometry));
};

export const spatialFilter = async (
  geometry: ArcGisGeometryLike,
  candidates: ArcGisGeometryLike[] = [],
  relation: SpatialRelation = 'intersects',
): Promise<ArcGisGeometryLike[]> => {
  requireGeometry(geometry);
  if (!SPATIAL_RELATIONS.has(relation)) throw new Error(`Unsupported relation: ${relation}`);
  const [geometryEngine] = await modules<[GeometryEngineLike]>(['esri/geometry/geometryEngine']);
  const operation = geometryEngine[relation];
  if (typeof operation !== 'function') throw new Error(`Unsupported relation: ${relation}`);
  const predicate = operation as (a: ArcGisGeometryLike, b: ArcGisGeometryLike) => boolean;
  return candidates.filter((candidate) => candidate && predicate(geometry, candidate));
};

export const project = async (
  geometry: ArcGisGeometryLike,
  wkid: number,
): Promise<ArcGisGeometryLike> => {
  requireGeometry(geometry);
  if (!Number.isInteger(wkid) || wkid <= 0) throw new Error('A valid positive integer WKID is required.');
  const [projection, SpatialReference] = await modules<[ProjectionLike, SpatialReferenceCtor]>([
    'esri/geometry/projection',
    'esri/geometry/SpatialReference',
  ]);
  await projection.load();
  return projection.project(geometry, new SpatialReference({ wkid }));
};

export const queryByGeometry = async (
  layer: ArcGisLayerLike,
  {
    geometry,
    where = '1=1',
    outFields = ['*'],
    returnGeometry = true,
    signal,
  }: SpatialQueryOptions = {},
): Promise<ArcGisFeatureSetLike> => {
  throwIfAborted(signal);
  if (!layer?.queryFeatures) throw new Error('FeatureLayer-like object is required.');

  const query = {
    ...(geometry === undefined ? {} : { geometry }),
    where,
    outFields,
    returnGeometry,
  };
  const requestOptions = signal ? { signal } : undefined;
  const result = await layer.queryFeatures(query, requestOptions);
  throwIfAborted(signal);
  return result;
};

export const queryByDistance = async (
  layer: ArcGisLayerLike,
  location: ArcGisGeometryLike,
  distanceValue: number,
  options: DistanceQueryOptions = {},
): Promise<ArcGisFeatureSetLike> => {
  throwIfAborted(options.signal);
  const geometry = await buffer(location, distanceValue, options.unit || 'meters');
  throwIfAborted(options.signal);
  return queryByGeometry(layer, { ...options, geometry });
};

export const createTimeExtent = (start: string | Date, end: string | Date): [Date, Date] => {
  const startDate = new Date(start);
  const endDate = new Date(end);
  if (!Number.isFinite(startDate.getTime()) || !Number.isFinite(endDate.getTime()) || startDate > endDate) {
    throw new Error('Invalid time extent.');
  }
  return [startDate, endDate];
};

export const createTimeSlider = (
  start: string | Date,
  end: string | Date,
  stepMs = 86400000,
  current: string | Date = start,
): TimeSliderState => {
  const [startDate, endDate] = createTimeExtent(start, end);
  const step = Number.isFinite(stepMs) && stepMs > 0 ? stepMs : 86400000;
  const requestedCurrent = new Date(current);
  const currentMs = Number.isFinite(requestedCurrent.getTime()) ? requestedCurrent.getTime() : startDate.getTime();
  const clampedCurrent = new Date(Math.min(endDate.getTime(), Math.max(startDate.getTime(), currentMs)));
  return {
    start: startDate.toISOString(),
    end: endDate.toISOString(),
    current: clampedCurrent.toISOString(),
    stepMs: step,
  };
};

export const moveTimeSlider = (state: TimeSliderState, direction = 1): TimeSliderState => {
  const [startDate, endDate] = createTimeExtent(state.start, state.end);
  const current = new Date(state.current);
  current.setTime(
    Math.min(
      endDate.getTime(),
      Math.max(startDate.getTime(), current.getTime() + Math.sign(direction) * state.stepMs),
    ),
  );
  return { ...state, current: current.toISOString() };
};

export const parseAnalysisInput = (input: AnalysisInput = {}): ParsedAnalysisInput => ({
  distance: Number(input.distance),
  unit: String(input.unit || 'meters'),
  where: String(input.where || '1=1'),
  maxResults: Math.min(2000, Math.max(1, Number(input.maxResults) || 100)),
});

export const summarizeFeatures = (result: ArcGisFeatureSetLike | null | undefined): FeatureSummary => {
  const features = result && Array.isArray(result.features) ? result.features : [];
  return {
    count: features.length,
    exceededTransferLimit: Boolean(result?.exceededTransferLimit),
    hasGeometry: features.some((feature) => Boolean(feature?.geometry)),
  };
};

export const stableQueryKey = (value: unknown): string => stable(value || {});

export const createDedupeExecutor = (): DedupeExecutor => {
  const inFlight = new Map<string, Promise<unknown>>();
  return <T>(key: string, work: () => Promise<T> | T): Promise<T> => {
    if (inFlight.has(key)) return inFlight.get(key) as Promise<T>;
    const promise = Promise.resolve()
      .then(work)
      .finally(() => inFlight.delete(key));
    inFlight.set(key, promise);
    return promise;
  };
};

export const normalizeServiceHealth = (
  id: string,
  status: string,
  extra: Record<string, unknown> = {},
): ServiceHealthSnapshot => ({
  serviceId: id,
  status,
  lastCheckedAt: new Date().toISOString(),
  ...extra,
});
