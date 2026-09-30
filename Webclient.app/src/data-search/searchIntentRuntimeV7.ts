import type {
  AddressQueryAnalysis,
  Coordinate,
  SearchRequest,
} from './contracts';
import {
  analyzeAddressQuery,
  canonicalizeAddressText,
} from './addressSemantics';
import {
  hashFingerprint,
  normalizeCoordinates,
  normalizeInteger,
  normalizeSearchText,
  normalizeText,
  stableSerialize,
} from './normalization';
import {
  analyzeTextQuery,
  type TextQueryAnalysis,
  type TextQueryAnalysisPolicy,
} from './textQueryAnalysisRuntime';
import {
  analyzeCoordinateQueryV7,
  type CoordinateQueryAnalysisV7,
  type CoordinateQueryPolicyV7,
} from './coordinateQueryRuntimeV7';

export type SearchIntentKindV7 = 'empty' | 'text' | 'address' | 'coordinate' | 'hybrid';
export type SearchIntentCenterSourceV7 = 'none' | 'request' | 'query';

export interface SearchIntentPolicyV7 {
  readonly coordinate?: CoordinateQueryPolicyV7;
  readonly text?: Partial<TextQueryAnalysisPolicy>;
  readonly minimumAddressEvidence?: number;
  readonly maximumHierarchyHints?: number;
}

export interface SearchIntentEvidenceV7 {
  readonly textTerms: number;
  readonly textPhrases: number;
  readonly addressStrongTokens: number;
  readonly addressStructuralTokens: number;
  readonly addressNumericTokens: number;
  readonly addressPostalTokens: number;
  readonly hierarchyHints: number;
  readonly addressEvidenceScore: number;
  readonly hasCoordinate: boolean;
  readonly hasResidualText: boolean;
}

export interface SearchIntentDiagnosticsV7 {
  readonly inputLength: number;
  readonly residualLength: number;
  readonly invalidExplicitCenter: boolean;
  readonly coordinateFromQuery: boolean;
  readonly coordinateAmbiguous: boolean;
  readonly explicitHierarchy: boolean;
  readonly addressEvidenceAccepted: boolean;
}

export interface SearchIntentAnalysisV7 {
  readonly version: 'search-intent-v7';
  readonly kind: SearchIntentKindV7;
  readonly center: Coordinate | null;
  readonly centerSource: SearchIntentCenterSourceV7;
  readonly residualQuery: string;
  readonly text: TextQueryAnalysis;
  readonly address: AddressQueryAnalysis;
  readonly coordinate: CoordinateQueryAnalysisV7;
  readonly evidence: SearchIntentEvidenceV7;
  readonly signature: string;
  readonly diagnostics: SearchIntentDiagnosticsV7;
}

interface NormalizedIntentPolicyV7 {
  readonly coordinate: CoordinateQueryPolicyV7;
  readonly text: Partial<TextQueryAnalysisPolicy>;
  readonly minimumAddressEvidence: number;
  readonly maximumHierarchyHints: number;
}

const VERSION = 'search-intent-v7' as const;
const DEFAULT_MINIMUM_ADDRESS_EVIDENCE = 3;
const MAXIMUM_DOMAIN_ALIAS_EXPANSIONS = 4;
const CIVIC_DOMAIN_ALIASES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  hastane: Object.freeze(['saglik']),
  hastanesi: Object.freeze(['saglik']),
});

const normalizePolicy = (
  policy: SearchIntentPolicyV7 = {},
): NormalizedIntentPolicyV7 => Object.freeze({
  coordinate: Object.freeze({ ...policy.coordinate }),
  text: Object.freeze({ ...policy.text }),
  minimumAddressEvidence: normalizeInteger(policy.minimumAddressEvidence, {
    min: 1,
    max: 12,
    fallback: DEFAULT_MINIMUM_ADDRESS_EVIDENCE,
  }),
  maximumHierarchyHints: normalizeInteger(policy.maximumHierarchyHints, {
    min: 1,
    max: 8,
    fallback: 4,
  }),
});

export const expandCivicSearchQueryV7 = (input: unknown): string => {
  const raw = normalizeText(input);
  const canonical = normalizeSearchText(raw).replace(/\s+/g, ' ').trim();
  if (!canonical) return raw;
  const aliases: string[] = [];
  const seen = new Set(canonical.split(' ').filter(Boolean));
  for (const term of seen) {
    for (const alias of CIVIC_DOMAIN_ALIASES[term] ?? []) {
      if (seen.has(alias) || aliases.includes(alias)) continue;
      aliases.push(alias);
      if (aliases.length >= MAXIMUM_DOMAIN_ALIAS_EXPANSIONS) break;
    }
    if (aliases.length >= MAXIMUM_DOMAIN_ALIAS_EXPANSIONS) break;
  }
  return aliases.length ? `${raw} ${aliases.join(' ')}` : raw;
};

const suppliedCenter = (request: SearchRequest): {
  readonly supplied: boolean;
  readonly coordinate: Coordinate | null;
} => {
  const supplied = request.center !== null && request.center !== undefined;
  return Object.freeze({
    supplied,
    coordinate: supplied ? normalizeCoordinates(request.center) : null,
  });
};

const hierarchyValues = (request: SearchRequest): readonly string[] => Object.freeze([
  normalizeText(request.level),
  canonicalizeAddressText(request.district),
  canonicalizeAddressText(request.neighborhood),
  canonicalizeAddressText(request.street),
].filter(Boolean));

const countHierarchyHints = (
  request: SearchRequest,
  maximum: number,
): number => Math.min(maximum, hierarchyValues(request).length);

const addressEvidenceScore = (
  address: AddressQueryAnalysis,
  hierarchyHints: number,
): number => {
  let score = 0;
  if (hierarchyHints > 0) score += Math.min(4, hierarchyHints * 2);
  if (address.inferredLevel) score += 2;
  if (address.numericTokens.length > 0) score += 2;
  if (address.postalTokens.length > 0) score += 3;
  if (address.structuralTokens.length > 0) score += 1;
  if (address.roadTokens.length > 0) score += 1;
  if (address.localityTokens.length > 0) score += 1;
  if (address.strongTokens.length >= 2) score += 1;
  return score;
};

const textEvidenceCount = (text: TextQueryAnalysis): number =>
  text.positiveTerms.length + text.phrases.length;

const classifyIntent = (
  rawQuery: string,
  hasCenter: boolean,
  hasText: boolean,
  hasAddress: boolean,
  hierarchyHints: number,
): SearchIntentKindV7 => {
  const hasAnyQuery = Boolean(rawQuery);
  if (!hasAnyQuery && !hasCenter && hierarchyHints === 0) return 'empty';
  if (hasCenter && (hasText || hasAddress || hierarchyHints > 0)) return 'hybrid';
  if (hasCenter) return 'coordinate';
  if (hasAddress || hierarchyHints > 0) return 'address';
  return hasText || hasAnyQuery ? 'text' : 'empty';
};

const addressAnalysis = (
  residualQuery: string,
  request: SearchRequest,
  center: Coordinate | null,
): AddressQueryAnalysis => analyzeAddressQuery(residualQuery, {
  ...(request.level ? { level: request.level } : {}),
  ...(request.district ? { district: request.district } : {}),
  ...(request.neighborhood ? { neighborhood: request.neighborhood } : {}),
  ...(request.street ? { street: request.street } : {}),
  ...(center ? { center } : {}),
  ...(request.radiusMeters !== undefined ? { radiusMeters: request.radiusMeters } : {}),
});

const signatureFor = (
  kind: SearchIntentKindV7,
  center: Coordinate | null,
  centerSource: SearchIntentCenterSourceV7,
  residualQuery: string,
  text: TextQueryAnalysis,
  address: AddressQueryAnalysis,
  coordinate: CoordinateQueryAnalysisV7,
  request: SearchRequest,
): string => hashFingerprint(stableSerialize({
  version: VERSION,
  kind,
  center,
  centerSource,
  residualQuery: normalizeSearchText(residualQuery),
  textSignature: text.signature,
  addressSignature: address.signature,
  coordinate: {
    kind: coordinate.kind,
    order: coordinate.order,
    coordinates: coordinate.coordinates,
    residualQuery: normalizeSearchText(coordinate.residualQuery),
    rejectedReason: coordinate.diagnostics.rejectedReason,
  },
  hierarchy: {
    level: request.level ?? null,
    district: canonicalizeAddressText(request.district),
    neighborhood: canonicalizeAddressText(request.neighborhood),
    street: canonicalizeAddressText(request.street),
  },
}));

export const analyzeSearchIntentV7 = (
  request: SearchRequest = {},
  policyInput: SearchIntentPolicyV7 = {},
): SearchIntentAnalysisV7 => {
  const policy = normalizePolicy(policyInput);
  const rawQuery = normalizeText(request.query);
  const explicit = suppliedCenter(request);
  const coordinate = analyzeCoordinateQueryV7(rawQuery, policy.coordinate);
  const center = explicit.coordinate ?? coordinate.coordinates;
  const centerSource: SearchIntentCenterSourceV7 = explicit.coordinate
    ? 'request'
    : coordinate.coordinates
      ? 'query'
      : 'none';
  const coordinateResidual = coordinate.coordinates
    ? coordinate.residualQuery
    : rawQuery;
  const residualQuery = expandCivicSearchQueryV7(coordinateResidual);
  const text = analyzeTextQuery(residualQuery, policy.text);
  const address = addressAnalysis(residualQuery, request, center);
  const hierarchyHints = countHierarchyHints(request, policy.maximumHierarchyHints);
  const addressScore = addressEvidenceScore(address, hierarchyHints);
  const hasText = textEvidenceCount(text) > 0;
  const hasAddress = addressScore >= policy.minimumAddressEvidence;
  const hasCenter = center !== null;
  const kind = classifyIntent(rawQuery, hasCenter, hasText, hasAddress, hierarchyHints);
  const evidence: SearchIntentEvidenceV7 = Object.freeze({
    textTerms: text.positiveTerms.length,
    textPhrases: text.phrases.length,
    addressStrongTokens: address.strongTokens.length,
    addressStructuralTokens: address.structuralTokens.length,
    addressNumericTokens: address.numericTokens.length,
    addressPostalTokens: address.postalTokens.length,
    hierarchyHints,
    addressEvidenceScore: addressScore,
    hasCoordinate: hasCenter,
    hasResidualText: Boolean(residualQuery),
  });
  const invalidExplicitCenter = explicit.supplied && explicit.coordinate === null;
  const diagnostics: SearchIntentDiagnosticsV7 = Object.freeze({
    inputLength: rawQuery.length,
    residualLength: residualQuery.length,
    invalidExplicitCenter,
    coordinateFromQuery: centerSource === 'query',
    coordinateAmbiguous: coordinate.diagnostics.ambiguousOrder,
    explicitHierarchy: hierarchyHints > 0,
    addressEvidenceAccepted: hasAddress,
  });
  return Object.freeze({
    version: VERSION,
    kind,
    center,
    centerSource,
    residualQuery,
    text,
    address,
    coordinate,
    evidence,
    signature: signatureFor(
      kind,
      center,
      centerSource,
      residualQuery,
      text,
      address,
      coordinate,
      request,
    ),
    diagnostics,
  });
};

export const searchIntentFingerprintV7 = (
  request: SearchRequest = {},
  policy: SearchIntentPolicyV7 = {},
): string => analyzeSearchIntentV7(request, policy).signature;

export const searchIntentRequiresSpatialV7 = (
  analysis: SearchIntentAnalysisV7,
): boolean => analysis.kind === 'coordinate'
  || (analysis.kind === 'hybrid' && analysis.center !== null);

export const searchIntentRequiresAddressV7 = (
  analysis: SearchIntentAnalysisV7,
): boolean => analysis.kind === 'address'
  || analysis.kind === 'hybrid';

export const searchIntentRequiresTextV7 = (
  analysis: SearchIntentAnalysisV7,
): boolean => analysis.kind === 'text'
  || (analysis.kind === 'hybrid' && analysis.evidence.hasResidualText)
  || (analysis.kind === 'address' && analysis.evidence.hasResidualText);
