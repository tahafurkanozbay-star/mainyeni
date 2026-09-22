import { Constants_ServiceResultType } from '../Core/Constants';
import {
  fetchKentRehberiFeature,
  fetchKentRehberiGeoJson,
  type KentRehberiFetchOptions,
  type KentRehberiGeoJsonFeature,
  type KentRehberiGeoJsonFeatureCollection,
} from '../data-services/kentRehberiGeoJsonLayer';
import { runtimeConfig } from '../platform/config/runtimeConfig';
import type {
  FastAccessQuery,
  QueryExecutionControl,
  UnknownRecord,
} from './contracts';
import {
  getKentRehberiFastAccessProfile,
  type KentRehberiFastAccessProfile,
} from './kentRehberiFastAccessProfiles';

const PROBE_LIMIT = 250;
const CATEGORY_LIMIT = 2000;
const MAX_COMBINED_FEATURES = 4000;
const DEFAULT_MAX_CACHE_ENTRIES = 64;
const MAX_CACHE_TTL_MS = 5 * 60 * 1000;

export const KENT_REHBERI_FAST_ACCESS_SOURCE = 'kent-rehberi' as const;

export interface KentRehberiFastAccessPointGeometry {
  readonly type: 'point';
  readonly longitude: number;
  readonly latitude: number;
  readonly x: number;
  readonly y: number;
  readonly spatialReference: Readonly<{ readonly wkid: 4326 }>;
}

export interface KentRehberiFastAccessFeature {
  readonly attr: UnknownRecord;
  readonly attributes: UnknownRecord;
  readonly geometry?: KentRehberiFastAccessPointGeometry;
  readonly raw: Readonly<{
    readonly geometry: KentRehberiFastAccessPointGeometry | null;
  }>;
}

export interface KentRehberiFastAccessServiceResult {
  readonly type: typeof Constants_ServiceResultType.Success;
  readonly data: readonly KentRehberiFastAccessFeature[];
  readonly source: typeof KENT_REHBERI_FAST_ACCESS_SOURCE;
  readonly featureCollection: KentRehberiGeoJsonFeatureCollection;
  readonly message?: string;
}

export interface KentRehberiFastAccessBusiness {
  readonly Query: (
    query?: FastAccessQuery,
    returnGeometry?: boolean,
    control?: QueryExecutionControl,
  ) => Promise<KentRehberiFastAccessServiceResult>;
}

export interface KentRehberiFastAccessDependencies {
  readonly fetchCollection?: (
    options?: KentRehberiFetchOptions,
  ) => Promise<KentRehberiGeoJsonFeatureCollection>;
  readonly fetchFeature?: (
    objectId: number,
    options?: KentRehberiFetchOptions,
  ) => Promise<KentRehberiGeoJsonFeature | null>;
  readonly now?: () => number;
  readonly cacheTtlMs?: number;
  readonly maxCacheEntries?: number;
}

interface CacheEntry {
  readonly collection: KentRehberiGeoJsonFeatureCollection;
  readonly expiresAt: number;
}

interface TypeScore {
  readonly tur: number;
  readonly score: number;
  readonly count: number;
  readonly preferredHits: number;
}

interface ProbeResolution {
  readonly tur: number | null;
  readonly features: readonly KentRehberiGeoJsonFeature[];
}

const normalizeSearchText = (value: unknown): string => String(value ?? '')
  .trim()
  .toLocaleLowerCase('tr-TR')
  .normalize('NFKD')
  .replace(/[\u0300-\u036f]/gu, '')
  .replace(/ı/gu, 'i')
  .replace(/[._/\\-]+/gu, ' ')
  .replace(/\s+/gu, ' ');

const finiteNumber = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value.replace(',', '.'));
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
};

const positiveObjectId = (value: unknown): number | null => {
  const numeric = finiteNumber(value);
  if (numeric === null || !Number.isSafeInteger(numeric) || numeric <= 0) return null;
  return numeric;
};

const featureObjectId = (feature: KentRehberiGeoJsonFeature): number | null =>
  positiveObjectId(feature.properties.objectid ?? feature.id);

const featureTur = (feature: KentRehberiGeoJsonFeature): number | null => {
  const numeric = finiteNumber(feature.properties.tur);
  return numeric !== null && Number.isInteger(numeric) ? numeric : null;
};

const featureSearchText = (feature: KentRehberiGeoJsonFeature): string => normalizeSearchText([
  feature.properties.adi,
  feature.properties.adres,
  feature.properties.ilce,
  feature.properties.mahalle,
  feature.properties.webSayfasi,
  feature.properties.web_sayfasi,
  feature.properties.durakNo,
  feature.properties.durak_no,
].filter((value) => value !== null && value !== undefined && value !== '').join(' '));

const profileTerms = (values: readonly string[]): readonly string[] => Object.freeze(
  values.map(normalizeSearchText).filter(Boolean),
);

const isEligibleFeature = (
  feature: KentRehberiGeoJsonFeature,
  profile: KentRehberiFastAccessProfile,
): boolean => {
  const text = featureSearchText(feature);
  const excluded = profileTerms(profile.excludeTerms);
  return !excluded.some((term) => text.includes(term));
};

const scoreTypeGroups = (
  features: readonly KentRehberiGeoJsonFeature[],
  profile: KentRehberiFastAccessProfile,
): readonly TypeScore[] => {
  const preferred = profileTerms(profile.preferTerms);
  const scores = new Map<number, { score: number; count: number; preferredHits: number }>();

  for (const feature of features) {
    const tur = featureTur(feature);
    if (tur === null) continue;
    const text = featureSearchText(feature);
    const preferredHits = preferred.reduce(
      (count, term) => count + (text.includes(term) ? 1 : 0),
      0,
    );
    const current = scores.get(tur) ?? { score: 0, count: 0, preferredHits: 0 };
    scores.set(tur, {
      score: current.score + 1 + preferredHits * 6,
      count: current.count + 1,
      preferredHits: current.preferredHits + preferredHits,
    });
  }

  return Object.freeze([...scores.entries()]
    .map(([tur, value]) => Object.freeze({ tur, ...value }))
    .sort((left, right) =>
      right.score - left.score
      || right.preferredHits - left.preferredHits
      || right.count - left.count
      || left.tur - right.tur));
};

export const selectDominantKentRehberiTur = (
  features: readonly KentRehberiGeoJsonFeature[],
  profile: KentRehberiFastAccessProfile,
): number | null => {
  const eligible = features.filter((feature) => isEligibleFeature(feature, profile));
  const scores = scoreTypeGroups(eligible, profile);
  const best = scores[0];
  if (!best) return null;
  const second = scores[1];
  if (!second) return best.tur;

  if (best.preferredHits > 0 && best.preferredHits > second.preferredHits) {
    return best.tur;
  }
  if (best.score >= second.score * 1.5 && best.count >= 2) {
    return best.tur;
  }
  if (best.count >= Math.max(3, second.count * 2)) {
    return best.tur;
  }
  return null;
};

const makeFeatureCollection = (
  featuresInput: readonly KentRehberiGeoJsonFeature[],
  serviceKey: string,
  resolvedTur: readonly number[] = [],
): KentRehberiGeoJsonFeatureCollection => {
  const byObjectId = new Map<number, KentRehberiGeoJsonFeature>();
  for (const feature of featuresInput) {
    const objectId = featureObjectId(feature);
    if (objectId === null || byObjectId.has(objectId)) continue;
    byObjectId.set(objectId, feature);
    if (byObjectId.size >= MAX_COMBINED_FEATURES) break;
  }

  const features = Object.freeze([...byObjectId.values()].sort(
    (left, right) => (featureObjectId(left) ?? 0) - (featureObjectId(right) ?? 0),
  ));
  return Object.freeze({
    type: 'FeatureCollection',
    features,
    meta: Object.freeze({
      count: features.length,
      limit: MAX_COMBINED_FEATURES,
      hasMore: featuresInput.length > features.length,
      source: KENT_REHBERI_FAST_ACCESS_SOURCE,
      serviceKey,
      resolvedTur: Object.freeze([...resolvedTur].sort((left, right) => left - right)),
    }),
  });
};

const pointFromFeature = (
  feature: KentRehberiGeoJsonFeature,
): KentRehberiFastAccessPointGeometry | null => {
  const geometryCoordinates = feature.geometry?.type === 'Point'
    && Array.isArray(feature.geometry.coordinates)
    ? feature.geometry.coordinates
    : null;
  const longitude = finiteNumber(
    geometryCoordinates?.[0] ?? feature.properties.x,
  );
  const latitude = finiteNumber(
    geometryCoordinates?.[1] ?? feature.properties.y,
  );
  if (
    longitude === null
    || latitude === null
    || longitude < -180
    || longitude > 180
    || latitude < -90
    || latitude > 90
  ) {
    return null;
  }

  return Object.freeze({
    type: 'point',
    longitude,
    latitude,
    x: longitude,
    y: latitude,
    spatialReference: Object.freeze({ wkid: 4326 as const }),
  });
};

const toFastAccessFeature = (
  feature: KentRehberiGeoJsonFeature,
  returnGeometry: boolean,
): KentRehberiFastAccessFeature => {
  const point = pointFromFeature(feature);
  const base = {
    attr: feature.properties,
    attributes: feature.properties,
    raw: Object.freeze({ geometry: point }),
  };
  return Object.freeze({
    ...base,
    ...(returnGeometry && point ? { geometry: point } : {}),
  });
};

const objectIdFromQuery = (query: FastAccessQuery): number | null =>
  positiveObjectId(query.ObjectId ?? query.objectId);

const filterByQueryName = (
  collection: KentRehberiGeoJsonFeatureCollection,
  query: FastAccessQuery,
  serviceKey: string,
): KentRehberiGeoJsonFeatureCollection => {
  const needle = normalizeSearchText(query.name);
  if (!needle) return collection;
  return makeFeatureCollection(
    collection.features.filter((feature) => featureSearchText(feature).includes(needle)),
    serviceKey,
  );
};

const normalizeCacheTtl = (value: number | undefined, fallback: number): number => {
  const candidate = Number(value ?? fallback);
  if (!Number.isFinite(candidate) || candidate <= 0) return 0;
  return Math.min(MAX_CACHE_TTL_MS, Math.max(1000, Math.trunc(candidate)));
};

const normalizeCacheCapacity = (value: number | undefined): number => {
  const candidate = Number(value ?? DEFAULT_MAX_CACHE_ENTRIES);
  if (!Number.isSafeInteger(candidate) || candidate < 1) return DEFAULT_MAX_CACHE_ENTRIES;
  return Math.min(128, candidate);
};

const buildFetchOptions = (
  control: QueryExecutionControl,
  extra: Readonly<Partial<Pick<KentRehberiFetchOptions, 'limit' | 'q' | 'tur'>>>,
): KentRehberiFetchOptions => ({
  ...extra,
  ...(control.signal ? { signal: control.signal } : {}),
  ...(control.timeoutMs !== undefined ? { timeoutMs: control.timeoutMs } : {}),
});

export interface KentRehberiFastAccessRuntime {
  readonly createBusiness: (serviceKey: string) => KentRehberiFastAccessBusiness | null;
  readonly clearCache: () => void;
  readonly cacheSize: () => number;
}

export const createKentRehberiFastAccessRuntime = (
  dependencies: KentRehberiFastAccessDependencies = {},
): KentRehberiFastAccessRuntime => {
  const fetchCollection = dependencies.fetchCollection ?? fetchKentRehberiGeoJson;
  const fetchFeature = dependencies.fetchFeature ?? fetchKentRehberiFeature;
  const now = dependencies.now ?? (() => Date.now());
  const defaultCacheTtlMs = normalizeCacheTtl(
    dependencies.cacheTtlMs,
    runtimeConfig.cacheTtlMs,
  );
  const maxCacheEntries = normalizeCacheCapacity(dependencies.maxCacheEntries);
  const cache = new Map<string, CacheEntry>();

  const pruneCache = (timestamp: number): void => {
    for (const [key, entry] of cache) {
      if (entry.expiresAt <= timestamp) cache.delete(key);
    }
    while (cache.size > maxCacheEntries) {
      const oldest = cache.keys().next().value as string | undefined;
      if (!oldest) break;
      cache.delete(oldest);
    }
  };

  const readCache = (
    serviceKey: string,
    control: QueryExecutionControl,
  ): KentRehberiGeoJsonFeatureCollection | null => {
    if (control.cache === false) return null;
    const timestamp = Number(now());
    if (!Number.isFinite(timestamp)) return null;
    pruneCache(timestamp);
    const entry = cache.get(serviceKey);
    if (!entry) return null;
    cache.delete(serviceKey);
    cache.set(serviceKey, entry);
    return entry.collection;
  };

  const writeCache = (
    serviceKey: string,
    collection: KentRehberiGeoJsonFeatureCollection,
    control: QueryExecutionControl,
  ): void => {
    if (control.cache === false) return;
    const ttl = normalizeCacheTtl(control.cacheTtlMs, defaultCacheTtlMs);
    if (ttl <= 0) return;
    const timestamp = Number(now());
    if (!Number.isFinite(timestamp)) return;
    cache.delete(serviceKey);
    cache.set(serviceKey, Object.freeze({
      collection,
      expiresAt: timestamp + ttl,
    }));
    pruneCache(timestamp);
  };

  const resolveProbe = async (
    profile: KentRehberiFastAccessProfile,
    probe: string,
    control: QueryExecutionControl,
  ): Promise<ProbeResolution> => {
    const collection = await fetchCollection(buildFetchOptions(control, {
      limit: PROBE_LIMIT,
      q: probe,
    }));
    const features = Object.freeze(
      collection.features.filter((feature) => isEligibleFeature(feature, profile)),
    );
    return Object.freeze({
      tur: selectDominantKentRehberiTur(features, profile),
      features,
    });
  };

  const resolveCollection = async (
    profile: KentRehberiFastAccessProfile,
    control: QueryExecutionControl,
  ): Promise<KentRehberiGeoJsonFeatureCollection> => {
    const cached = readCache(profile.serviceKey, control);
    if (cached) return cached;

    const resolvedTur = new Set<number>();
    const directMatches: KentRehberiGeoJsonFeature[] = [];

    for (const probe of profile.probes) {
      const resolution = await resolveProbe(profile, probe, control);
      for (const feature of resolution.features) directMatches.push(feature);
      if (resolution.tur !== null) {
        resolvedTur.add(resolution.tur);
        if (profile.mode === 'first') break;
      }
    }

    let collection: KentRehberiGeoJsonFeatureCollection;
    if (resolvedTur.size > 0) {
      const categoryCollections = await Promise.all(
        [...resolvedTur].map((tur) => fetchCollection(buildFetchOptions(control, {
          limit: CATEGORY_LIMIT,
          tur,
        }))),
      );
      collection = makeFeatureCollection(
        categoryCollections.flatMap((value) => value.features),
        profile.serviceKey,
        [...resolvedTur],
      );
    } else {
      collection = makeFeatureCollection(directMatches, profile.serviceKey);
    }

    writeCache(profile.serviceKey, collection, control);
    return collection;
  };

  const findCachedFeature = (
    serviceKey: string,
    objectId: number,
    control: QueryExecutionControl,
  ): KentRehberiGeoJsonFeature | null => {
    const collection = readCache(serviceKey, control);
    if (!collection) return null;
    return collection.features.find(
      (feature) => featureObjectId(feature) === objectId,
    ) ?? null;
  };

  const createBusiness = (
    serviceKey: string,
  ): KentRehberiFastAccessBusiness | null => {
    const profile = getKentRehberiFastAccessProfile(serviceKey);
    if (!profile) return null;

    return Object.freeze({
      Query: async (
        query: FastAccessQuery = {},
        returnGeometry = false,
        control: QueryExecutionControl = {},
      ): Promise<KentRehberiFastAccessServiceResult> => {
        const objectId = objectIdFromQuery(query);
        let collection: KentRehberiGeoJsonFeatureCollection;

        if (objectId !== null) {
          const cachedFeature = findCachedFeature(profile.serviceKey, objectId, control);
          const feature = cachedFeature ?? await fetchFeature(
            objectId,
            buildFetchOptions(control, { limit: 1 }),
          );
          collection = makeFeatureCollection(
            feature ? [feature] : [],
            profile.serviceKey,
          );
        } else {
          collection = filterByQueryName(
            await resolveCollection(profile, control),
            query,
            profile.serviceKey,
          );
        }

        const data = Object.freeze(
          collection.features.map((feature) => toFastAccessFeature(feature, returnGeometry)),
        );
        return Object.freeze({
          type: Constants_ServiceResultType.Success,
          data,
          source: KENT_REHBERI_FAST_ACCESS_SOURCE,
          featureCollection: collection,
        });
      },
    });
  };

  return Object.freeze({
    createBusiness,
    clearCache: () => cache.clear(),
    cacheSize: () => cache.size,
  });
};

const defaultKentRehberiFastAccessRuntime = createKentRehberiFastAccessRuntime();

export const createKentRehberiFastAccessBusiness = (
  serviceKey: string,
): KentRehberiFastAccessBusiness | null =>
  defaultKentRehberiFastAccessRuntime.createBusiness(serviceKey);
