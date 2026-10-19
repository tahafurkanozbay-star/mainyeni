export interface KentRehberiPoiSearchInput {
  readonly id: unknown;
  readonly name: unknown;
  readonly address?: unknown;
  readonly district?: unknown;
  readonly neighborhood?: unknown;
  readonly longitude: unknown;
  readonly latitude: unknown;
  readonly iconKey?: unknown;
}

export interface KentRehberiPoiSearchPoint {
  readonly id: number;
  readonly name: string;
  readonly normalizedName: string;
  readonly address: string;
  readonly district: string;
  readonly neighborhood: string;
  readonly longitude: number;
  readonly latitude: number;
  readonly iconKey: string;
}

export interface KentRehberiPoiSearchSnapshot {
  readonly phase: 'idle' | 'ready';
  readonly points: readonly KentRehberiPoiSearchPoint[];
  readonly revision: number;
}

export interface KentRehberiPoiSearchResults {
  readonly items: readonly KentRehberiPoiSearchPoint[];
  readonly totalCount: number;
  readonly truncated: boolean;
}

const EMPTY_POINTS: readonly KentRehberiPoiSearchPoint[] = Object.freeze([]);
const createSnapshot = (
  phase: KentRehberiPoiSearchSnapshot['phase'],
  points: readonly KentRehberiPoiSearchPoint[],
  revision: number,
): KentRehberiPoiSearchSnapshot => Object.freeze({ phase, points, revision });

let snapshot = createSnapshot('idle', EMPTY_POINTS, 0);
let activeOwner: symbol | null = null;
const listeners = new Set<() => void>();

const notify = (): void => {
  for (const listener of Array.from(listeners)) {
    try {
      listener();
    } catch {
      // One consumer must not prevent the other subscribers from updating.
    }
  }
};

const cleanText = (value: unknown): string => typeof value === 'string'
  ? value.replace(/[\t\r\n]+/gu, ' ').replace(/\s{2,}/gu, ' ').trim()
  : '';

export const normalizeKentRehberiPoiSearchText = (value: unknown): string => {
  if (typeof value !== 'string') return '';
  return value
    .normalize('NFKD')
    .toLocaleLowerCase('tr-TR')
    .replace(/[\u0300-\u036f]/gu, '')
    .replace(/ı/gu, 'i')
    .replace(/[^a-z0-9çğıöşü\s-]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
};

export const subscribeKentRehberiPoiSearchIndex = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const getKentRehberiPoiSearchSnapshot = (): KentRehberiPoiSearchSnapshot => snapshot;

/**
 * Publishes a compact index of point names and coordinates from the existing
 * startup sweep. Searches then stay local and do not issue a request per key.
 */
export const publishKentRehberiPoiSearchIndex = (
  records: readonly KentRehberiPoiSearchInput[],
): (() => void) => {
  const points = records.flatMap((record): KentRehberiPoiSearchPoint[] => {
    const id = Number(record.id);
    const name = cleanText(record.name) || cleanText(record.address);
    const longitude = Number(record.longitude);
    const latitude = Number(record.latitude);
    if (!Number.isSafeInteger(id) || id <= 0 || !name
      || !Number.isFinite(longitude) || !Number.isFinite(latitude)
      || Math.abs(longitude) > 180 || Math.abs(latitude) > 90) return [];

    return [Object.freeze({
      id,
      name,
      normalizedName: normalizeKentRehberiPoiSearchText(name),
      address: cleanText(record.address),
      district: cleanText(record.district),
      neighborhood: cleanText(record.neighborhood),
      longitude,
      latitude,
      iconKey: cleanText(record.iconKey),
    })];
  }).sort((left, right) => left.id - right.id);

  const owner = Symbol('kent-rehberi-poi-search-index');
  activeOwner = owner;
  snapshot = createSnapshot('ready', Object.freeze(points), snapshot.revision + 1);
  notify();

  return () => {
    // An older map instance must not clear a newer instance's search index.
    if (activeOwner !== owner) return;
    activeOwner = null;
    snapshot = createSnapshot('idle', EMPTY_POINTS, snapshot.revision + 1);
    notify();
  };
};

export const searchKentRehberiPoiPoints = (
  source: KentRehberiPoiSearchSnapshot,
  queryInput: unknown,
  limit = 100,
): KentRehberiPoiSearchResults => {
  const query = normalizeKentRehberiPoiSearchText(queryInput);
  if (!query || source.phase !== 'ready') {
    return Object.freeze({ items: EMPTY_POINTS, totalCount: 0, truncated: false });
  }

  const tokens = query.split(' ').filter(Boolean);
  const matched = source.points.filter((point) =>
    tokens.every((token) => point.normalizedName.includes(token)));
  matched.sort((left, right) => {
    const leftExact = left.normalizedName === query ? 0 : 1;
    const rightExact = right.normalizedName === query ? 0 : 1;
    if (leftExact !== rightExact) return leftExact - rightExact;
    const leftPrefix = left.normalizedName.startsWith(query) ? 0 : 1;
    const rightPrefix = right.normalizedName.startsWith(query) ? 0 : 1;
    if (leftPrefix !== rightPrefix) return leftPrefix - rightPrefix;
    const leftPosition = left.normalizedName.indexOf(query);
    const rightPosition = right.normalizedName.indexOf(query);
    if (leftPosition !== rightPosition) return leftPosition - rightPosition;
    return left.name.localeCompare(right.name, 'tr-TR', { sensitivity: 'base', numeric: true });
  });

  const safeLimit = Number.isInteger(limit) ? Math.max(1, Math.min(500, limit)) : 100;
  const items = Object.freeze(matched.slice(0, safeLimit));
  return Object.freeze({ items, totalCount: matched.length, truncated: matched.length > items.length });
};
