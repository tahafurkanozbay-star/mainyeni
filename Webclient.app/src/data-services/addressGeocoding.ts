const GEOCODER_URL = 'https://nominatim.openstreetmap.org/search';
const REQUEST_INTERVAL_MS = 1_200;
const REQUEST_TIMEOUT_MS = 12_000;
const MAX_QUERY_LENGTH = 180;
const MAX_RESPONSE_BYTES = 256 * 1024;
const CACHE_TTL_MS = 2 * 60_000;
const MAX_CACHE_ENTRIES = 40;
const ANKARA_VIEWBOX = '31.0,40.8,34.3,38.8';

interface NominatimRecord {
  readonly lat?: unknown;
  readonly lon?: unknown;
  readonly display_name?: unknown;
  readonly type?: unknown;
  readonly addresstype?: unknown;
}

export interface AddressGeocodingResult {
  readonly displayName: string;
  readonly latitude: number;
  readonly longitude: number;
  readonly zoom: number;
  readonly attribution: '© OpenStreetMap katkıcıları';
  readonly attributionUrl: 'https://www.openstreetmap.org/copyright';
}

export interface AddressGeocodingOptions {
  readonly signal?: AbortSignal;
  readonly fetchImpl?: typeof fetch;
}

interface CachedResult {
  readonly expiresAt: number;
  readonly value: readonly AddressGeocodingResult[];
}

const resultCache = new Map<string, CachedResult>();
let nextRequestAt = 0;
let requestQueue: Promise<void> = Promise.resolve();

const throwIfAborted = (signal?: AbortSignal): void => {
  if (signal?.aborted) {
    throw signal.reason ?? new DOMException('Adres araması iptal edildi.', 'AbortError');
  }
};

const normalizeQuery = (input: unknown): string => {
  if (typeof input !== 'string') throw new TypeError('Adres araması metin olmalıdır.');
  const query = input.replace(/\s+/gu, ' ').trim();
  if (!query || query.length > MAX_QUERY_LENGTH || /\p{Cc}/u.test(query)) {
    throw new TypeError('Bir adres veya yer adı yazın (en fazla 180 karakter).');
  }
  if (query.length < 2) throw new TypeError('Arama için en az iki karakter yazın.');
  return query;
};

const abortableDelay = (milliseconds: number, signal?: AbortSignal): Promise<void> => {
  if (milliseconds <= 0) {
    throwIfAborted(signal);
    return Promise.resolve();
  }
  return new Promise<void>((resolve, reject) => {
    throwIfAborted(signal);
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    const onAbort = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(signal?.reason ?? new DOMException('Adres araması iptal edildi.', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
};

/** Keep user-submitted searches at or below the public service's one-request-per-second policy. */
const reserveRequestSlot = (signal?: AbortSignal): Promise<void> => {
  const slot = requestQueue.then(async () => {
    throwIfAborted(signal);
    await abortableDelay(Math.max(0, nextRequestAt - Date.now()), signal);
    throwIfAborted(signal);
    nextRequestAt = Date.now() + REQUEST_INTERVAL_MS;
  });
  requestQueue = slot.catch(() => undefined);
  return slot;
};

const normalizeDisplayName = (value: unknown): string => {
  if (typeof value !== 'string') return '';
  return value.replace(/\p{Cc}/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, 320);
};

const toCoordinate = (value: unknown, minimum: number, maximum: number): number | null => {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  if (typeof value === 'string' && !value.trim()) return null;
  const coordinate = Number(value);
  if (!Number.isFinite(coordinate) || coordinate < minimum || coordinate > maximum) return null;
  return coordinate;
};

const zoomForRecord = (record: NominatimRecord): number => {
  const addressType = String(record.addresstype ?? '').toLocaleLowerCase('tr-TR');
  const type = String(record.type ?? '').toLocaleLowerCase('tr-TR');
  if (['house', 'building', 'entrance', 'address'].includes(addressType)) return 18;
  if (['road', 'residential', 'street', 'pedestrian', 'living_street'].includes(addressType)) return 17;
  if (['neighbourhood', 'suburb', 'quarter', 'city_district'].includes(addressType)) return 15;
  if (['city', 'town', 'village', 'municipality', 'county'].includes(addressType)) return 12;
  if (type === 'house' || type === 'building') return 18;
  return 16;
};

const normalizeRecord = (value: unknown): AddressGeocodingResult | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as NominatimRecord;
  const displayName = normalizeDisplayName(record.display_name);
  const latitude = toCoordinate(record.lat, -90, 90);
  const longitude = toCoordinate(record.lon, -180, 180);
  if (!displayName || latitude === null || longitude === null) return null;
  return Object.freeze({
    displayName,
    latitude,
    longitude,
    zoom: zoomForRecord(record),
    attribution: '© OpenStreetMap katkıcıları',
    attributionUrl: 'https://www.openstreetmap.org/copyright',
  });
};

const readBoundedJson = async (response: Response, signal: AbortSignal): Promise<unknown> => {
  throwIfAborted(signal);
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
  if (!/^application\/json(?:\s*;|$)/u.test(contentType)) {
    throw new TypeError('Adres arama servisi beklenmeyen bir yanıt döndürdü.');
  }
  const statedLength = response.headers.get('content-length');
  if (statedLength !== null) {
    if (!/^\d+$/u.test(statedLength.trim()) || Number(statedLength) > MAX_RESPONSE_BYTES) {
      throw new RangeError('Adres arama yanıtı izin verilen boyutu aştı.');
    }
  }
  const body = await response.text();
  throwIfAborted(signal);
  if (new TextEncoder().encode(body).byteLength > MAX_RESPONSE_BYTES) {
    throw new RangeError('Adres arama yanıtı izin verilen boyutu aştı.');
  }
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new TypeError('Adres arama servisi geçerli JSON döndürmedi.');
  }
};

interface InFlightAddressRequest {
  readonly controller: AbortController;
  promise: Promise<readonly AddressGeocodingResult[]>;
  consumers: number;
  settled: boolean;
}

const inFlightAddressRequests = new WeakMap<
  typeof fetch,
  Map<string, InFlightAddressRequest>
>();

const removeInFlightAddressRequest = (
  fetchImpl: typeof fetch,
  cacheKey: string,
  entry: InFlightAddressRequest,
): void => {
  const requests = inFlightAddressRequests.get(fetchImpl);
  if (requests?.get(cacheKey) !== entry) return;
  requests.delete(cacheKey);
  if (requests.size === 0) inFlightAddressRequests.delete(fetchImpl);
};

const loadAddressCandidates = async (
  query: string,
  fetchImpl: typeof fetch,
  controller: AbortController,
): Promise<readonly AddressGeocodingResult[]> => {
  const signal = controller.signal;
  await reserveRequestSlot(signal);
  throwIfAborted(signal);

  const url = new URL(GEOCODER_URL);
  url.searchParams.set('q', query);
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('addressdetails', '1');
  url.searchParams.set('limit', '5');
  url.searchParams.set('countrycodes', 'tr');
  url.searchParams.set('accept-language', 'tr');
  url.searchParams.set('viewbox', ANKARA_VIEWBOX);
  url.searchParams.set('bounded', '1');

  const timeout = setTimeout(() => {
    if (!signal.aborted) {
      controller.abort(new DOMException('Adres arama zaman aşımına uğradı.', 'TimeoutError'));
    }
  }, REQUEST_TIMEOUT_MS);

  try {
    const response = await fetchImpl(url.toString(), {
      method: 'GET',
      mode: 'cors',
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'error',
      referrerPolicy: 'strict-origin-when-cross-origin',
      headers: { Accept: 'application/json' },
      signal,
    });
    if (!response.ok) throw new Error('Adres arama hizmetine ulaşılamadı.');
    const parsed = await readBoundedJson(response, signal);
    if (!Array.isArray(parsed)) throw new TypeError('Adres arama servisi geçersiz sonuçlar döndürdü.');

    const seen = new Set<string>();
    const candidates: AddressGeocodingResult[] = [];
    for (const item of parsed.slice(0, 5)) {
      const candidate = normalizeRecord(item);
      if (!candidate) continue;
      const fingerprint = String(candidate.latitude.toFixed(5)) + ','
        + String(candidate.longitude.toFixed(5)) + ':'
        + candidate.displayName.toLocaleLowerCase('tr-TR');
      if (seen.has(fingerprint)) continue;
      seen.add(fingerprint);
      candidates.push(candidate);
    }
    if (candidates.length === 0) {
      throw new Error('Adres bulunamadı. Daha açık bir adres veya mahalle adı deneyin.');
    }

    const frozenCandidates = Object.freeze(candidates.slice());
    resultCache.set(query.toLocaleLowerCase('tr-TR'), {
      expiresAt: Date.now() + CACHE_TTL_MS,
      value: frozenCandidates,
    });
    while (resultCache.size > MAX_CACHE_ENTRIES) {
      const oldest = resultCache.keys().next().value;
      if (oldest === undefined) break;
      resultCache.delete(oldest);
    }
    return frozenCandidates;
  } catch (error) {
    if (signal.aborted && signal.reason instanceof DOMException
      && signal.reason.name === 'TimeoutError') {
      throw new Error('Adres araması zaman aşımına uğradı. Yeniden deneyin.');
    }
    if (signal.aborted) throw signal.reason ?? error;
    throw error;
  } finally {
    clearTimeout(timeout);
  }
};

const consumeInFlightAddressRequest = (
  entry: InFlightAddressRequest,
  fetchImpl: typeof fetch,
  cacheKey: string,
  signal?: AbortSignal,
): Promise<readonly AddressGeocodingResult[]> => {
  throwIfAborted(signal);
  entry.consumers += 1;

  return new Promise<readonly AddressGeocodingResult[]>((resolve, reject) => {
    let finished = false;
    const cleanup = (): void => signal?.removeEventListener('abort', onAbort);
    const release = (): void => {
      entry.consumers = Math.max(0, entry.consumers - 1);
      if (entry.consumers !== 0 || entry.settled) return;

      // A new caller can retry immediately instead of joining an abandoned request.
      removeInFlightAddressRequest(fetchImpl, cacheKey, entry);
      entry.controller.abort(new DOMException(
        'No active address-search consumers remain.',
        'AbortError',
      ));
    };
    const finish = (complete: () => void): void => {
      if (finished) return;
      finished = true;
      cleanup();
      release();
      complete();
    };
    const onAbort = (): void => finish(() => {
      reject(signal?.reason ?? new DOMException('Adres araması iptal edildi.', 'AbortError'));
    });

    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }

    entry.promise.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
};

export const searchAddressCandidates = async (
  rawQuery: string,
  options: AddressGeocodingOptions = {},
): Promise<readonly AddressGeocodingResult[]> => {
  const query = normalizeQuery(rawQuery);
  const cacheKey = query.toLocaleLowerCase('tr-TR');
  throwIfAborted(options.signal);

  const cached = resultCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    resultCache.delete(cacheKey);
    resultCache.set(cacheKey, cached);
    return cached.value;
  }
  if (cached) resultCache.delete(cacheKey);

  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('Tarayıcı ağ isteği desteklenmiyor.');

  let requests = inFlightAddressRequests.get(fetchImpl);
  if (!requests) {
    requests = new Map<string, InFlightAddressRequest>();
    inFlightAddressRequests.set(fetchImpl, requests);
  }

  let entry = requests.get(cacheKey);
  if (!entry) {
    const controller = new AbortController();
    entry = {
      controller,
      promise: Promise.resolve([]),
      consumers: 0,
      settled: false,
    };
    requests.set(cacheKey, entry);
    const currentEntry = entry;
    currentEntry.promise = loadAddressCandidates(query, fetchImpl, controller);
    const settle = (): void => {
      currentEntry.settled = true;
      removeInFlightAddressRequest(fetchImpl, cacheKey, currentEntry);
    };
    void currentEntry.promise.then(settle, settle);
  }

  return consumeInFlightAddressRequest(entry, fetchImpl, cacheKey, options.signal);
};

/** Backward-compatible convenience API for callers that only need the best match. */
export const geocodeAddress = async (
  rawQuery: string,
  options: AddressGeocodingOptions = {},
): Promise<AddressGeocodingResult> => {
  const candidates = await searchAddressCandidates(rawQuery, options);
  const candidate = candidates[0];
  if (!candidate) throw new Error('Adres bulunamadı. Daha açık bir adres veya mahalle adı deneyin.');
  return candidate;
};

export const ADDRESS_GEOCODING_POLICY = Object.freeze({
  provider: 'OpenStreetMap Nominatim',
  requestIntervalMs: REQUEST_INTERVAL_MS,
  maxQueryLength: MAX_QUERY_LENGTH,
  cacheTtlMs: CACHE_TTL_MS,
  attributionUrl: 'https://www.openstreetmap.org/copyright',
});
