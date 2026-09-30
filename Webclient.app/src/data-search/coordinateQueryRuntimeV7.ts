import type { Coordinate } from './contracts';
import {
  hashFingerprint,
  normalizeInteger,
  normalizeText,
  stableSerialize,
} from './normalization';

export type CoordinateQueryKindV7 =
  | 'none'
  | 'labeled'
  | 'wkt-point'
  | 'directional-pair'
  | 'decimal-pair';

export type CoordinateQueryConfidenceV7 = 'none' | 'weak' | 'strong';
export type CoordinateQueryOrderV7 = 'lat-lon' | 'lon-lat';
export type AmbiguousCoordinateOrderPolicyV7 = 'lat-lon' | 'lon-lat' | 'reject';

export interface CoordinateQueryPolicyV7 {
  readonly maximumInputLength?: number;
  readonly ambiguousOrder?: AmbiguousCoordinateOrderPolicyV7;
  readonly allowUnlabeledIntegerPairs?: boolean;
}

export interface CoordinateQueryDiagnosticsV7 {
  readonly inputLength: number;
  readonly boundedLength: number;
  readonly truncated: boolean;
  readonly matched: boolean;
  readonly ambiguousOrder: boolean;
  readonly explicitOrder: boolean;
  readonly matchedLength: number;
  readonly rejectedReason: string | null;
}

export interface CoordinateQueryAnalysisV7 {
  readonly version: 'coordinate-query-v7';
  readonly kind: CoordinateQueryKindV7;
  readonly confidence: CoordinateQueryConfidenceV7;
  readonly order: CoordinateQueryOrderV7 | null;
  readonly coordinates: Coordinate | null;
  readonly residualQuery: string;
  readonly signature: string;
  readonly diagnostics: CoordinateQueryDiagnosticsV7;
}

interface NormalizedCoordinateQueryPolicyV7 {
  readonly maximumInputLength: number;
  readonly ambiguousOrder: AmbiguousCoordinateOrderPolicyV7;
  readonly allowUnlabeledIntegerPairs: boolean;
}

interface CoordinateMatchV7 {
  readonly kind: Exclude<CoordinateQueryKindV7, 'none'>;
  readonly first: number;
  readonly second: number;
  readonly order: CoordinateQueryOrderV7 | null;
  readonly explicitOrder: boolean;
  readonly start: number;
  readonly end: number;
  readonly raw: string;
}

interface ResolvedCoordinateV7 {
  readonly coordinates: Coordinate | null;
  readonly order: CoordinateQueryOrderV7 | null;
  readonly ambiguous: boolean;
  readonly rejectedReason: string | null;
}

const VERSION = 'coordinate-query-v7' as const;
const DEFAULT_MAXIMUM_INPUT_LENGTH = 512;

const NUMBER_SOURCE = '[-+]?\\d{1,3}(?:\\.\\d+)?';
const DECIMAL_SOURCE = '[-+]?\\d{1,3}\\.\\d+';

const WKT_POINT = new RegExp(`\\bPOINT\\s*\\(\\s*(${NUMBER_SOURCE})\\s+(${NUMBER_SOURCE})\\s*\\)`, 'i');
const LATITUDE_LABEL = new RegExp(`\\b(?:lat|latitude|enlem)\\b\\s*[:=]?\\s*(${NUMBER_SOURCE})`, 'i');
const LONGITUDE_LABEL = new RegExp(`\\b(?:lon|lng|longitude|boylam)\\b\\s*[:=]?\\s*(${NUMBER_SOURCE})`, 'i');
const DIRECTIONAL_PAIR = new RegExp(`(${NUMBER_SOURCE})\\s*([NSEW])\\s*[,; ]+\\s*(${NUMBER_SOURCE})\\s*([NSEW])`, 'i');
const DECIMAL_PAIR_WITH_SEPARATOR = new RegExp(`(${NUMBER_SOURCE})\\s*[,;]\\s*(${NUMBER_SOURCE})`);
const DECIMAL_PAIR_WITH_SPACE = new RegExp(`(${DECIMAL_SOURCE})\\s+(${DECIMAL_SOURCE})`);

const normalizePolicy = (
  policy: CoordinateQueryPolicyV7 = {},
): NormalizedCoordinateQueryPolicyV7 => Object.freeze({
  maximumInputLength: normalizeInteger(policy.maximumInputLength, {
    min: 32,
    max: 4096,
    fallback: DEFAULT_MAXIMUM_INPUT_LENGTH,
  }),
  ambiguousOrder: policy.ambiguousOrder === 'lon-lat'
    || policy.ambiguousOrder === 'reject'
    ? policy.ambiguousOrder
    : 'lat-lon',
  allowUnlabeledIntegerPairs: policy.allowUnlabeledIntegerPairs === true,
});

const finite = (value: string | undefined): number | null => {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const validLatitude = (value: number): boolean => Number.isFinite(value)
  && value >= -90
  && value <= 90;

const validLongitude = (value: number): boolean => Number.isFinite(value)
  && value >= -180
  && value <= 180;

const coordinate = (latitude: number, longitude: number): Coordinate | null =>
  validLatitude(latitude) && validLongitude(longitude)
    ? Object.freeze({ latitude, longitude })
    : null;

const span = (left: RegExpExecArray, right: RegExpExecArray): readonly [number, number] => {
  const leftStart = left.index;
  const leftEnd = left.index + left[0].length;
  const rightStart = right.index;
  const rightEnd = right.index + right[0].length;
  return [Math.min(leftStart, rightStart), Math.max(leftEnd, rightEnd)] as const;
};

const labeledMatch = (value: string): CoordinateMatchV7 | null => {
  const latitude = LATITUDE_LABEL.exec(value);
  const longitude = LONGITUDE_LABEL.exec(value);
  if (!latitude || !longitude) return null;
  const latitudeValue = finite(latitude[1]);
  const longitudeValue = finite(longitude[1]);
  if (latitudeValue === null || longitudeValue === null) return null;
  const [start, end] = span(latitude, longitude);
  return Object.freeze({
    kind: 'labeled',
    first: latitudeValue,
    second: longitudeValue,
    order: 'lat-lon',
    explicitOrder: true,
    start,
    end,
    raw: value.slice(start, end),
  });
};

const wktMatch = (value: string): CoordinateMatchV7 | null => {
  const match = WKT_POINT.exec(value);
  if (!match) return null;
  const longitude = finite(match[1]);
  const latitude = finite(match[2]);
  if (longitude === null || latitude === null) return null;
  return Object.freeze({
    kind: 'wkt-point',
    first: longitude,
    second: latitude,
    order: 'lon-lat',
    explicitOrder: true,
    start: match.index,
    end: match.index + match[0].length,
    raw: match[0],
  });
};

const directionalValue = (value: number, direction: string): number => {
  const absolute = Math.abs(value);
  return direction.toUpperCase() === 'S' || direction.toUpperCase() === 'W'
    ? -absolute
    : absolute;
};

const directionalMatch = (value: string): CoordinateMatchV7 | null => {
  const match = DIRECTIONAL_PAIR.exec(value);
  if (!match) return null;
  const first = finite(match[1]);
  const second = finite(match[3]);
  const firstDirection = match[2]?.toUpperCase() ?? '';
  const secondDirection = match[4]?.toUpperCase() ?? '';
  if (first === null || second === null) return null;
  const firstLatitude = firstDirection === 'N' || firstDirection === 'S';
  const firstLongitude = firstDirection === 'E' || firstDirection === 'W';
  const secondLatitude = secondDirection === 'N' || secondDirection === 'S';
  const secondLongitude = secondDirection === 'E' || secondDirection === 'W';
  if ((!firstLatitude && !firstLongitude) || (!secondLatitude && !secondLongitude)) return null;
  if (firstLatitude === secondLatitude || firstLongitude === secondLongitude) return null;
  const firstValue = directionalValue(first, firstDirection);
  const secondValue = directionalValue(second, secondDirection);
  return Object.freeze({
    kind: 'directional-pair',
    first: firstValue,
    second: secondValue,
    order: firstLatitude ? 'lat-lon' : 'lon-lat',
    explicitOrder: true,
    start: match.index,
    end: match.index + match[0].length,
    raw: match[0],
  });
};

const containsDecimalEvidence = (raw: string): boolean => /\d\.\d/.test(raw);

const pairMatch = (
  value: string,
  policy: NormalizedCoordinateQueryPolicyV7,
): CoordinateMatchV7 | null => {
  const separated = DECIMAL_PAIR_WITH_SEPARATOR.exec(value);
  const spaced = separated ? null : DECIMAL_PAIR_WITH_SPACE.exec(value);
  const match = separated ?? spaced;
  if (!match) return null;
  if (!policy.allowUnlabeledIntegerPairs && !containsDecimalEvidence(match[0])) return null;
  const first = finite(match[1]);
  const second = finite(match[2]);
  if (first === null || second === null) return null;
  return Object.freeze({
    kind: 'decimal-pair',
    first,
    second,
    order: null,
    explicitOrder: false,
    start: match.index,
    end: match.index + match[0].length,
    raw: match[0],
  });
};

const findMatch = (
  value: string,
  policy: NormalizedCoordinateQueryPolicyV7,
): CoordinateMatchV7 | null => labeledMatch(value)
  ?? wktMatch(value)
  ?? directionalMatch(value)
  ?? pairMatch(value, policy);

const resolveExplicit = (match: CoordinateMatchV7): ResolvedCoordinateV7 => {
  if (match.order === 'lat-lon') {
    const resolved = coordinate(match.first, match.second);
    return Object.freeze({
      coordinates: resolved,
      order: match.order,
      ambiguous: false,
      rejectedReason: resolved ? null : 'coordinate-out-of-range',
    });
  }
  if (match.order === 'lon-lat') {
    const resolved = coordinate(match.second, match.first);
    return Object.freeze({
      coordinates: resolved,
      order: match.order,
      ambiguous: false,
      rejectedReason: resolved ? null : 'coordinate-out-of-range',
    });
  }
  return Object.freeze({
    coordinates: null,
    order: null,
    ambiguous: false,
    rejectedReason: 'missing-coordinate-order',
  });
};

const resolveUnlabeled = (
  match: CoordinateMatchV7,
  policy: NormalizedCoordinateQueryPolicyV7,
): ResolvedCoordinateV7 => {
  const latLonValid = validLatitude(match.first) && validLongitude(match.second);
  const lonLatValid = validLongitude(match.first) && validLatitude(match.second);
  if (!latLonValid && !lonLatValid) {
    return Object.freeze({
      coordinates: null,
      order: null,
      ambiguous: false,
      rejectedReason: 'coordinate-out-of-range',
    });
  }
  if (latLonValid && !lonLatValid) {
    return Object.freeze({
      coordinates: coordinate(match.first, match.second),
      order: 'lat-lon',
      ambiguous: false,
      rejectedReason: null,
    });
  }
  if (!latLonValid && lonLatValid) {
    return Object.freeze({
      coordinates: coordinate(match.second, match.first),
      order: 'lon-lat',
      ambiguous: false,
      rejectedReason: null,
    });
  }
  if (policy.ambiguousOrder === 'reject') {
    return Object.freeze({
      coordinates: null,
      order: null,
      ambiguous: true,
      rejectedReason: 'ambiguous-coordinate-order',
    });
  }
  const order = policy.ambiguousOrder;
  return Object.freeze({
    coordinates: order === 'lat-lon'
      ? coordinate(match.first, match.second)
      : coordinate(match.second, match.first),
    order,
    ambiguous: true,
    rejectedReason: null,
  });
};

const resolveMatch = (
  match: CoordinateMatchV7,
  policy: NormalizedCoordinateQueryPolicyV7,
): ResolvedCoordinateV7 => match.explicitOrder
  ? resolveExplicit(match)
  : resolveUnlabeled(match, policy);

const residualAfterMatch = (value: string, match: CoordinateMatchV7 | null): string => {
  if (!match) return normalizeText(value);
  const left = value.slice(0, match.start);
  const right = value.slice(match.end);
  return normalizeText(`${left} ${right}`
    .replace(/^[\s,;|]+|[\s,;|]+$/g, ' ')
    .replace(/\s+/g, ' '));
};

const noMatch = (
  boundedRaw: string,
  inputLength: number,
  truncated: boolean,
  rejectedReason: string | null = null,
): CoordinateQueryAnalysisV7 => {
  const residualQuery = normalizeText(boundedRaw);
  const diagnostics: CoordinateQueryDiagnosticsV7 = Object.freeze({
    inputLength,
    boundedLength: boundedRaw.length,
    truncated,
    matched: false,
    ambiguousOrder: false,
    explicitOrder: false,
    matchedLength: 0,
    rejectedReason,
  });
  const signature = hashFingerprint(stableSerialize({
    version: VERSION,
    kind: 'none',
    residualQuery,
    diagnostics: {
      truncated,
      rejectedReason,
    },
  }));
  return Object.freeze({
    version: VERSION,
    kind: 'none',
    confidence: 'none',
    order: null,
    coordinates: null,
    residualQuery,
    signature,
    diagnostics,
  });
};

export const analyzeCoordinateQueryV7 = (
  input: unknown,
  policyInput: CoordinateQueryPolicyV7 = {},
): CoordinateQueryAnalysisV7 => {
  const policy = normalizePolicy(policyInput);
  const raw = normalizeText(input);
  const inputLength = raw.length;
  const truncated = raw.length > policy.maximumInputLength;
  const boundedRaw = truncated ? raw.slice(0, policy.maximumInputLength) : raw;
  if (!boundedRaw) return noMatch(boundedRaw, inputLength, truncated);
  const match = findMatch(boundedRaw, policy);
  if (!match) return noMatch(boundedRaw, inputLength, truncated);
  const resolved = resolveMatch(match, policy);
  if (!resolved.coordinates) {
    return noMatch(boundedRaw, inputLength, truncated, resolved.rejectedReason);
  }
  const residualQuery = residualAfterMatch(boundedRaw, match);
  const confidence: CoordinateQueryConfidenceV7 = match.explicitOrder || !resolved.ambiguous
    ? 'strong'
    : 'weak';
  const diagnostics: CoordinateQueryDiagnosticsV7 = Object.freeze({
    inputLength,
    boundedLength: boundedRaw.length,
    truncated,
    matched: true,
    ambiguousOrder: resolved.ambiguous,
    explicitOrder: match.explicitOrder,
    matchedLength: match.raw.length,
    rejectedReason: null,
  });
  const signature = hashFingerprint(stableSerialize({
    version: VERSION,
    kind: match.kind,
    order: resolved.order,
    coordinates: resolved.coordinates,
    residualQuery,
  }));
  return Object.freeze({
    version: VERSION,
    kind: match.kind,
    confidence,
    order: resolved.order,
    coordinates: resolved.coordinates,
    residualQuery,
    signature,
    diagnostics,
  });
};

export const coordinateQueryFingerprintV7 = (
  input: unknown,
  policy: CoordinateQueryPolicyV7 = {},
): string => analyzeCoordinateQueryV7(input, policy).signature;
