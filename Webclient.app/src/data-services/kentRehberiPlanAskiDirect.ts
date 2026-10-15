import { readBoundedResponseText } from './boundedResponseText';
import type {
  KentRehberiFetchOptions,
  KentRehberiGeoJsonFeature,
  KentRehberiGeoJsonFeatureCollection,
  KentRehberiTypeCatalog,
  KentRehberiTypeDescriptor,
} from './kentRehberiGeoJsonLayer';

// Do not accept arbitrary origins or URL overrides: this mode deliberately
// speaks only to the official, browser-CORS-enabled municipal endpoint.
const SOURCE = 'https://planaski.ankara.bel.tr/kentrehberiapi/api/kentrehberi';
const MIN_TYPE = 0;
const MAX_TYPE = 42;
const MAX_ROWS_PER_TYPE = 20_000;
const MAX_BYTES_PER_TYPE = 8 * 1024 * 1024;
const MAX_TEXT = 4096;
const MAX_LIMIT = 2000;
const MAX_IN_FLIGHT = 4;

type RecordValue = Readonly<Record<string, unknown>>;

const isObject = (value: unknown): value is RecordValue =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const optionalText = (raw: unknown, lineBreaks = false): string | null => {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'string' && typeof raw !== 'number' && typeof raw !== 'boolean') {
    throw new TypeError('PlanASKI returned a non-scalar text field.');
  }
  let text = String(raw).trim();
  if (lineBreaks) text = text.replace(/\r\n|\r|\n/gu, ' ');
  if (!text) return null;
  if (text.length > MAX_TEXT) {
    throw new TypeError('PlanASKI returned an oversized text field.');
  }
  for (const character of text) {
    const code = character.charCodeAt(0);
    if (code <= 31 || (code >= 127 && code <= 159)) {
      throw new TypeError('PlanASKI returned a control character.');
    }
  }
  return text;
};

const requiredInteger = (raw: unknown, minimum: number, maximum: number): number => {
  if (typeof raw !== 'number' && typeof raw !== 'string') {
    throw new TypeError('PlanASKI returned a nonnumeric identifier.');
  }
  if (typeof raw === 'string' && !/^-?\d+$/u.test(raw.trim())) {
    throw new TypeError('PlanASKI returned an invalid numeric identifier.');
  }
  const numeric = Number(raw);
  if (!Number.isSafeInteger(numeric) || numeric < minimum || numeric > maximum) {
    throw new TypeError('PlanASKI returned an out-of-range identifier.');
  }
  return numeric;
};

const coordinate = (raw: unknown, bound: number): number | null => {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'number' && typeof raw !== 'string') {
    throw new TypeError('PlanASKI returned a nonnumeric coordinate.');
  }
  if (typeof raw === 'string' && !raw.trim()) {
    throw new TypeError('PlanASKI returned a blank coordinate.');
  }
  const numeric = Number(typeof raw === 'string' ? raw.replace(',', '.').trim() : raw);
  if (!Number.isFinite(numeric) || Math.abs(numeric) > bound) {
    throw new TypeError('PlanASKI returned an out-of-range coordinate.');
  }
  return numeric;
};

const sourceType = (tur: number): number =>
  requiredInteger(tur, MIN_TYPE, MAX_TYPE);

const normalizeName = (raw: unknown): string =>
  String(raw ?? '')
    .trim()
    .toLocaleLowerCase('tr-TR')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/ı/gu, 'i')
    .replace(/\s+/gu, ' ');

const parseFeature = (raw: unknown, tur: number): KentRehberiGeoJsonFeature => {
  if (!isObject(raw)) throw new TypeError('PlanASKI returned an invalid record.');
  const objectid = requiredInteger(raw.objectId ?? raw.objectid, 1, 2147483647);
  const actualTur = requiredInteger(raw.tur, MIN_TYPE, MAX_TYPE);
  if (actualTur !== tur) throw new TypeError('PlanASKI returned a mismatched category.');
  const x = coordinate(raw.x, 180);
  const y = coordinate(raw.y, 90);
  if ((x === null) !== (y === null)) {
    throw new TypeError('PlanASKI returned an incomplete coordinate pair.');
  }
  const yapan = raw.yapan == null ? null : requiredInteger(raw.yapan, -32768, 32767);

  return {
    type: 'Feature',
    id: objectid,
    geometry: x === null || y === null ? null : { type: 'Point', coordinates: [x, y] },
    properties: {
      objectid,
      adi: optionalText(raw.adi, true),
      adres: optionalText(raw.adres, true),
      ilce: optionalText(raw.ilce),
      mahalle: optionalText(raw.mahalle),
      x,
      y,
      tur,
      yapan,
      webSayfasi: optionalText(raw.webSayfasi ?? raw.web_sayfasi),
      durakNo: optionalText(raw.durakNo ?? raw.durak_no),
    },
  };
};

const fetchType = async (
  tur: number,
  options: KentRehberiFetchOptions,
): Promise<readonly KentRehberiGeoJsonFeature[]> => {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('Fetch API is unavailable.');
  const response = await fetchImpl(SOURCE + '?tur=' + String(sourceType(tur)), {
    method: 'GET',
    mode: 'cors',
    credentials: 'omit',
    cache: 'no-store',
    redirect: 'error',
    headers: { Accept: 'application/json' },
    ...(options.signal ? { signal: options.signal } : {}),
  });
  if (!response.ok) throw new Error('PlanASKI category request failed.');
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
  if (!contentType.includes('application/json')) {
    throw new TypeError('PlanASKI returned an unexpected content type.');
  }
  const statedBytes = Number.parseInt(response.headers.get('content-length') ?? '', 10);
  if (Number.isFinite(statedBytes) && statedBytes > MAX_BYTES_PER_TYPE) {
    throw new RangeError('PlanASKI category response exceeded its size budget.');
  }
  const body = await readBoundedResponseText(response, MAX_BYTES_PER_TYPE, 'PlanASKI category');
  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch {
    throw new TypeError('PlanASKI returned invalid JSON.');
  }
  if (!Array.isArray(parsed) || parsed.length > MAX_ROWS_PER_TYPE) {
    throw new TypeError('PlanASKI category response is not a bounded array.');
  }
  const seen = new Set<number>();
  return parsed.map((row) => {
    const feature = parseFeature(row, tur);
    const id = feature.properties.objectid as number;
    if (seen.has(id)) throw new TypeError('PlanASKI contains a repeated objectid.');
    seen.add(id);
    return feature;
  });
};

const fetchCategories = async (
  options: KentRehberiFetchOptions,
  category?: number,
): Promise<readonly (readonly KentRehberiGeoJsonFeature[])[]> => {
  const types = category === undefined
    ? Array.from({ length: MAX_TYPE - MIN_TYPE + 1 }, (_, index) => index + MIN_TYPE)
    : [sourceType(category)];
  const groups: (readonly KentRehberiGeoJsonFeature[])[] = Array.from({ length: types.length });
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(MAX_IN_FLIGHT, types.length) }, async () => {
    while (cursor < types.length) {
      options.signal?.throwIfAborted();
      const index = cursor++;
      groups[index] = await fetchType(types[index]!, options);
    }
  }));
  return groups;
};

const fullSet = (groups: readonly (readonly KentRehberiGeoJsonFeature[])[]): readonly KentRehberiGeoJsonFeature[] => {
  const seen = new Set<number>();
  const features = groups.flat();
  for (const feature of features) {
    const id = feature.properties.objectid as number;
    if (seen.has(id)) throw new TypeError('PlanASKI returned an objectid shared across categories.');
    seen.add(id);
  }
  return features;
};

export const fetchPlanAskiGeoJsonDirect = async (
  options: KentRehberiFetchOptions = {},
): Promise<KentRehberiGeoJsonFeatureCollection> => {
  const limit = options.limit ?? 500;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new RangeError('Invalid PlanASKI result limit.');
  }
  const category = options.tur === undefined ? undefined : sourceType(options.tur);
  const all = fullSet(await fetchCategories(options, category));
  const q = normalizeName(options.q);
  const ilce = normalizeName(options.ilce);
  const mahalle = normalizeName(options.mahalle);
  const filtered = all.filter((item) => {
    const p = item.properties;
    return (!ilce || normalizeName(p.ilce) === ilce)
      && (!mahalle || normalizeName(p.mahalle) === mahalle)
      && (!q || [p.adi, p.adres, p.ilce, p.mahalle].some((field) => normalizeName(field).includes(q)));
  }).sort((left, right) =>
    (left.properties.objectid as number) - (right.properties.objectid as number));

  return {
    type: 'FeatureCollection',
    features: filtered.slice(0, limit),
    meta: { count: Math.min(filtered.length, limit), limit, hasMore: filtered.length > limit },
  };
};

export const fetchPlanAskiFeatureDirect = async (
  objectId: number,
  options: KentRehberiFetchOptions = {},
): Promise<KentRehberiGeoJsonFeature | null> => {
  const id = requiredInteger(objectId, 1, 2147483647);
  const features = fullSet(await fetchCategories(options));
  return features.find((item) => item.properties.objectid === id) ?? null;
};

export const fetchPlanAskiTypeCatalogDirect = async (
  options: KentRehberiFetchOptions = {},
): Promise<KentRehberiTypeCatalog> => {
  const groups = await fetchCategories(options);
  const types: KentRehberiTypeDescriptor[] = groups.map((features, tur) => ({
    tur,
    count: features.length,
    samples: features.slice(0, 8).map((feature) => ({
      objectid: feature.properties.objectid as number,
      adi: (feature.properties.adi as string | null)?.slice(0, 240) ?? null,
      adres: (feature.properties.adres as string | null)?.slice(0, 240) ?? null,
      durakNo: (feature.properties.durakNo as string | null)?.slice(0, 240) ?? null,
    })),
  }));
  return { types };
};

// Explicit mode switch: production's existing API transport remains intact.
export const isDirectPlanAskiSource = (): boolean =>
  String(import.meta.env.VITE_KENT_REHBERI_SOURCE ?? '').toLowerCase() === 'planaski';
