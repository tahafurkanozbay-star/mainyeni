import { loadArcgisModule } from '../gis-engine/arcgisModuleRuntime';
import iconEntries from '../gis-engine/iconRegistry.json';
import { normalizeIconKey } from '../gis-engine/iconResolver';
import {
  fetchPlanAskiFeatureDirect,
  fetchPlanAskiGeoJsonDirect,
  fetchPlanAskiSvgOverviewDirect,
  fetchPlanAskiTypeCatalogDirect,
  takePlanAskiPoiSearchIndex,
} from './kentRehberiPlanAskiDirect';
import {
  publishKentRehberiPoiSearchIndex,
  type KentRehberiPoiSearchInput,
} from './kentRehberiPoiSearchIndex';

const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 2000;
const LAYER_ID = 'kent-rehberi-postgis';
const LAYER_TITLE = 'Kent Rehberi';

interface OverviewIconRegistryEntry {
  readonly id?: unknown;
  readonly type?: unknown;
  readonly aliases?: unknown;
  readonly icon?: unknown;
  readonly url?: unknown;
  readonly src?: unknown;
}

interface OverviewSvgIcon {
  readonly id: string;
  readonly url: string;
  readonly aliases: readonly string[];
}

const overviewSvgIcons: readonly OverviewSvgIcon[] = Object.freeze(
  (iconEntries as readonly OverviewIconRegistryEntry[]).flatMap((entry): OverviewSvgIcon[] => {
    const id = typeof entry.id === 'string' ? entry.id.trim() : '';
    const url = [entry.icon, entry.url, entry.src].find(
      (candidate): candidate is string => typeof candidate === 'string' && /\.svg(?:[?#].*)?$/i.test(candidate),
    );
    if (!id || !url) return [];
    const rawAliases = [entry.id, entry.type, ...(Array.isArray(entry.aliases) ? entry.aliases : [])];
    const aliases = Object.freeze([...new Set(rawAliases
      .filter((alias): alias is string => typeof alias === 'string')
      .map(normalizeIconKey)
      .filter((alias) => alias.length >= 4))]);
    return [Object.freeze({ id, url, aliases })];
  }),
);

const overviewSvgAliasMatches = Object.freeze(overviewSvgIcons
  .flatMap((entry) => entry.aliases.map((alias) => Object.freeze({ id: entry.id, alias })))
  .sort((left, right) => right.alias.length - left.alias.length));

/** Resolve known POI names to the same SVG assets used by the service icons. */
export const resolveKentRehberiOverviewIconKey = (
  properties: Readonly<Record<string, unknown>>,
): string => {
  const title = normalizeIconKey([
    properties.adi,
    properties.name,
    properties.adres,
    properties.webSayfasi,
    properties.durakNo,
  ].filter((value) => typeof value === 'string' && value.trim()).join(' '));
  if (!title) return 'default';
  const hasWholeAlias = (alias: string): boolean =>
    title === alias
    || title.startsWith(`${alias} `)
    || title.endsWith(` ${alias}`)
    || title.includes(` ${alias} `);
  const match = overviewSvgAliasMatches.find(({ alias }) => hasWholeAlias(alias));
  return match?.id ?? 'default';
};

const overviewSvgRenderer = Object.freeze({
  type: 'unique-value',
  field: 'iconKey',
  uniqueValueInfos: Object.freeze(overviewSvgIcons.map((entry) => Object.freeze({
    value: entry.id,
    label: entry.id,
    symbol: Object.freeze({
      type: 'picture-marker',
      url: entry.url,
      width: '28px',
      height: '32px',
    }),
  }))),
  // Keep unclassified records from falling back to generic orange markers.
  // Only registry entries with real SVG assets are painted on the overview.
  defaultSymbol: Object.freeze({
    type: 'simple-marker',
    style: 'circle',
    color: [0, 0, 0, 0],
    size: 1,
    outline: Object.freeze({ color: [0, 0, 0, 0], width: 0 }),
  }),
});

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

const pendingPointSearchIndexes = new WeakMap<
  KentRehberiGeoJsonFeatureCollection,
  readonly KentRehberiPoiSearchInput[]
>();

export interface KentRehberiTypeSample {
  readonly objectid: number;
  readonly adi: string | null;
  readonly adres: string | null;
  readonly durakNo: string | null;
}

export interface KentRehberiTypeDescriptor {
  readonly tur: number;
  readonly count: number;
  readonly samples: readonly KentRehberiTypeSample[];
}

export interface KentRehberiTypeCatalog {
  readonly types: readonly KentRehberiTypeDescriptor[];
}

export interface KentRehberiRequestFilters {
  readonly q?: string;
  readonly tur?: number;
  readonly ilce?: string;
  readonly mahalle?: string;
}

export interface KentRehberiFetchOptions extends KentRehberiRequestFilters {
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
  /** Client-side category filter shared by MapView and SceneView. */
  definitionExpression?: string | null;
  load?: (options?: { readonly signal?: AbortSignal }) => Promise<unknown>;
  cancelLoad?: () => void;
  destroy?: () => void;
}

export interface KentRehberiLayerHandle {
  readonly layer: KentRehberiGeoJsonLayerLike;
  readonly featureCount: number;
  dispose(): void;
}

export interface KentRehberiLayerPresentationOptions {
  readonly id?: string;
  readonly title?: string;
  readonly renderer?: Readonly<Record<string, unknown>>;
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

// This dataset is an EPSG:4326 point layer, not an arbitrary GeoJSON
// geometry collection. Reject unexpected geometry before ArcGIS parses it.
const validateKentRehberiPoint = (geometry: unknown, index: number): JsonObject | null => {
  if (geometry === null) return null;
  if (!isJsonObject(geometry) || geometry.type !== 'Point'
    || !Array.isArray(geometry.coordinates) || geometry.coordinates.length !== 2) {
    throw new TypeError(`Kent Rehberi feature ${index} has an invalid Point geometry.`);
  }

  const [longitude, latitude] = geometry.coordinates;
  if (typeof longitude !== 'number' || typeof latitude !== 'number'
    || !Number.isFinite(longitude) || !Number.isFinite(latitude)
    || Math.abs(longitude) > 180 || Math.abs(latitude) > 90) {
    throw new TypeError(`Kent Rehberi feature ${index} has invalid WGS84 coordinates.`);
  }

  return geometry;
};

export const validateKentRehberiFeature = (
  candidate: unknown,
  index = 0,
): KentRehberiGeoJsonFeature => {
  if (!isJsonObject(candidate) || candidate.type !== 'Feature') {
    throw new TypeError(`Kent Rehberi feature ${index} is invalid.`);
  }
  const geometry = validateKentRehberiPoint(candidate.geometry, index);
  if (!isJsonObject(candidate.properties)) {
    throw new TypeError(`Kent Rehberi feature ${index} has invalid properties.`);
  }

  const objectId = candidate.properties.objectid;
  if (typeof objectId !== 'number' || !Number.isSafeInteger(objectId)
    || objectId <= 0 || objectId > 2_147_483_647) {
    throw new TypeError(`Kent Rehberi feature ${index} is missing a valid objectid.`);
  }

  // Keep optional GeoJSON id consistent with the canonical object ID.
  if (candidate.id !== undefined
    && (typeof candidate.id !== 'string' && typeof candidate.id !== 'number'
      || String(candidate.id) !== String(objectId))) {
    throw new TypeError(`Kent Rehberi feature ${index} has a mismatched id.`);
  }

  return Object.freeze({
    type: 'Feature',
    geometry,
    properties: candidate.properties,
    ...(candidate.id === undefined ? {} : { id: candidate.id as string | number }),
  });
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

  const seenObjectIds = new Set<number>();
  const features = value.features.map((candidate, index) => {
    const feature = validateKentRehberiFeature(candidate, index);
    const objectId = feature.properties.objectid as number;
    if (seenObjectIds.has(objectId)) {
      throw new TypeError(`Kent Rehberi response contains a duplicate objectid: ${objectId}.`);
    }
    seenObjectIds.add(objectId);
    return feature;
  });

  return Object.freeze({
    type: 'FeatureCollection',
    features: Object.freeze(features),
    ...(isJsonObject(value.meta) ? { meta: value.meta } : {}),
  });
};

const validateCatalogText = (
  value: unknown,
  field: string,
): string | null => {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') {
    throw new TypeError(`Kent Rehberi type catalog ${field} must be a string or null.`);
  }
  if (value.length > 1024) {
    throw new RangeError(`Kent Rehberi type catalog ${field} exceeded the text budget.`);
  }
  for (const character of value) {
    if (/\p{Cc}/u.test(character)) {
      throw new TypeError(`Kent Rehberi type catalog ${field} contains control characters.`);
    }
  }
  return value;
};

export const validateKentRehberiTypeCatalog = (
  value: unknown,
): KentRehberiTypeCatalog => {
  if (!isJsonObject(value) || !Array.isArray(value.types)) {
    throw new TypeError('Kent Rehberi type catalog response is invalid.');
  }
  if (value.types.length > 1024) {
    throw new RangeError('Kent Rehberi type catalog exceeded the type budget.');
  }

  const seenTypes = new Set<number>();
  const types = value.types.map((candidate, typeIndex) => {
    if (!isJsonObject(candidate)) {
      throw new TypeError(`Kent Rehberi type catalog item ${typeIndex} is invalid.`);
    }
    const tur = Number(candidate.tur);
    const count = Number(candidate.count);
    if (!Number.isInteger(tur) || tur < -32768 || tur > 32767) {
      throw new TypeError(`Kent Rehberi type catalog item ${typeIndex} has an invalid tur.`);
    }
    if (seenTypes.has(tur)) {
      throw new TypeError('Kent Rehberi type catalog contains duplicate tur values.');
    }
    seenTypes.add(tur);
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new TypeError(`Kent Rehberi type catalog item ${typeIndex} has an invalid count.`);
    }
    if (!Array.isArray(candidate.samples) || candidate.samples.length > 32) {
      throw new RangeError(`Kent Rehberi type catalog item ${typeIndex} exceeded the sample budget.`);
    }
    if (candidate.samples.length > count) {
      throw new TypeError(`Kent Rehberi type catalog item ${typeIndex} has more samples than records.`);
    }

    const seenObjectIds = new Set<number>();
    const samples = candidate.samples.map((sample, sampleIndex) => {
      if (!isJsonObject(sample)) {
        throw new TypeError(
          `Kent Rehberi type catalog sample ${typeIndex}:${sampleIndex} is invalid.`,
        );
      }
      const objectid = sample.objectid;
      if (typeof objectid !== 'number' || !Number.isSafeInteger(objectid) || objectid <= 0) {
        throw new TypeError(
          `Kent Rehberi type catalog sample ${typeIndex}:${sampleIndex} has an invalid objectid.`,
        );
      }
      if (seenObjectIds.has(objectid)) {
        throw new TypeError(
          `Kent Rehberi type catalog item ${typeIndex} contains duplicate sample ids.`,
        );
      }
      seenObjectIds.add(objectid);

      return Object.freeze({
        objectid,
        adi: validateCatalogText(sample.adi, 'adi'),
        adres: validateCatalogText(sample.adres, 'adres'),
        durakNo: validateCatalogText(sample.durakNo, 'durakNo'),
      });
    });

    return Object.freeze({
      tur,
      count,
      samples: Object.freeze(samples),
    });
  });

  return Object.freeze({
    types: Object.freeze(types),
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

export const fetchKentRehberiGeoJson = async (
  options: KentRehberiFetchOptions = {},
): Promise<KentRehberiGeoJsonFeatureCollection> => {
  const limit = normalizeLimit(options.limit);
  const timeoutMs = normalizePositiveInteger(options.timeoutMs, 30_000, 60_000);
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('Fetch API is unavailable for the Kent Rehberi layer.');

  const request = createRequestSignal(options.signal, timeoutMs);
  try {
    return validateKentRehberiFeatureCollection(
      await fetchPlanAskiGeoJsonDirect({ ...options, limit, signal: request.signal }),
    );
  } finally {
    request.dispose();
  }
};

/**
 * Loads every upstream category, keeps records with a registered SVG icon, and
 * applies a separate fixed result cap. The ordinary query API remains limited
 * to 2,000 results per call.
 */
export const fetchKentRehberiSvgOverviewGeoJson = async (
  options: KentRehberiFetchOptions = {},
): Promise<KentRehberiGeoJsonFeatureCollection> => {
  const timeoutMs = normalizePositiveInteger(options.timeoutMs, 30_000, 60_000);
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new Error('Fetch API is unavailable for the Kent Rehberi overview layer.');
  }

  const request = createRequestSignal(options.signal, timeoutMs);
  try {
    const rawCollection = await fetchPlanAskiSvgOverviewDirect(
      { ...options, signal: request.signal },
      resolveKentRehberiOverviewIconKey,
    );
    const pendingSearchIndex = takePlanAskiPoiSearchIndex(rawCollection);
    const collection = validateKentRehberiFeatureCollection(rawCollection, 20_000);
    // Validation creates a safe copy of the GeoJSON collection; carry the
    // compact index to that exact object so the layer can publish it after add.
    if (pendingSearchIndex) pendingPointSearchIndexes.set(collection, pendingSearchIndex);
    return collection;
  } finally {
    request.dispose();
  }
};

export const fetchKentRehberiFeature = async (
  objectId: number,
  options: KentRehberiFetchOptions = {},
): Promise<KentRehberiGeoJsonFeature | null> => {
  const timeoutMs = normalizePositiveInteger(options.timeoutMs, 30_000, 60_000);
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('Fetch API is unavailable for the Kent Rehberi layer.');

  const request = createRequestSignal(options.signal, timeoutMs);
  try {
    const feature = await fetchPlanAskiFeatureDirect(objectId, { ...options, signal: request.signal });
    return feature === null ? null : validateKentRehberiFeature(feature);
  } finally {
    request.dispose();
  }
};

export const fetchKentRehberiTypeCatalog = async (
  options: KentRehberiFetchOptions = {},
): Promise<KentRehberiTypeCatalog> => {
  const timeoutMs = normalizePositiveInteger(options.timeoutMs, 30_000, 60_000);
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('Fetch API is unavailable for the Kent Rehberi type catalog.');

  const request = createRequestSignal(options.signal, timeoutMs);
  try {
    return validateKentRehberiTypeCatalog(
      await fetchPlanAskiTypeCatalogDirect({ ...options, signal: request.signal }),
    );
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
  { name: 'iconKey', alias: 'SVG simgesi', type: 'string', length: 80 },
  { name: 'yapan', alias: 'Yapan', type: 'integer' },
  { name: 'webSayfasi', alias: 'Web Sayfası', type: 'string', length: 255 },
  { name: 'durakNo', alias: 'Durak No', type: 'string', length: 254 },
]);

interface KentRehberiPopupGraphic {
  readonly attributes?: Readonly<Record<string, unknown>>;
  readonly geometry?: unknown;
}

interface KentRehberiPopupFeature {
  readonly graphic?: KentRehberiPopupGraphic;
}

interface KentRehberiPopupCoordinates {
  readonly latitude: number;
  readonly longitude: number;
}

const resolveKentRehberiPopupCoordinates = (
  graphic: KentRehberiPopupGraphic | undefined,
): KentRehberiPopupCoordinates | null => {
  const geometry = isJsonObject(graphic?.geometry) ? graphic.geometry : null;
  const attributes = graphic?.attributes ?? {};
  // GeoJSONLayer points are WGS84. Prefer the SDK's geographic properties, then
  // fall back to x/y and the source's x/y attributes for resilient popups.
  const longitude = geometry
    ? (typeof geometry.longitude === 'number' ? geometry.longitude : geometry.x)
    : attributes.x;
  const latitude = geometry
    ? (typeof geometry.latitude === 'number' ? geometry.latitude : geometry.y)
    : attributes.y;

  if (typeof longitude !== 'number' || typeof latitude !== 'number'
    || !Number.isFinite(longitude) || !Number.isFinite(latitude)
    || Math.abs(longitude) > 180 || Math.abs(latitude) > 90) {
    return null;
  }

  return { latitude, longitude };
};

const createGoogleMapsPopupLink = (
  label: string,
  href: string,
  variant: 'primary' | 'secondary',
): HTMLAnchorElement => {
  const link = document.createElement('a');
  link.className = `kent-rehberi-popup__action kent-rehberi-popup__action--${variant}`;
  link.href = href;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.textContent = label;
  link.setAttribute('aria-label', `${label} — Google Haritalar yeni sekmede açılır`);
  return link;
};

/** Render just the address and useful Google Maps actions for a selected POI. */
export const createKentRehberiPopupContent = (
  feature: KentRehberiPopupFeature,
): HTMLElement => {
  const graphic = feature?.graphic;
  const attributes = graphic?.attributes ?? {};
  const rawAddress = attributes.adres;
  const address = typeof rawAddress === 'string'
    ? rawAddress.replace(/[\t\r\n]+/g, ' ').replace(/\s{2,}/g, ' ').trim()
    : '';
  const coordinates = resolveKentRehberiPopupCoordinates(graphic);
  const target = coordinates
    ? `${coordinates.latitude},${coordinates.longitude}`
    : address;

  const content = document.createElement('div');
  content.className = 'kent-rehberi-popup';

  if (address) {
    const addressElement = document.createElement('div');
    addressElement.className = 'kent-rehberi-popup__address';
    addressElement.textContent = address;
    content.append(addressElement);
  }

  if (target) {
    const directions = new URL('https://www.google.com/maps/dir/');
    directions.searchParams.set('api', '1');
    directions.searchParams.set('destination', target);

    // Street View's viewpoint requires coordinates. Do not offer a misleading
    // pano link for records where only a text address is available.
    const actions = document.createElement('div');
    actions.className = 'kent-rehberi-popup__actions';
    actions.append(createGoogleMapsPopupLink('Yol tarifi al', directions.toString(), 'primary'));

    if (coordinates) {
      const streetView = new URL('https://www.google.com/maps/@');
      streetView.searchParams.set('api', '1');
      streetView.searchParams.set('map_action', 'pano');
      streetView.searchParams.set('viewpoint', String(coordinates.latitude) + ',' + String(coordinates.longitude));
      actions.append(createGoogleMapsPopupLink('Sokak görünümü al', streetView.toString(), 'secondary'));
    }
    content.append(actions);
  }

  return content;
};

export const createKentRehberiGeoJsonLayer = async (
  geojson: KentRehberiGeoJsonFeatureCollection,
  moduleLoader: typeof loadArcgisModule = loadArcgisModule,
  presentation: KentRehberiLayerPresentationOptions = {},
  signal?: AbortSignal,
): Promise<KentRehberiGeoJsonLayerLike> => {
  signal?.throwIfAborted();
  if (typeof URL.createObjectURL !== 'function' || typeof URL.revokeObjectURL !== 'function') {
    throw new Error('Blob URL support is unavailable for the Kent Rehberi layer.');
  }

  const GeoJSONLayer = await moduleLoader<GeoJsonLayerConstructor>('esri/layers/GeoJSONLayer');
  signal?.throwIfAborted();
  const blob = new Blob([JSON.stringify(geojson)], { type: 'application/geo+json' });
  const objectUrl = URL.createObjectURL(blob);
  let layer: KentRehberiGeoJsonLayerLike | null = null;
  let abortLoad: (() => void) | undefined;

  try {
    layer = new GeoJSONLayer({
      id: String(presentation.id ?? LAYER_ID).trim() || LAYER_ID,
      title: String(presentation.title ?? LAYER_TITLE).trim() || LAYER_TITLE,
      url: objectUrl,
      objectIdField: 'objectid',
      fields: kentRehberiFields,
      popupEnabled: true,
      outFields: ['objectid', 'adi', 'adres', 'ilce', 'mahalle', 'tur', 'yapan', 'webSayfasi', 'durakNo', 'iconKey'],
      popupTemplate: {
        title: '{adi}',
        outFields: ['objectid', 'adi', 'adres', 'ilce', 'mahalle', 'tur', 'yapan', 'webSayfasi', 'durakNo', 'iconKey'],
        returnGeometry: true,
        content: createKentRehberiPopupContent,
      },
      ...(presentation.renderer ? { renderer: presentation.renderer } : {}),
    });
    const loading = layer.load?.(signal ? { signal } : {});
    if (signal) {
      await Promise.race([
        loading,
        new Promise<never>((_resolve, reject) => {
          abortLoad = () => {
            try { layer?.cancelLoad?.(); }
            catch (error) { reject(signal.reason ?? error); return; }
            reject(signal.reason ?? createAbortError());
          };
          signal.addEventListener('abort', abortLoad, { once: true });
          if (signal.aborted) abortLoad();
        }),
      ]);
      signal.throwIfAborted();
    } else {
      await loading;
    }
    return layer;
  } catch (error) {
    layer?.destroy?.();
    throw error;
  } finally {
    if (abortLoad) signal?.removeEventListener('abort', abortLoad);
    URL.revokeObjectURL(objectUrl);
  }
};

export const attachKentRehberiGeoJsonLayer = async (
  options: AttachKentRehberiLayerOptions,
): Promise<KentRehberiLayerHandle> => {
  if (!options.map || typeof options.map.add !== 'function' || typeof options.map.remove !== 'function') {
    throw new TypeError('Kent Rehberi layer requires an ArcGIS map with add/remove support.');
  }

  const isSvgOverview = options.tur === undefined
    && !options.q
    && !options.ilce
    && !options.mahalle;
  const geojson = isSvgOverview
    ? await fetchKentRehberiSvgOverviewGeoJson(options)
    : await fetchKentRehberiGeoJson(options);
  const pointSearchRecords = isSvgOverview ? pendingPointSearchIndexes.get(geojson) ?? null : null;
  if (isSvgOverview) pendingPointSearchIndexes.delete(geojson);
  if (options.signal?.aborted) throw createAbortError();

  const layer = await createKentRehberiGeoJsonLayer(
    geojson,
    options.moduleLoader ?? loadArcgisModule,
    isSvgOverview ? { id: LAYER_ID, title: LAYER_TITLE, renderer: overviewSvgRenderer } : {},
    options.signal,
  );
  if (options.signal?.aborted) {
    layer.destroy?.();
    throw createAbortError();
  }

  try {
    options.map.add(layer);
  } catch (error) {
    layer.destroy?.();
    throw error;
  }

  const releasePointSearchIndex = pointSearchRecords
    ? publishKentRehberiPoiSearchIndex(pointSearchRecords)
    : null;
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
        releasePointSearchIndex?.();
        layer.destroy?.();
      }
    },
  });
};
