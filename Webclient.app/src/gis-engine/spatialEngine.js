import { loadModules } from 'esri-loader';

const modulePromises = new Map();

const loadModule = (name) => {
  if (!modulePromises.has(name)) {
    const promise = loadModules([name])
      .then((values) => values[0])
      .catch((error) => {
        modulePromises.delete(name);
        throw error;
      });
    modulePromises.set(name, promise);
  }
  return modulePromises.get(name);
};

const modules = (names) => Promise.all(names.map(loadModule));

const stable = (value, seen = new WeakSet()) => {
  if (value === null || value === undefined) return String(value);
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map((item) => stable(item, seen)).join(',')}]`;
  if (typeof value === 'object') {
    if (typeof value.toJSON === 'function') return stable(value.toJSON(), seen);
    if (seen.has(value)) return '"[Circular]"';
    seen.add(value);
    const result = `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stable(value[key], seen)}`)
      .join(',')}}`;
    seen.delete(value);
    return result;
  }
  return JSON.stringify(value);
};

const cancelledError = () => Object.assign(new Error('Query cancelled.'), { code: 'CANCELLED' });
const throwIfAborted = (signal) => {
  if (signal?.aborted) throw cancelledError();
};

export const distance = async (a, b, unit = 'meters') => {
  const [geometryEngine] = await modules(['esri/geometry/geometryEngine']);
  if (!a || !b) throw new Error('Two geometries are required.');
  return geometryEngine.geodesicDistance(a, b, unit);
};

export const area = async (geometry, unit = 'square-meters') => {
  const [geometryEngine] = await modules(['esri/geometry/geometryEngine']);
  if (!geometry) throw new Error('Geometry is required.');
  return geometryEngine.geodesicArea(geometry, unit);
};

export const buffer = async (geometry, distanceValue, unit = 'meters') => {
  const [geometryEngine] = await modules(['esri/geometry/geometryEngine']);
  if (!geometry || !Number.isFinite(distanceValue) || distanceValue < 0) {
    throw new Error('Valid geometry and buffer distance are required.');
  }
  return geometryEngine.buffer(geometry, distanceValue, unit);
};

export const nearest = async (source, candidates = [], unit = 'meters') => {
  const [geometryEngine] = await modules(['esri/geometry/geometryEngine']);
  let best = null;
  (candidates || []).forEach((geometry, index) => {
    if (!geometry) return;
    const candidateDistance = geometryEngine.distance(source, geometry, unit);
    if (Number.isFinite(candidateDistance) && (!best || candidateDistance < best.distance)) {
      best = { index, geometry, distance: candidateDistance };
    }
  });
  return best;
};

export const proximity = async (source, candidates, distanceValue, unit = 'meters') => {
  const buffered = await buffer(source, distanceValue, unit);
  const [geometryEngine] = await modules(['esri/geometry/geometryEngine']);
  return (candidates || []).filter((geometry) => geometry && geometryEngine.intersects(buffered, geometry));
};

export const spatialFilter = async (geometry, candidates = [], relation = 'intersects') => {
  const [geometryEngine] = await modules(['esri/geometry/geometryEngine']);
  if (typeof geometryEngine[relation] !== 'function') throw new Error(`Unsupported relation: ${relation}`);
  return candidates.filter((candidate) => candidate && geometryEngine[relation](geometry, candidate));
};

export const project = async (geometry, wkid) => {
  const [projection, SpatialReference] = await modules([
    'esri/geometry/projection',
    'esri/geometry/SpatialReference',
  ]);
  await projection.load();
  return projection.project(geometry, new SpatialReference({ wkid }));
};

export const queryByGeometry = async (
  layer,
  { geometry, where = '1=1', outFields = ['*'], returnGeometry = true, signal } = {},
) => {
  throwIfAborted(signal);
  if (!layer?.queryFeatures) throw new Error('FeatureLayer-like object is required.');

  const query = { geometry, where, outFields, returnGeometry };
  const requestOptions = signal ? { signal } : undefined;
  return layer.queryFeatures(query, requestOptions);
};

export const queryByDistance = async (layer, location, distanceValue, options = {}) =>
  queryByGeometry(layer, {
    ...options,
    geometry: await buffer(location, distanceValue, options.unit || 'meters'),
  });

export const createTimeExtent = (start, end) => {
  const startDate = new Date(start);
  const endDate = new Date(end);
  if (!Number.isFinite(startDate.getTime()) || !Number.isFinite(endDate.getTime()) || startDate > endDate) {
    throw new Error('Invalid time extent.');
  }
  return [startDate, endDate];
};

export const createTimeSlider = (start, end, stepMs = 86400000, current = start) => {
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

export const moveTimeSlider = (state, direction = 1) => {
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

export const parseAnalysisInput = (input = {}) => ({
  distance: Number(input.distance),
  unit: input.unit || 'meters',
  where: String(input.where || '1=1'),
  maxResults: Math.min(2000, Math.max(1, Number(input.maxResults) || 100)),
});

export const summarizeFeatures = (result) => {
  const features = Array.isArray(result?.features) ? result.features : [];
  return {
    count: features.length,
    exceededTransferLimit: Boolean(result?.exceededTransferLimit),
    hasGeometry: features.some((feature) => Boolean(feature?.geometry)),
  };
};

export const stableQueryKey = (value) => stable(value || {});

export const createDedupeExecutor = () => {
  const inFlight = new Map();
  return (key, work) => {
    if (inFlight.has(key)) return inFlight.get(key);
    const promise = Promise.resolve()
      .then(work)
      .finally(() => inFlight.delete(key));
    inFlight.set(key, promise);
    return promise;
  };
};

export const normalizeServiceHealth = (id, status, extra = {}) => ({
  serviceId: id,
  status,
  lastCheckedAt: new Date().toISOString(),
  ...extra,
});
