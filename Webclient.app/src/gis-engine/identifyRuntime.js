import { loadModules } from 'esri-loader';

const modulePromises = new Map();

const load = (name) => {
  if (!modulePromises.has(name)) {
    const promise = loadModules([name])
      .then((modules) => modules[0])
      .catch((error) => {
        modulePromises.delete(name);
        throw error;
      });
    modulePromises.set(name, promise);
  }
  return modulePromises.get(name);
};

const cancelledError = () => Object.assign(new Error('Identify cancelled.'), { code: 'CANCELLED' });

const throwIfAborted = (signal) => {
  if (signal?.aborted) throw cancelledError();
};

const normalizeLayerUrl = (value) => String(value || '').trim().replace(/\/+$/, '');

const isMapServiceUrl = (url) => /\/MapServer(?:\/\d+)?$/i.test(normalizeLayerUrl(url));
const isFeatureServiceUrl = (url) => /\/FeatureServer(?:\/\d+)?$/i.test(normalizeLayerUrl(url));

const getLayerItems = (view) => {
  const items = view?.map?.allLayers?.items;
  if (Array.isArray(items)) return items;
  if (typeof view?.map?.allLayers?.toArray === 'function') return view.map.allLayers.toArray();
  if (Array.isArray(view?.map?.layers?.items)) return view.map.layers.items;
  if (Array.isArray(view?.map?.layers)) return view.map.layers;
  return [];
};

const isVisible = (layer) => layer?.visible !== false && layer?.listMode !== 'hide';

const normalizeLayerIdentity = (layer, fallbackIndex = 0) => ({
  id: String(layer?.id || layer?.uid || layer?.title || `layer-${fallbackIndex}`),
  title: String(layer?.title || layer?.name || layer?.id || `Katman ${fallbackIndex + 1}`),
});

export const classifyIdentifyLayer = (layer, index = 0) => {
  const url = normalizeLayerUrl(layer?.url);
  const type = String(layer?.type || '').toLowerCase();
  const identity = normalizeLayerIdentity(layer, index);

  if (!isVisible(layer)) return { ...identity, kind: 'skip', reason: 'hidden', layer };
  if (type === 'group') return { ...identity, kind: 'skip', reason: 'group', layer };

  if (
    type === 'map-image' ||
    type === 'mapimage' ||
    isMapServiceUrl(url)
  ) {
    return { ...identity, kind: 'map-service', url, layer };
  }

  if (
    type === 'feature' ||
    type === 'feature-layer' ||
    isFeatureServiceUrl(url)
  ) {
    return { ...identity, kind: 'feature-layer', url, layer };
  }

  return { ...identity, kind: 'skip', reason: 'unsupported', url, layer };
};

export const collectIdentifyTargets = (view) => {
  const targets = getLayerItems(view).map(classifyIdentifyLayer);
  return {
    mapServices: targets.filter((target) => target.kind === 'map-service'),
    featureLayers: targets.filter((target) => target.kind === 'feature-layer'),
    skipped: targets.filter((target) => target.kind === 'skip'),
  };
};

const settleWithConcurrency = async (items, worker, concurrency = 4, signal) => {
  const source = Array.isArray(items) ? items : [];
  const limit = Math.max(1, Math.min(8, Number(concurrency) || 4));
  const results = new Array(source.length);
  let cursor = 0;

  const run = async () => {
    while (cursor < source.length) {
      throwIfAborted(signal);
      const index = cursor;
      cursor += 1;
      try {
        results[index] = { status: 'fulfilled', value: await worker(source[index], index) };
      } catch (error) {
        if (error?.code === 'CANCELLED') throw error;
        results[index] = { status: 'rejected', reason: error };
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(limit, source.length) }, run));
  return results;
};

const createIdentifyParameters = (IdentifyParameters, view, mapPoint, options = {}) => {
  const params = new IdentifyParameters({
    returnGeometry: options.returnGeometry !== false,
    geometry: mapPoint,
    tolerance: Number.isFinite(options.tolerance) ? Math.max(0, options.tolerance) : 3,
    mapExtent: view?.extent,
  });

  if (view?.width) params.width = view.width;
  if (view?.height) params.height = view.height;
  if (Number.isFinite(view?.resolution)) params.resolution = view.resolution;
  if (Number.isFinite(options.dpi)) params.dpi = options.dpi;
  if (options.layerOption) params.layerOption = options.layerOption;
  if (Array.isArray(options.layerIds) && options.layerIds.length) params.layerIds = options.layerIds;
  return params;
};

const normalizeMapServiceResult = (target, response) => {
  const results = Array.isArray(response?.results) ? response.results : [];
  return results.map((result, index) => ({
    source: 'identify',
    targetId: target.id,
    targetTitle: target.title,
    layerId: result?.layerId ?? target.id,
    layerName: result?.layerName || target.title,
    displayFieldName: result?.displayFieldName || null,
    value: result?.value ?? null,
    feature: result?.feature || null,
    attributes: result?.feature?.attributes || {},
    geometry: result?.feature?.geometry || null,
    resultIndex: index,
  }));
};

export const identifyMapServices = async (view, mapPoint, targets, options = {}) => {
  throwIfAborted(options.signal);
  const source = Array.isArray(targets) ? targets : collectIdentifyTargets(view).mapServices;
  if (!source.length) return { results: [], failures: [] };

  const [identify, IdentifyParameters] = await Promise.all([
    load('esri/rest/identify'),
    load('esri/rest/support/IdentifyParameters'),
  ]);
  throwIfAborted(options.signal);

  const settled = await settleWithConcurrency(
    source,
    async (target) => {
      throwIfAborted(options.signal);
      const params = createIdentifyParameters(IdentifyParameters, view, mapPoint, options);
      const requestOptions = options.signal ? { signal: options.signal } : undefined;
      const response = await identify.identify(target.url, params, requestOptions);
      throwIfAborted(options.signal);
      return normalizeMapServiceResult(target, response);
    },
    options.concurrency,
    options.signal,
  );

  const results = [];
  const failures = [];
  settled.forEach((entry, index) => {
    if (entry.status === 'fulfilled') results.push(...entry.value);
    else failures.push({ target: source[index], error: entry.reason });
  });
  return { results, failures };
};

const normalizeHitTestResult = (result, index = 0) => {
  const graphic = result?.graphic;
  const layer = graphic?.layer || result?.layer;
  const identity = normalizeLayerIdentity(layer, index);
  return {
    source: 'hit-test',
    targetId: identity.id,
    targetTitle: identity.title,
    layerId: identity.id,
    layerName: identity.title,
    displayFieldName: layer?.displayField || null,
    value: null,
    feature: graphic || null,
    attributes: graphic?.attributes || {},
    geometry: graphic?.geometry || result?.mapPoint || null,
    resultIndex: index,
  };
};

export const identifyFeatureLayers = async (view, screenEvent, targets, options = {}) => {
  throwIfAborted(options.signal);
  if (!view?.hitTest || !screenEvent) return [];
  const source = Array.isArray(targets) ? targets : collectIdentifyTargets(view).featureLayers;
  if (!source.length) return [];

  const include = source.map((target) => target.layer).filter(Boolean);
  const hitOptions = include.length ? { include } : undefined;
  const response = await view.hitTest(screenEvent, hitOptions);
  throwIfAborted(options.signal);

  const allowedLayers = new Set(include);
  return (Array.isArray(response?.results) ? response.results : [])
    .filter((result) => {
      const layer = result?.graphic?.layer || result?.layer;
      return !include.length || allowedLayers.has(layer);
    })
    .map(normalizeHitTestResult);
};

const resultObjectId = (result) => {
  const attributes = result?.attributes || result?.feature?.attributes || {};
  return attributes.OBJECTID
    ?? attributes.ObjectID
    ?? attributes.objectid
    ?? attributes.FID
    ?? attributes.fid
    ?? result?.feature?.uid
    ?? result?.feature?.id
    ?? null;
};

const resultKey = (result, fallbackIndex) => {
  const objectId = resultObjectId(result);
  if (objectId !== null && objectId !== undefined) return `${result.layerId}:${objectId}`;
  const geometry = result?.geometry;
  const point = geometry && Number.isFinite(geometry.x) && Number.isFinite(geometry.y)
    ? `${geometry.x}:${geometry.y}`
    : '';
  return `${result.layerId}:${point}:${fallbackIndex}`;
};

export const dedupeIdentifyResults = (results = []) => {
  const seen = new Set();
  return (Array.isArray(results) ? results : []).filter((result, index) => {
    const key = resultKey(result, index);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

export const groupIdentifyResults = (results = []) => {
  const groups = new Map();
  dedupeIdentifyResults(results).forEach((result) => {
    const key = String(result.layerId ?? result.targetId ?? result.layerName ?? 'unknown');
    if (!groups.has(key)) {
      groups.set(key, {
        layerId: result.layerId ?? result.targetId ?? null,
        layerName: result.layerName || result.targetTitle || 'Katman',
        features: [],
      });
    }
    groups.get(key).features.push(result);
  });
  return Array.from(groups.values());
};

export const executeGlobalIdentify = async (view, event, options = {}) => {
  if (!view || !event?.mapPoint) {
    return { groups: [], results: [], failures: [], skipped: [], targetCount: 0 };
  }
  throwIfAborted(options.signal);

  const targets = collectIdentifyTargets(view);
  const [mapServiceResponse, featureResults] = await Promise.all([
    identifyMapServices(view, event.mapPoint, targets.mapServices, options),
    identifyFeatureLayers(view, event, targets.featureLayers, options),
  ]);
  throwIfAborted(options.signal);

  const results = dedupeIdentifyResults([
    ...mapServiceResponse.results,
    ...featureResults,
  ]);

  return {
    groups: groupIdentifyResults(results),
    results,
    failures: mapServiceResponse.failures,
    skipped: targets.skipped,
    targetCount: targets.mapServices.length + targets.featureLayers.length,
  };
};

export const createIdentifySession = () => {
  let generation = 0;
  let controller = null;

  const cancel = () => {
    generation += 1;
    controller?.abort?.();
    controller = null;
  };

  const run = async (view, event, options = {}) => {
    cancel();
    const localGeneration = generation;
    controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const signal = controller?.signal;
    const result = await executeGlobalIdentify(view, event, { ...options, signal });
    if (generation !== localGeneration) throw cancelledError();
    return result;
  };

  return {
    run,
    cancel,
    get generation() { return generation; },
    get active() { return Boolean(controller); },
  };
};
