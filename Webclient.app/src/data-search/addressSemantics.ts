import type {
  AddressEvidence,
  AddressLevel,
  AddressQueryAnalysis,
  AddressQueryOptions,
  AddressScore,
  AddressSemanticFields,
  AddressTokenClass,
  AddressTokenDescriptor,
  AddressTokenMatch,
  NormalizedRecord,
} from './contracts';
import {
  normalizeInteger,
  normalizeSearchText,
  normalizeText,
  tokenizeSearchText,
} from './normalization';

export const ADDRESS_QUERY_VERSION = '3.1.0';

export const ADDRESS_LEVELS = Object.freeze({
  District: 'district',
  Neighborhood: 'neighborhood',
  Street: 'street',
  Building: 'building',
  Door: 'door',
  Address: 'address',
} as const);

export const ADDRESS_TOKEN_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  cd: 'cadde',
  cad: 'cadde',
  cadde: 'cadde',
  caddesi: 'cadde',
  sk: 'sokak',
  sok: 'sokak',
  sokak: 'sokak',
  sokagi: 'sokak',
  sokagi_: 'sokak',
  blv: 'bulvar',
  bulv: 'bulvar',
  bulvar: 'bulvar',
  bulvari: 'bulvar',
  yol: 'yol',
  yolu: 'yol',
  mh: 'mahalle',
  mah: 'mahalle',
  mahalle: 'mahalle',
  mahallesi: 'mahalle',
  ilce: 'ilce',
  ilcesi: 'ilce',
  semt: 'semt',
  semti: 'semt',
  apt: 'apartman',
  apartman: 'apartman',
  apartmani: 'apartman',
  bina: 'bina',
  binasi: 'bina',
  blok: 'blok',
  blogu: 'blok',
  no: 'no',
  numara: 'no',
  numarasi: 'no',
  kapi: 'no',
  kapino: 'no',
  site: 'site',
  sitesi: 'site',
  mevki: 'mevki',
  mevkii: 'mevki',
});

export const ADDRESS_STRUCTURE_TOKENS = Object.freeze([
  'cadde',
  'sokak',
  'bulvar',
  'yol',
  'mahalle',
  'ilce',
  'semt',
  'apartman',
  'bina',
  'blok',
  'no',
  'site',
  'mevki',
] as const);

export const ADDRESS_ROAD_TOKENS = Object.freeze(['cadde', 'sokak', 'bulvar', 'yol'] as const);
export const ADDRESS_BUILDING_TOKENS = Object.freeze(['apartman', 'bina', 'blok', 'site'] as const);
export const ADDRESS_LOCALITY_TOKENS = Object.freeze(['mahalle', 'ilce', 'semt', 'mevki'] as const);

const STRUCTURE_SET = new Set<string>(ADDRESS_STRUCTURE_TOKENS);
const ROAD_SET = new Set<string>(ADDRESS_ROAD_TOKENS);
const BUILDING_SET = new Set<string>(ADDRESS_BUILDING_TOKENS);
const LOCALITY_SET = new Set<string>(ADDRESS_LOCALITY_TOKENS);

const FIELD_WEIGHTS: Readonly<Record<string, number>> = Object.freeze({
  title: 1.2,
  address: 1,
  street: 1.45,
  neighborhood: 1.2,
  district: 1.1,
  door: 1.5,
  postalCode: 1.35,
});

const unique = (values: readonly string[]): string[] =>
  Array.from(new Set(values.filter(Boolean)));

const isNumericToken = (value: string): boolean => /^\d+[a-z]?$/.test(value);
const isPostalCode = (value: string): boolean => /^\d{5}$/.test(value);

export const normalizeAddressSemanticText = (value: unknown): string =>
  normalizeSearchText(value)
    .replace(/[.,;:(){}[\]/\\]+/g, ' ')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

export const tokenizeAddressSemanticText = (value: unknown): string[] => {
  const normalized = normalizeAddressSemanticText(value);
  return normalized ? normalized.split(' ').filter(Boolean) : [];
};

export const canonicalizeAddressToken = (value: unknown): string => {
  const token = normalizeAddressSemanticText(value);
  return ADDRESS_TOKEN_ALIASES[token] ?? token;
};

export const canonicalizeAddressTokens = (value: unknown): string[] =>
  unique(tokenizeAddressSemanticText(value).map(canonicalizeAddressToken));

/**
 * Canonical text is an identity representation, so token order and multiplicity
 * are preserved. Search token sets intentionally deduplicate separately via
 * canonicalizeAddressTokens(). This prevents paths such as `Sokak 0-1-0` and
 * `Sokak 0-1-1` from collapsing to the same canonical address identity.
 */
export const canonicalizeAddressText = (value: unknown): string =>
  tokenizeAddressSemanticText(value)
    .map(canonicalizeAddressToken)
    .filter(Boolean)
    .join(' ');

export const classifyAddressToken = (value: unknown): AddressTokenClass => {
  const token = canonicalizeAddressToken(value);
  if (isPostalCode(token)) return 'postal-code';
  if (isNumericToken(token)) return 'number';
  if (STRUCTURE_SET.has(token)) return 'structural';
  return 'strong';
};

export const createAddressTokenDescriptor = (
  value: unknown,
  index = 0,
): AddressTokenDescriptor => {
  const raw = normalizeAddressSemanticText(value);
  const canonical = canonicalizeAddressToken(raw);
  const tokenClass = classifyAddressToken(canonical);
  return Object.freeze({
    index,
    raw,
    canonical,
    tokenClass,
    isStrong: tokenClass === 'strong',
    isStructural: tokenClass === 'structural',
    isNumber: tokenClass === 'number',
    isPostalCode: tokenClass === 'postal-code',
    isRoadType: ROAD_SET.has(canonical),
    isBuildingType: BUILDING_SET.has(canonical),
    isLocalityType: LOCALITY_SET.has(canonical),
  });
};

export const normalizeDoorToken = (value: unknown): string =>
  normalizeAddressSemanticText(value).replace(/\s+/g, '');

export interface ParsedAddressNumber {
  readonly raw: string;
  readonly normalized: string;
  readonly number: number;
  readonly suffix: string;
}

export const parseAddressNumberToken = (value: unknown): ParsedAddressNumber | null => {
  const normalized = normalizeDoorToken(value);
  const match = /^(\d+)([a-z])?$/.exec(normalized);
  if (!match) return null;
  const numericPart = match[1];
  if (!numericPart) return null;
  return Object.freeze({
    raw: normalizeText(value),
    normalized,
    number: Number.parseInt(numericPart, 10),
    suffix: match[2] ?? '',
  });
};

const normalizeAddressLevel = (value: unknown): AddressLevel | null => {
  const normalized = normalizeSearchText(value);
  return normalized === 'district' || normalized === 'ilce'
    ? 'district'
    : normalized === 'neighborhood' || normalized === 'mahalle' || normalized === 'semt'
      ? 'neighborhood'
      : normalized === 'street' || normalized === 'cadde' || normalized === 'sokak' || normalized === 'bulvar' || normalized === 'yol'
        ? 'street'
        : normalized === 'building' || normalized === 'bina' || normalized === 'apartman' || normalized === 'site'
          ? 'building'
          : normalized === 'door' || normalized === 'kapi'
            ? 'door'
            : normalized === 'address' || normalized === 'adres'
              ? 'address'
              : null;
};

export const inferAddressQueryLevel = (
  analysis: Pick<
    AddressQueryAnalysis,
    'hasDoorHint' | 'roadTokens' | 'buildingTokens' | 'localityTokens'
  >,
): AddressLevel | null => {
  if (analysis.hasDoorHint) return 'door';
  if (analysis.buildingTokens.length) return 'building';
  if (analysis.roadTokens.length) return 'street';
  if (analysis.localityTokens.includes('mahalle') || analysis.localityTokens.includes('semt')) {
    return 'neighborhood';
  }
  if (analysis.localityTokens.includes('ilce')) return 'district';
  return null;
};

const createAddressQuerySignature = (
  analysis: Omit<AddressQueryAnalysis, 'signature'>,
  options: AddressQueryOptions,
): string => JSON.stringify({
  v: ADDRESS_QUERY_VERSION,
  q: analysis.canonicalText,
  district: canonicalizeAddressText(options.district),
  neighborhood: canonicalizeAddressText(options.neighborhood),
  street: canonicalizeAddressText(options.street),
  level: analysis.explicitLevel ?? analysis.inferredLevel,
  center: options.center ?? null,
  radiusMeters: Number.isFinite(Number(options.radiusMeters)) ? Number(options.radiusMeters) : null,
});

export const analyzeAddressQuery = (
  query: unknown,
  options: AddressQueryOptions = {},
): AddressQueryAnalysis => {
  const normalizedText = normalizeAddressSemanticText(query);
  const rawTokens = tokenizeAddressSemanticText(normalizedText);
  const descriptors = rawTokens.map((token, index) => createAddressTokenDescriptor(token, index));
  const canonicalTokens = unique(descriptors.map(item => item.canonical));
  const strongTokens = unique(descriptors.filter(item => item.isStrong).map(item => item.canonical));
  const structuralTokens = unique(descriptors.filter(item => item.isStructural).map(item => item.canonical));
  const numericTokens = unique(descriptors.filter(item => item.isNumber).map(item => item.canonical));
  const postalTokens = unique(descriptors.filter(item => item.isPostalCode).map(item => item.canonical));
  const roadTokens = structuralTokens.filter(token => ROAD_SET.has(token));
  const buildingTokens = structuralTokens.filter(token => BUILDING_SET.has(token));
  const localityTokens = structuralTokens.filter(token => LOCALITY_SET.has(token));
  const hasExplicitNumberLabel = structuralTokens.includes('no');
  const hasDoorHint = hasExplicitNumberLabel
    || (numericTokens.length > 0 && (roadTokens.length > 0 || options.assumeDoorForNumber === true));
  const weakOnly = canonicalTokens.length > 0
    && strongTokens.length === 0
    && numericTokens.length === 0
    && postalTokens.length === 0;
  const explicitLevel = normalizeAddressLevel(options.level);
  const preliminary = {
    version: ADDRESS_QUERY_VERSION,
    raw: normalizeText(query),
    normalizedText,
    canonicalText: descriptors.map(item => item.canonical).filter(Boolean).join(' '),
    rawTokens: Object.freeze(rawTokens),
    descriptors: Object.freeze(descriptors),
    canonicalTokens: Object.freeze(canonicalTokens),
    strongTokens: Object.freeze(strongTokens),
    structuralTokens: Object.freeze(structuralTokens),
    numericTokens: Object.freeze(numericTokens),
    postalTokens: Object.freeze(postalTokens),
    roadTokens: Object.freeze(roadTokens),
    buildingTokens: Object.freeze(buildingTokens),
    localityTokens: Object.freeze(localityTokens),
    hasExplicitNumberLabel,
    hasDoorHint,
    weakOnly,
    requiresStrongEvidence: strongTokens.length > 0,
    requiresNumericEvidence: numericTokens.length > 0,
    requiresPostalEvidence: postalTokens.length > 0,
    explicitLevel,
  };
  const inferredLevel = explicitLevel ?? inferAddressQueryLevel({
    hasDoorHint,
    roadTokens,
    buildingTokens,
    localityTokens,
  });
  const withoutSignature: Omit<AddressQueryAnalysis, 'signature'> = Object.freeze({
    ...preliminary,
    inferredLevel,
  });
  return Object.freeze({
    ...withoutSignature,
    signature: createAddressQuerySignature(withoutSignature, options),
  });
};

const semanticFieldEntries = (
  record: NormalizedRecord,
): readonly (readonly [string, string])[] => [
  ['title', record.title],
  ['address', record.address],
  ['street', record.street],
  ['neighborhood', record.neighborhood],
  ['district', record.district],
  ['door', record.door],
  ['postalCode', record.postalCode],
] as const;

export const createAddressSemanticFields = (
  record: NormalizedRecord,
): AddressSemanticFields => {
  const fields: Record<string, string> = {};
  const fieldTokens: Record<string, readonly string[]> = {};
  for (const [name, value] of semanticFieldEntries(record)) {
    const canonical = canonicalizeAddressText(value);
    fields[name] = canonical;
    fieldTokens[name] = Object.freeze(canonicalizeAddressTokens(canonical));
  }
  const allTokens = unique(Object.values(fieldTokens).flat());
  return Object.freeze({
    fields: Object.freeze(fields),
    fieldTokens: Object.freeze(fieldTokens),
    allTokens: Object.freeze(allTokens),
    roadTokens: Object.freeze(allTokens.filter(token => ROAD_SET.has(token))),
    numericTokens: Object.freeze(allTokens.filter(isNumericToken)),
    postalTokens: Object.freeze(allTokens.filter(isPostalCode)),
  });
};

export const scoreSemanticToken = (
  candidate: string,
  queryToken: string,
  tokenClass: AddressTokenClass = classifyAddressToken(queryToken),
): number => {
  if (!candidate || !queryToken) return 0;
  if (tokenClass === 'number' || tokenClass === 'postal-code') {
    return candidate === queryToken ? 125 : 0;
  }
  if (tokenClass === 'structural') return candidate === queryToken ? 15 : 0;
  if (candidate === queryToken) return 110;
  if (candidate.startsWith(queryToken)) return 75;
  if (candidate.includes(queryToken)) return 45;
  if (queryToken.includes(candidate) && candidate.length >= 3) return 20;
  return 0;
};

export const scoreAddressSemanticField = (
  fieldName: string,
  fieldTokens: readonly string[],
  descriptor: AddressTokenDescriptor,
): AddressTokenMatch => {
  const weight = FIELD_WEIGHTS[fieldName] ?? 1;
  let best = 0;
  for (const token of fieldTokens) {
    best = Math.max(best, scoreSemanticToken(token, descriptor.canonical, descriptor.tokenClass));
  }
  return Object.freeze({
    descriptor,
    field: fieldName,
    token: descriptor.canonical,
    score: Math.round(best * weight),
  });
};

export const findBestAddressTokenMatch = (
  semanticDocument: AddressSemanticFields,
  descriptor: AddressTokenDescriptor,
): AddressTokenMatch => {
  const fieldMatches = Object.entries(semanticDocument.fieldTokens)
    .map(([name, tokens]) => scoreAddressSemanticField(name, tokens, descriptor))
    .sort((left, right) => right.score - left.score || (left.field ?? '').localeCompare(right.field ?? '', 'en'));
  return fieldMatches[0] ?? Object.freeze({ descriptor, field: null, token: descriptor.canonical, score: 0 });
};

export const evaluateAddressEvidence = (
  record: NormalizedRecord,
  query: AddressQueryAnalysis | string,
): AddressEvidence => {
  const analysis = typeof query === 'string' ? analyzeAddressQuery(query) : query;
  const semanticDocument = createAddressSemanticFields(record);
  const matches = analysis.descriptors.map(descriptor =>
    findBestAddressTokenMatch(semanticDocument, descriptor));
  const matched = matches.filter(item => item.score > 0);
  const matchedStrong = matched.filter(item => item.descriptor.isStrong);
  const matchedNumbers = matched.filter(item => item.descriptor.isNumber);
  const matchedPostal = matched.filter(item => item.descriptor.isPostalCode);
  const matchedStructural = matched.filter(item => item.descriptor.isStructural);
  const strongCoverage = analysis.strongTokens.length
    ? matchedStrong.length / analysis.strongTokens.length
    : 1;
  const tokenCoverage = analysis.canonicalTokens.length
    ? matched.length / analysis.canonicalTokens.length
    : 0;
  const numericSatisfied = !analysis.requiresNumericEvidence
    || matchedNumbers.length === analysis.numericTokens.length;
  const postalSatisfied = !analysis.requiresPostalEvidence
    || matchedPostal.length === analysis.postalTokens.length;
  const strongSatisfied = !analysis.requiresStrongEvidence || matchedStrong.length > 0;
  const structuralSatisfied = !analysis.weakOnly || matchedStructural.length > 0;
  const roadTypeMismatch = analysis.roadTokens.length > 0
    && semanticDocument.roadTokens.length > 0
    && !analysis.roadTokens.some(token => semanticDocument.roadTokens.includes(token));
  return Object.freeze({
    analysis,
    semanticDocument,
    matches: Object.freeze(matches),
    matched: Object.freeze(matched),
    matchedStrongCount: matchedStrong.length,
    matchedNumberCount: matchedNumbers.length,
    matchedPostalCount: matchedPostal.length,
    tokenCoverage,
    strongCoverage,
    numericSatisfied,
    postalSatisfied,
    strongSatisfied,
    structuralSatisfied,
    roadTypeMismatch,
    eligible: strongSatisfied && numericSatisfied && postalSatisfied && structuralSatisfied,
  });
};

const levelOfRecord = (record: NormalizedRecord): AddressLevel | null => {
  const raw = normalizeSearchText(record.fields.level ?? record.fields.addressLevel ?? record.fields.LEVEL);
  return normalizeAddressLevel(raw);
};

export const scoreAddressRecord = (
  record: NormalizedRecord,
  query: AddressQueryAnalysis | string,
): AddressScore => {
  const evidence = evaluateAddressEvidence(record, query);
  if (!evidence.eligible || evidence.analysis.canonicalTokens.length === 0) {
    return Object.freeze({ ...evidence, score: 0, bonuses: Object.freeze({}), penalties: Object.freeze({}) });
  }
  const canonicalAddress = canonicalizeAddressText(record.address);
  const canonicalTitle = canonicalizeAddressText(record.title);
  const exactBonus = canonicalAddress === evidence.analysis.canonicalText
    || canonicalTitle === evidence.analysis.canonicalText ? 500 : 0;
  const prefixBonus = canonicalAddress.startsWith(evidence.analysis.canonicalText)
    || canonicalTitle.startsWith(evidence.analysis.canonicalText) ? 200 : 0;
  const fieldScore = evidence.matches.reduce((total, item) => total + item.score, 0);
  const completeBonus = evidence.tokenCoverage === 1
    ? 150
    : Math.round(evidence.tokenCoverage * 80);
  const strongCoverageBonus = Math.round(evidence.strongCoverage * 120);
  const recordLevel = levelOfRecord(record);
  const levelBonus = evidence.analysis.inferredLevel && recordLevel === evidence.analysis.inferredLevel ? 80 : 0;
  const roadPenalty = evidence.roadTypeMismatch ? 45 : 0;
  const weakQueryPenalty = evidence.analysis.weakOnly ? 20 : 0;
  const missingStrongPenalty = evidence.analysis.strongTokens.length > 1
    && evidence.matchedStrongCount < evidence.analysis.strongTokens.length ? 35 : 0;
  const score = Math.max(0,
    exactBonus
      + prefixBonus
      + fieldScore
      + completeBonus
      + strongCoverageBonus
      + levelBonus
      - roadPenalty
      - weakQueryPenalty
      - missingStrongPenalty);
  return Object.freeze({
    ...evidence,
    score,
    bonuses: Object.freeze({
      exact: exactBonus,
      prefix: prefixBonus,
      complete: completeBonus,
      strongCoverage: strongCoverageBonus,
      level: levelBonus,
      fields: fieldScore,
    }),
    penalties: Object.freeze({
      roadMismatch: roadPenalty,
      weakQuery: weakQueryPenalty,
      missingStrong: missingStrongPenalty,
    }),
  });
};

export const matchesAddressHierarchy = (
  record: NormalizedRecord,
  options: AddressQueryOptions,
): boolean => {
  const district = canonicalizeAddressText(options.district);
  const neighborhood = canonicalizeAddressText(options.neighborhood);
  const street = canonicalizeAddressText(options.street);
  if (district && canonicalizeAddressText(record.district) !== district) return false;
  if (neighborhood && canonicalizeAddressText(record.neighborhood) !== neighborhood) return false;
  if (street && canonicalizeAddressText(record.street) !== street) return false;
  const level = normalizeAddressLevel(options.level);
  if (level && levelOfRecord(record) !== level) return false;
  return true;
};

export interface AddressSuggestion {
  readonly text: string;
  readonly score: number;
  readonly count: number;
  readonly level: AddressLevel | null;
}

export const createAddressSuggestions = (
  records: readonly NormalizedRecord[],
  query: unknown,
  limitInput: unknown = 10,
): readonly AddressSuggestion[] => {
  const analysis = analyzeAddressQuery(query);
  const limit = normalizeInteger(limitInput, { min: 1, max: 50, fallback: 10 });
  const buckets = new Map<string, { score: number; count: number; level: AddressLevel | null }>();
  for (const record of records) {
    const result = scoreAddressRecord(record, analysis);
    if (result.score <= 0) continue;
    const text = record.street || record.neighborhood || record.district || record.title || record.address;
    if (!text) continue;
    const previous = buckets.get(text);
    buckets.set(text, {
      score: Math.max(previous?.score ?? 0, result.score),
      count: (previous?.count ?? 0) + 1,
      level: levelOfRecord(record) ?? previous?.level ?? null,
    });
  }
  return Object.freeze(
    Array.from(buckets.entries())
      .map(([text, value]) => Object.freeze({ text, ...value }))
      .sort((left, right) => right.score - left.score
        || right.count - left.count
        || left.text.localeCompare(right.text, 'tr-TR', { sensitivity: 'base', numeric: true }))
      .slice(0, limit),
  );
};

export const addressTokensForCandidatePlanning = (
  query: AddressQueryAnalysis | string,
): readonly string[] => {
  const analysis = typeof query === 'string' ? analyzeAddressQuery(query) : query;
  const strong = analysis.strongTokens;
  const numbers = analysis.numericTokens;
  const postal = analysis.postalTokens;
  if (strong.length || numbers.length || postal.length) {
    return Object.freeze(unique([...strong, ...numbers, ...postal]));
  }
  return Object.freeze(unique(analysis.structuralTokens));
};

export const canonicalAddressRecordTokens = (
  record: NormalizedRecord,
): readonly string[] => Object.freeze(unique([
  ...tokenizeSearchText(record.title),
  ...canonicalizeAddressTokens(record.address),
  ...canonicalizeAddressTokens(record.street),
  ...canonicalizeAddressTokens(record.neighborhood),
  ...canonicalizeAddressTokens(record.district),
  ...canonicalizeAddressTokens(record.door),
  ...canonicalizeAddressTokens(record.postalCode),
]));
