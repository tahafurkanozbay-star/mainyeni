import type {
  GeocodeCandidate,
  GeocodeDiagnostics,
  GeocodePage,
  PageInfo,
  UnknownRecord,
} from './contracts';
import { isRecord } from './contracts';
import {
  createPageInfo,
  hashFingerprint,
  normalizeCoordinates,
  normalizeId,
  normalizeInteger,
  normalizeSearchText,
  normalizeText,
} from './normalization';

export interface GeocodeAdapterOptions {
  readonly offset?: number | string | null | undefined;
  readonly limit?: number | string | null | undefined;
  readonly defaultLimit?: number | undefined;
  readonly dedupe?: boolean | undefined;
  readonly minimumScore?: number | undefined;
}

interface RawCandidate {
  readonly source: unknown;
  readonly sourceIndex: number;
  readonly sourceKind: GeocodeCandidate['sourceKind'];
  readonly label: unknown;
  readonly id: unknown;
  readonly score: unknown;
  readonly coordinates: unknown;
  readonly attributes: UnknownRecord;
}

const hasOwn = (value: UnknownRecord, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

const firstValue = (record: UnknownRecord, keys: readonly string[]): unknown => {
  for (const key of keys) {
    if (!hasOwn(record, key)) continue;
    const value = record[key];
    if (value !== null && value !== undefined && value !== '') return value;
  }
  return null;
};

const numberOr = (value: unknown, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const normalizeScore = (value: unknown): number => {
  const parsed = numberOr(value, 0);
  if (parsed <= 0) return 0;
  return Math.min(100, Math.max(0, parsed));
};

const objectAttributes = (value: unknown): UnknownRecord =>
  isRecord(value) ? { ...value } : {};

const candidateLabel = (record: UnknownRecord): unknown => firstValue(record, [
  'address',
  'Address',
  'label',
  'Label',
  'name',
  'Name',
  'title',
  'Title',
  'LongLabel',
  'Match_addr',
  'ShortLabel',
  'ADI',
  'ADRES',
]);

const candidateId = (record: UnknownRecord): unknown => firstValue(record, [
  'id',
  'ID',
  'objectid',
  'OBJECTID',
  'ResultID',
  'Place_addr',
  'globalid',
  'GLOBALID',
]);

const geometryCoordinates = (geometry: unknown): unknown => {
  if (!isRecord(geometry)) return null;
  if (geometry.x !== undefined || geometry.y !== undefined) {
    return { x: geometry.x, y: geometry.y };
  }
  if (geometry.longitude !== undefined || geometry.latitude !== undefined) {
    return { longitude: geometry.longitude, latitude: geometry.latitude };
  }
  return null;
};

const rawFromArcGisCandidate = (value: unknown, sourceIndex: number): RawCandidate | null => {
  if (!isRecord(value)) return null;
  const attributes = objectAttributes(value.attributes);
  const location = value.location ?? value.geometry ?? geometryCoordinates(value);
  return {
    source: value,
    sourceIndex,
    sourceKind: 'arcgis-candidate',
    label: candidateLabel(value) ?? candidateLabel(attributes),
    id: candidateId(value) ?? candidateId(attributes),
    score: value.score ?? value.Score ?? attributes.Score ?? attributes.score,
    coordinates: location,
    attributes: { ...attributes },
  };
};

const rawFromArcGisFeature = (value: unknown, sourceIndex: number): RawCandidate | null => {
  if (!isRecord(value)) return null;
  const attributes = objectAttributes(value.attributes ?? value.attr ?? value.properties);
  const geometry = value.geometry ?? value.location;
  return {
    source: value,
    sourceIndex,
    sourceKind: 'arcgis-feature',
    label: candidateLabel(attributes) ?? candidateLabel(value),
    id: candidateId(attributes) ?? candidateId(value),
    score: attributes.Score ?? attributes.score ?? value.score ?? 0,
    coordinates: geometry,
    attributes,
  };
};

const rawFromReverseGeocode = (value: unknown, sourceIndex: number): RawCandidate | null => {
  if (!isRecord(value)) return null;
  const address = objectAttributes(value.address);
  const attributes = { ...address, ...objectAttributes(value.attributes) };
  return {
    source: value,
    sourceIndex,
    sourceKind: 'reverse-geocode',
    label: firstValue(address, [
      'LongLabel',
      'Match_addr',
      'Address',
      'ShortLabel',
      'Street',
    ]) ?? candidateLabel(value),
    id: candidateId(address) ?? candidateId(value),
    score: value.score ?? address.Score ?? 100,
    coordinates: value.location ?? value.geometry,
    attributes,
  };
};

const rawFromGenericRow = (value: unknown, sourceIndex: number): RawCandidate | null => {
  if (!isRecord(value)) return null;
  const attributes = objectAttributes(value.attributes ?? value.attr ?? value.properties ?? value.fields);
  const merged = { ...value, ...attributes };
  return {
    source: value,
    sourceIndex,
    sourceKind: 'generic-row',
    label: candidateLabel(merged),
    id: candidateId(merged),
    score: merged.score ?? merged.Score ?? merged.rank ?? merged.confidence ?? 0,
    coordinates: value.location ?? value.geometry ?? {
      latitude: merged.latitude ?? merged.lat ?? merged.y ?? merged.Y,
      longitude: merged.longitude ?? merged.lon ?? merged.lng ?? merged.x ?? merged.X,
    },
    attributes: merged,
  };
};

const determineInputKind = (payload: unknown): string => {
  if (Array.isArray(payload)) return 'array';
  if (!isRecord(payload)) return 'invalid';
  if (Array.isArray(payload.candidates)) return 'arcgis-candidates';
  if (Array.isArray(payload.features)) return 'arcgis-features';
  if (Array.isArray(payload.locations)) return 'locations';
  if (Array.isArray(payload.results)) return 'results';
  if (isRecord(payload.address) && (payload.location || payload.geometry)) return 'reverse-geocode';
  if (isRecord(payload.result)) return 'wrapped-result';
  return 'single-row';
};

const collectRawCandidates = (payload: unknown): RawCandidate[] => {
  const kind = determineInputKind(payload);
  if (kind === 'invalid') return [];
  if (kind === 'array') {
    return (payload as unknown[])
      .map((value, index) => rawFromGenericRow(value, index))
      .filter((value): value is RawCandidate => value !== null);
  }
  if (!isRecord(payload)) return [];
  if (kind === 'arcgis-candidates') {
    return (payload.candidates as unknown[])
      .map((value, index) => rawFromArcGisCandidate(value, index))
      .filter((value): value is RawCandidate => value !== null);
  }
  if (kind === 'arcgis-features') {
    return (payload.features as unknown[])
      .map((value, index) => rawFromArcGisFeature(value, index))
      .filter((value): value is RawCandidate => value !== null);
  }
  if (kind === 'locations') {
    return (payload.locations as unknown[])
      .map((value, index) => rawFromArcGisCandidate(value, index) ?? rawFromGenericRow(value, index))
      .filter((value): value is RawCandidate => value !== null);
  }
  if (kind === 'results') {
    return (payload.results as unknown[])
      .map((value, index) => rawFromArcGisCandidate(value, index) ?? rawFromGenericRow(value, index))
      .filter((value): value is RawCandidate => value !== null);
  }
  if (kind === 'reverse-geocode') {
    const value = rawFromReverseGeocode(payload, 0);
    return value ? [value] : [];
  }
  if (kind === 'wrapped-result') {
    return collectRawCandidates(payload.result);
  }
  const value = rawFromGenericRow(payload, 0);
  return value ? [value] : [];
};

const normalizeRawCandidate = (raw: RawCandidate): GeocodeCandidate => {
  const label = normalizeText(raw.label);
  const id = normalizeId(raw.id);
  const coordinates = normalizeCoordinates(raw.coordinates);
  const score = normalizeScore(raw.score);
  const fingerprint = hashFingerprint({
    id,
    label: normalizeSearchText(label),
    coordinates,
    sourceKind: raw.sourceKind,
  });
  return Object.freeze({
    id,
    label,
    score,
    coordinates,
    attributes: Object.freeze({ ...raw.attributes }),
    sourceKind: raw.sourceKind,
    sourceIndex: raw.sourceIndex,
    fingerprint,
  });
};

const transferLimitFromPayload = (payload: unknown): boolean => {
  if (!isRecord(payload)) return false;
  return payload.exceededTransferLimit === true
    || payload.hasMore === true
    || payload.moreResults === true;
};

const totalFromPayload = (payload: unknown, fallback: number): number => {
  if (!isRecord(payload)) return fallback;
  const candidates = [payload.total, payload.totalCount, payload.count, payload.resultCount];
  for (const value of candidates) {
    const parsed = Number(value);
    if (Number.isInteger(parsed) && parsed >= fallback) return parsed;
  }
  return fallback;
};

export const adaptGeocodingPayload = (
  payload: unknown,
  options: GeocodeAdapterOptions = {},
): GeocodePage => {
  const raw = collectRawCandidates(payload);
  const dedupe = options.dedupe !== false;
  const minimumScore = Number.isFinite(Number(options.minimumScore))
    ? Math.max(0, Math.min(100, Number(options.minimumScore)))
    : 0;
  const seen = new Set<string>();
  const normalized: GeocodeCandidate[] = [];
  let duplicateCount = 0;
  let invalidCoordinateCount = 0;
  let malformedCount = 0;

  for (const item of raw) {
    const candidate = normalizeRawCandidate(item);
    if (!candidate.label && candidate.id === null) malformedCount += 1;
    if (item.coordinates && !candidate.coordinates) invalidCoordinateCount += 1;
    if (candidate.score < minimumScore) continue;
    if (dedupe && seen.has(candidate.fingerprint)) {
      duplicateCount += 1;
      continue;
    }
    seen.add(candidate.fingerprint);
    normalized.push(candidate);
  }

  normalized.sort((left, right) => right.score - left.score
    || left.label.localeCompare(right.label, 'tr-TR', { sensitivity: 'base', numeric: true })
    || left.sourceIndex - right.sourceIndex);

  const defaultLimit = normalizeInteger(options.defaultLimit, { min: 1, max: 1000, fallback: 50 });
  const offset = normalizeInteger(options.offset, { min: 0, fallback: 0 });
  const limit = normalizeInteger(options.limit, { min: 1, max: 1000, fallback: defaultLimit });
  const total = totalFromPayload(payload, normalized.length);
  const candidates = normalized.slice(offset, offset + limit);
  const exceededTransferLimit = transferLimitFromPayload(payload);
  const basePage = createPageInfo(offset, limit, candidates.length, Math.max(total, normalized.length), defaultLimit);
  const nextOffset = offset + candidates.length;
  const serviceHasMore = exceededTransferLimit && candidates.length > 0;
  const hasMore = basePage.hasMore || serviceHasMore;
  const page: PageInfo = Object.freeze({
    ...basePage,
    hasMore,
    nextOffset: hasMore && candidates.length > 0 ? nextOffset : null,
  });
  const diagnostics: GeocodeDiagnostics = Object.freeze({
    inputKind: determineInputKind(payload),
    inputCount: raw.length,
    outputCount: normalized.length,
    duplicateCount,
    invalidCoordinateCount,
    malformedCount,
  });
  return Object.freeze({
    candidates: Object.freeze(candidates),
    page,
    exceededTransferLimit,
    diagnostics,
  });
};

export const mergeGeocodePages = (
  pages: readonly GeocodePage[],
  options: Pick<GeocodeAdapterOptions, 'dedupe'> = {},
): readonly GeocodeCandidate[] => {
  const dedupe = options.dedupe !== false;
  const seen = new Set<string>();
  const merged: GeocodeCandidate[] = [];
  for (const page of pages) {
    for (const candidate of page.candidates) {
      if (dedupe && seen.has(candidate.fingerprint)) continue;
      seen.add(candidate.fingerprint);
      merged.push(candidate);
    }
  }
  return Object.freeze(merged);
};

export const geocodeCandidateToRecordSource = (
  candidate: GeocodeCandidate,
): Readonly<Record<string, unknown>> => Object.freeze({
  ...candidate.attributes,
  id: candidate.id,
  title: candidate.label,
  address: candidate.label,
  latitude: candidate.coordinates?.latitude ?? null,
  longitude: candidate.coordinates?.longitude ?? null,
  score: candidate.score,
});

export const isProjectedCoordinateCandidate = (value: unknown): boolean => {
  if (!isRecord(value)) return false;
  const geometry = isRecord(value.geometry)
    ? value.geometry
    : isRecord(value.location)
      ? value.location
      : value;
  const x = Number(geometry.x);
  const y = Number(geometry.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  return Math.abs(x) > 180 || Math.abs(y) > 90;
};

export const geocodingPayloadDiagnostics = (
  payload: unknown,
): Readonly<Record<string, unknown>> => {
  const raw = collectRawCandidates(payload);
  let projectedCoordinateCount = 0;
  let coordinateCount = 0;
  let labelledCount = 0;
  for (const item of raw) {
    if (normalizeText(item.label)) labelledCount += 1;
    if (item.coordinates) coordinateCount += 1;
    if (isProjectedCoordinateCandidate(item.coordinates)) projectedCoordinateCount += 1;
  }
  return Object.freeze({
    inputKind: determineInputKind(payload),
    rawCount: raw.length,
    labelledCount,
    coordinateCount,
    projectedCoordinateCount,
    note: projectedCoordinateCount > 0
      ? 'Projected coordinates are detected but never guessed/reprojected without an explicit verified spatial reference adapter.'
      : '',
  });
};