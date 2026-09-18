import { loadArcgisModule } from '../gis-engine/arcgisModuleRuntime';
import { normalizeApiBaseUrl, runtimeConfig } from '../platform/config/runtimeConfig';

const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 2000;
const DEFAULT_MAX_PAYLOAD_BYTES = 8 * 1024 * 1024;
const LAYER_ID = 'kent-rehberi-postgis';
const LAYER_TITLE = 'Kent Rehberi';

type JsonObject = Readonly<Record<string, unknown>>;

export interface KentRehberiGeoJsonFeature {
  readonly type: 'Feature';
  readonly id?: string | number;
  readonly geometry: JsonObject | null;
  readonly properties: JsonObject;
}

export interface KentRehberiGeoJsonFeatureCollection {
  readonly type: 'FeatureCollection';
  readonly features: readonly KentRehberiGeoJsonFeature[];
  readonly meta?: JsonObject;
}

export interface KentRehberiFetchOptions {
  readonly apiBaseUrl?: string;
  readonly limit?: number;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly maxPayloadBytes?: number;
  readonly fetchImpl?: typeof fetch;
}

export interface KentRehberiMapLike {
  add(layer: unknown): unknown;
  remove(layer: unknown): unknown;
}

export interface KentRehberiGeoJsonLayerLike {
  readonly id?: string;
  readonly title?: string;
  load?: () => Promise<unknown>;
  destroy?: () => void;
}

export interface KentRehberiLayerHandle {
  readonly layer: KentRehberiGeoJsonLayerLike;
  readonly featureCount: number;
  dispose(): void;
}

interface GeoJsonLayerConstructor {
  new(options: Readonly<Record<string, unknown>>): KentRehberiGeoJsonLayerLike;
}

interface AttachKentRehberiLayerOptions extends KentRehberiFetchOptions {
  readonly map: KentRehberiMapLike;
  readonly moduleLoader?: typeof loadArcgisModule;
}

const isJsonObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const createAbortError = (message = 'Kent Rehberi request was aborted.'): Error => {
  if (typeof DOMException !== 'undefined') return new DOMException(message, 'AbortError');
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
};

export const isKentRehberiAbortError = (error: unknown): boolean =>
  error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');

const normalizeLimit = (limit: number | undefined): number => {
  const candidate = limit ?? DEFAULT_LIMIT;
  if (!Number.isInteger(candidate) || candidate < 1 || candidate > MAX_LIMIT) {
    throw new RangeError(`Kent Rehberi limit must be an integer between 1 and ${MAX_LIMIT}.`);
  }
  return candidate;
};

const normalizePositiveInteger = (value: number | undefined, fallback: number, maximum: number): number => {
  const candidate = value ?? fallback;
  if (!Number.isInteger(candidate) || candidate < 1 || candidate > maximum) {
    throw new RangeError(`Kent Rehberi numeric option must be between 1 and ${maximum}.`);
  }
  return candidate;
};

export const buildKentRehberiRequestPath = (
  apiBaseUrl: string = runtimeConfig.apiBaseUrl,
  limit: number = DEFAULT_LIMIT,
): string => {
  const rawBase = String(apiBaseUrl).trim().replace(/\/+$/u, '');
  const normalizedBase = normalizeApiBaseUrl(rawBase);
  if (normalizedBase !== rawBase) {
    throw new Error('Kent Rehberi API base URL must be a canonical same-origin relative path.');
  }

  const search = new URLSearchParams({ limit: String(normalizeLimit(limit)) });
  return `${normalizedBase}/kent-rehberi?${search.toString()}`;
};

export const validateKentRehberiFeatureCollection = (
  value: unknown,
  maximumFeatures: number = MAX_LIMIT,
): KentRehberiGeoJsonFeatureCollection => {
  if (!isJsonObject(value) || value.type !== 'FeatureCollection' || !Array.isArray(value.features)) {
    throw new TypeError('Kent Rehberi response is not a GeoJSON FeatureCollection.');
  }
  if (value.features.length > maximumFeatures) {
    throw new RangeError('Kent Rehberi response exceeded the bounded feature limit.');
  }

  const features = value.features.map((candidate, index) => {
    if (!isJsonObject(candidate) || candidate.type !== 'Feature') {
      throw new TypeError(`Kent Rehberi feature ${index} is invalid.`);
    }
    if (candidate.geometry !== null && !isJsonObject(candidate.geometry)) {
      throw new TypeError(`Kent Rehberi feature ${index} has an invalid geometry.`);
    }
    if (!isJsonObject(candidate.properties)) {
      throw new TypeError(`Kent Rehberi feature ${index} has invalid properties.`);
    }

    const objectId = candidate.properties.objectid;
    if (!Number.isInteger(objectId) || Number(objectId) <= 0) {
      throw new TypeError(`Kent Rehberi feature ${index} is missing a valid objectid.`);
    }

    const feature: KentRehberiGeoJsonFeature = {
      type: 'Feature',
      geometry: candidate.geometry as JsonObject | null,
      properties: candidate.properties,
      ...(candidate.id === undefined ? {} : { id: candidate.id as string | number }),
    };
    return Object.freeze(feature);
  });

  return Object.freeze({
    type: 'FeatureCollection',
    features: Object.freeze(features),
    ...(isJsonObject(value.meta) ? { meta: value.meta } : {}),
  });
};

const createRequestSignal = (
  externalSignal: AbortSignal | undefined,
  timeoutMs: number,
): { readonly signal: AbortSignal; dispose(): void } => {
  const controller = new AbortController();
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

  const abortFromExternal = (): void => {
    if (!controller.signal.aborted) {
      controller.abort(externalSignal?.reason ?? createAbortError());
    }
  };

  if (externalSignal?.aborted) {
    abortFromExternal();
  } else {
    externalSignal?.addEventListener('abort', abortFromExternal, { once: true });
  }

  timeoutHandle = setTimeout(() => {
    if (!controller.signal.aborted) {
      const timeoutError = new Error('Kent Rehberi request timed out.');
      timeoutError.name = 'TimeoutError';
      controller.abort(timeoutError);
    }
  }, timeoutMs);

  return {
    signal: controller.signal,
    dispose: () => {
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
      externalSignal?.removeEventListener('abort', abortFromExternal);
    },
  };
};

const parseBoundedResponse = async (
  response: Response,
  maxPayloadBytes: number,
): Promise<KentRehberiGeoJsonFeatureCollection> => {
  const advertisedLength = Number.parseInt(response.headers.get('content-length') ?? '', 10);
  if (Number.isFinite(advertisedLength) && advertisedLength > maxPayloadBytes) {
    throw new RangeError('Kent Rehberi response exceeded the payload budget.');
  }

  const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
  if (contentType && !contentType.includes('application/geo+json') && !contentType.includes('application/json')) {
    throw new TypeError('Kent Rehberi endpoint returned an unexpected content type.');
  }

  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > maxPayloadBytes) {
    throw new RangeError('Kent Rehberi response exceeded the payload budget.');
  }

  let payload: unknown;
  try {
    payload = JSON.parse(text) as unknown;
  } catch {
    throw new TypeError('Kent Rehberi endpoint returned malformed JSON.');
  }
  return validateKentRehberiFeatureCollection(payload);
};

export const fetchKentRehberiGeoJson = async (
  options: KentRehberiFetchOptions = {},
): Promise<KentRehberiGeoJsonFeatureCollection> => {
  const limit = normalizeLimit(options.limit);
  const timeoutMs = normalizePositiveInteger(
    options.timeoutMs,
    Math.min(runtimeConfig.requestTimeoutMs, 10_000),
    60_000,
  );
  const maxPayloadBytes = normalizePositiveInteger(
    options.maxPayloadBytes,
    DEFAULT_MAX_PAYLOAD_BYTES,
    32 * 1024 * 1024,
  );
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new Error('Fetch API is unavailable for the Kent Rehberi layer.');
  }

  const request = createRequestSignal(options.signal, timeoutMs);
  try {
    const response = await fetchImpl(
      buildKentRehberiRequestPath(options.apiBaseUrl ?? runtimeConfig.apiBaseUrl, limit),
      {
        method: 'GET',
        credentials: 'same-origin',
        headers: { Accept: 'application/geo+json, application/json;q=0.9' },
        signal: request.signal,
      },
    );

    if (!response.ok) {
      throw new Error(`Kent Rehberi endpoint returned HTTP ${response.status}.`);
    }
    return await parseBoundedResponse(response, maxPayloadBytes);
  } finally {
    request.dispose();
  }
};

const kentRehberiFields = Object.freeze([
  { name: 'objectid', alias: 'Kayıt No', type: 'oid' },
  { name: 'adi', alias: 'Adı', type: 'string', length: 255 },
  { name: 'adres', alias: 'Adres', type: 'string', length: 255 },
  { name: 'ilce', alias: 'İlçe', type: 'string', length: 50 },
  { name: 'mahalle', alias: 'Mahalle', type: 'string', length: 50 },
  { name: 'x', alias: 'X', type: 'double' },
  { name: 'y', alias: 'Y', type: 'double' },
  { name: 'tur', alias: 'Tür', type: 'integer' },
  { name: 'yapan', alias: 'Yapan', type: 'integer' },
  { name: 'webSayfasi', alias: 'Web Sayfası', type: 'string', length: 255 },
  { name: 'durakNo', alias: 'Durak No', type: 'string', length: 254 },
]);

const popupFieldInfos = Object.freeze([
  { fieldName: 'objectid', label: 'Kayıt No', visible: true },
  { fieldName: 'adi', label: 'Adı', visible: true },
  { fieldName: 'adres', label: 'Adres', visible: true },
  { fieldName: 'ilce', label: 'İlçe', visible: true },
  { fieldName: 'mahalle', label: 'Mahalle', visible: true },
  { fieldName: 'tur', label: 'Tür', visible: true },
  { fieldName: 'durakNo', label: 'Durak No', visible: true },
  { fieldName: 'webSayfasi', label: 'Web Sayfası', visible: true },
]);

export const createKentRehberiGeoJsonLayer = async (
  geojson: KentRehberiGeoJsonFeatureCollection,
  moduleLoader: typeof loadArcgisModule = loadArcgisModule,
): Promise<KentRehberiGeoJsonLayerLike> => {
  if (typeof URL.createObjectURL !== 'function' || typeof URL.revokeObjectURL !== 'function') {
    throw new Error('Blob URL support is unavailable for the Kent Rehberi layer.');
  }

  const GeoJSONLayer = await moduleLoader<GeoJsonLayerConstructor>('esri/layers/GeoJSONLayer');
  const blob = new Blob([JSON.stringify(geojson)], { type: 'application/geo+json' });
  const objectUrl = URL.createObjectURL(blob);
  let layer: KentRehberiGeoJsonLayerLike | null = null;

  try {
    layer = new GeoJSONLayer({
      id: LAYER_ID,
      title: LAYER_TITLE,
      url: objectUrl,
      objectIdField: 'objectid',
      fields: kentRehberiFields,
      popupEnabled: true,
      outFields: ['objectid', 'adi', 'adres', 'ilce', 'mahalle', 'tur', 'yapan', 'webSayfasi', 'durakNo'],
      popupTemplate: {
        title: '{adi}',
        outFields: ['objectid', 'adi', 'adres', 'ilce', 'mahalle', 'tur', 'yapan', 'webSayfasi', 'durakNo'],
        content: [{ type: 'fields', fieldInfos: popupFieldInfos }],
      },
    });
    await layer.load?.();
    return layer;
  } catch (error) {
    layer?.destroy?.();
    throw error;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
};

export const attachKentRehberiGeoJsonLayer = async (
  options: AttachKentRehberiLayerOptions,
): Promise<KentRehberiLayerHandle> => {
  if (!options.map || typeof options.map.add !== 'function' || typeof options.map.remove !== 'function') {
    throw new TypeError('Kent Rehberi layer requires an ArcGIS map with add/remove support.');
  }

  const geojson = await fetchKentRehberiGeoJson(options);
  if (options.signal?.aborted) throw createAbortError();

  const layer = await createKentRehberiGeoJsonLayer(
    geojson,
    options.moduleLoader ?? loadArcgisModule,
  );
  if (options.signal?.aborted) {
    layer.destroy?.();
    throw createAbortError();
  }

  options.map.add(layer);
  let disposed = false;
  return Object.freeze({
    layer,
    featureCount: geojson.features.length,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      try {
        options.map.remove(layer);
      } finally {
        layer.destroy?.();
      }
    },
  });
};
