export type Primitive = string | number | boolean | null;
export type JsonValue = Primitive | JsonValue[] | { readonly [key: string]: JsonValue };
export type UnknownRecord = Record<string, unknown>;

export type AddressLevel =
  | 'district'
  | 'neighborhood'
  | 'street'
  | 'building'
  | 'door'
  | 'address';

export type AddressTokenClass = 'strong' | 'structural' | 'number' | 'postal-code';
export type SearchSortMode = 'relevance' | 'title' | 'distance' | 'source-order';
export type FilterOperator =
  | 'eq'
  | 'neq'
  | 'in'
  | 'prefix'
  | 'contains'
  | 'exists'
  | 'gte'
  | 'lte'
  | 'between';

export interface Coordinate {
  readonly latitude: number;
  readonly longitude: number;
}

export interface SpatialBounds {
  readonly minLatitude: number;
  readonly maxLatitude: number;
  readonly minLongitude: number;
  readonly maxLongitude: number;
}

export interface PaginationRequest {
  readonly offset?: number | string | null;
  readonly limit?: number | string | null;
}

export interface PageInfo {
  readonly offset: number;
  readonly limit: number;
  readonly count: number;
  readonly total: number;
  readonly hasMore: boolean;
  readonly nextOffset: number | null;
}

export interface Page<T> {
  readonly items: readonly T[];
  readonly page: PageInfo;
}

export interface DataQualityIssue {
  readonly code: string;
  readonly severity: 'info' | 'warning' | 'error';
  readonly field?: string;
  readonly recordKey?: string;
  readonly detail?: string;
}

export interface DataQualitySummary {
  readonly inputCount: number;
  readonly outputCount: number;
  readonly duplicateCount: number;
  readonly invalidCount: number;
  readonly missingIdCount: number;
  readonly invalidCoordinateCount: number;
  readonly issues: readonly DataQualityIssue[];
}

export interface NormalizedRecord {
  readonly id: string | null;
  readonly title: string;
  readonly searchTitle: string;
  readonly category: string;
  readonly categoryKey: string;
  readonly type: string;
  readonly typeKey: string;
  readonly address: string;
  readonly district: string;
  readonly neighborhood: string;
  readonly street: string;
  readonly door: string;
  readonly postalCode: string;
  readonly phone: string;
  readonly url: string;
  readonly coordinates: Coordinate | null;
  readonly fields: Readonly<Record<string, unknown>>;
  readonly source: unknown;
  readonly sourceIndex: number;
  readonly fingerprint: string;
  readonly searchText: string;
}

export interface RecordAliasSchema {
  readonly id?: readonly string[];
  readonly title?: readonly string[];
  readonly category?: readonly string[];
  readonly type?: readonly string[];
  readonly address?: readonly string[];
  readonly district?: readonly string[];
  readonly neighborhood?: readonly string[];
  readonly street?: readonly string[];
  readonly door?: readonly string[];
  readonly postalCode?: readonly string[];
  readonly phone?: readonly string[];
  readonly url?: readonly string[];
  readonly latitude?: readonly string[];
  readonly longitude?: readonly string[];
}

export interface RecordNormalizationOptions {
  readonly schema?: RecordAliasSchema;
  readonly dedupe?: boolean;
  readonly keepInvalid?: boolean;
  readonly maxRecords?: number;
}

export interface RecordNormalizationResult {
  readonly records: readonly NormalizedRecord[];
  readonly quality: DataQualitySummary;
}

export interface AddressTokenDescriptor {
  readonly index: number;
  readonly raw: string;
  readonly canonical: string;
  readonly tokenClass: AddressTokenClass;
  readonly isStrong: boolean;
  readonly isStructural: boolean;
  readonly isNumber: boolean;
  readonly isPostalCode: boolean;
  readonly isRoadType: boolean;
  readonly isBuildingType: boolean;
  readonly isLocalityType: boolean;
}

export interface AddressQueryOptions {
  readonly level?: AddressLevel | string | null;
  readonly district?: string | null;
  readonly neighborhood?: string | null;
  readonly street?: string | null;
  readonly center?: Coordinate | readonly [number, number] | null;
  readonly radiusMeters?: number | string | null;
  readonly assumeDoorForNumber?: boolean;
}

export interface AddressQueryAnalysis {
  readonly version: string;
  readonly raw: string;
  readonly normalizedText: string;
  readonly canonicalText: string;
  readonly rawTokens: readonly string[];
  readonly descriptors: readonly AddressTokenDescriptor[];
  readonly canonicalTokens: readonly string[];
  readonly strongTokens: readonly string[];
  readonly structuralTokens: readonly string[];
  readonly numericTokens: readonly string[];
  readonly postalTokens: readonly string[];
  readonly roadTokens: readonly string[];
  readonly buildingTokens: readonly string[];
  readonly localityTokens: readonly string[];
  readonly hasExplicitNumberLabel: boolean;
  readonly hasDoorHint: boolean;
  readonly weakOnly: boolean;
  readonly requiresStrongEvidence: boolean;
  readonly requiresNumericEvidence: boolean;
  readonly requiresPostalEvidence: boolean;
  readonly explicitLevel: AddressLevel | null;
  readonly inferredLevel: AddressLevel | null;
  readonly signature: string;
}

export interface AddressSemanticFields {
  readonly fields: Readonly<Record<string, string>>;
  readonly fieldTokens: Readonly<Record<string, readonly string[]>>;
  readonly allTokens: readonly string[];
  readonly roadTokens: readonly string[];
  readonly numericTokens: readonly string[];
  readonly postalTokens: readonly string[];
}

export interface AddressTokenMatch {
  readonly descriptor: AddressTokenDescriptor;
  readonly field: string | null;
  readonly token: string;
  readonly score: number;
}

export interface AddressEvidence {
  readonly analysis: AddressQueryAnalysis;
  readonly semanticDocument: AddressSemanticFields;
  readonly matches: readonly AddressTokenMatch[];
  readonly matched: readonly AddressTokenMatch[];
  readonly matchedStrongCount: number;
  readonly matchedNumberCount: number;
  readonly matchedPostalCount: number;
  readonly tokenCoverage: number;
  readonly strongCoverage: number;
  readonly numericSatisfied: boolean;
  readonly postalSatisfied: boolean;
  readonly strongSatisfied: boolean;
  readonly structuralSatisfied: boolean;
  readonly roadTypeMismatch: boolean;
  readonly eligible: boolean;
}

export interface AddressScore extends AddressEvidence {
  readonly score: number;
  readonly bonuses: Readonly<Record<string, number>>;
  readonly penalties: Readonly<Record<string, number>>;
}

export interface SearchFilter {
  readonly field: string;
  readonly operator: FilterOperator;
  readonly values: readonly unknown[];
  readonly caseSensitive?: boolean;
}

export interface SearchRequest extends PaginationRequest {
  readonly query?: string | null;
  readonly filters?: readonly SearchFilter[];
  readonly facetFields?: readonly string[];
  readonly sort?: SearchSortMode;
  readonly minScore?: number;
  readonly center?: Coordinate | readonly [number, number] | null;
  readonly radiusMeters?: number;
  readonly level?: AddressLevel | null;
  readonly district?: string | null;
  readonly neighborhood?: string | null;
  readonly street?: string | null;
  readonly signal?: AbortSignal | null;
}

export interface NormalizedSearchRequest {
  readonly query: string;
  readonly normalizedQuery: string;
  readonly terms: readonly string[];
  readonly filters: readonly SearchFilter[];
  readonly facetFields: readonly string[];
  readonly sort: SearchSortMode;
  readonly minScore: number;
  readonly offset: number;
  readonly limit: number;
  readonly center: Coordinate | null;
  readonly radiusMeters: number;
  readonly level: AddressLevel | null;
  readonly district: string;
  readonly neighborhood: string;
  readonly street: string;
  readonly signal: AbortSignal | null;
}

export interface SearchHit<TRecord extends NormalizedRecord = NormalizedRecord> {
  readonly record: TRecord;
  readonly score: number;
  readonly distanceMeters: number | null;
  readonly reasons: readonly string[];
}

export interface FacetBucket {
  readonly value: string;
  readonly count: number;
}

export interface SearchResponse<TRecord extends NormalizedRecord = NormalizedRecord> {
  readonly results: readonly SearchHit<TRecord>[];
  readonly page: PageInfo;
  readonly facets: Readonly<Record<string, readonly FacetBucket[]>>;
  readonly diagnostics: SearchDiagnostics;
}

export interface SearchDiagnostics {
  readonly datasetKey: string;
  readonly revision: number;
  readonly totalRecords: number;
  readonly candidateCount: number;
  readonly scoredCount: number;
  readonly filteredCount: number;
  readonly cacheHit: boolean;
  readonly elapsedMs: number;
  readonly querySignature: string;
  readonly quality: DataQualitySummary;
}

export interface TokenPosting {
  readonly token: string;
  readonly positions: readonly number[];
}

export interface CandidatePlan {
  readonly candidatePositions: readonly number[];
  readonly requiredTokens: readonly string[];
  readonly optionalTokens: readonly string[];
  readonly tokenPostings: readonly TokenPosting[];
  readonly strategy: 'all' | 'intersection' | 'union' | 'fallback-scan';
  readonly estimatedCost: number;
}

export interface CandidatePlannerOptions {
  readonly maxPrefixLength?: number;
  readonly maxPrefixPostings?: number;
  readonly maxTokenPostings?: number;
  readonly fallbackScanThreshold?: number;
}

export interface CandidateIndex {
  readonly tokens: ReadonlyMap<string, ReadonlySet<number>>;
  readonly prefixes: ReadonlyMap<string, ReadonlySet<number>>;
  readonly recordCount: number;
  readonly tokenCount: number;
  readonly prefixCount: number;
}

export interface SpatialIndexOptions {
  readonly cellSizeMeters?: number;
  readonly maxCellsPerQuery?: number;
  readonly maxCandidates?: number;
}

export interface SpatialIndex<TRecord extends NormalizedRecord = NormalizedRecord> {
  readonly records: readonly TRecord[];
  readonly buckets: ReadonlyMap<string, readonly number[]>;
  readonly cellSizeDegrees: number;
  readonly geocodedCount: number;
  readonly skippedCount: number;
}

export interface SpatialHit<TRecord extends NormalizedRecord = NormalizedRecord> {
  readonly record: TRecord;
  readonly distanceMeters: number;
}

export interface GeocodeCandidate {
  readonly id: string | null;
  readonly label: string;
  readonly score: number;
  readonly coordinates: Coordinate | null;
  readonly attributes: Readonly<Record<string, unknown>>;
  readonly sourceKind: 'arcgis-candidate' | 'arcgis-feature' | 'reverse-geocode' | 'generic-row';
  readonly sourceIndex: number;
  readonly fingerprint: string;
}

export interface GeocodePage {
  readonly candidates: readonly GeocodeCandidate[];
  readonly page: PageInfo;
  readonly exceededTransferLimit: boolean;
  readonly diagnostics: GeocodeDiagnostics;
}

export interface GeocodeDiagnostics {
  readonly inputKind: string;
  readonly inputCount: number;
  readonly outputCount: number;
  readonly duplicateCount: number;
  readonly invalidCoordinateCount: number;
  readonly malformedCount: number;
}

export interface DatasetSnapshot<TRecord extends NormalizedRecord = NormalizedRecord> {
  readonly key: string;
  readonly revision: number;
  readonly fingerprint: string;
  readonly records: readonly TRecord[];
  readonly quality: DataQualitySummary;
  readonly candidateIndex: CandidateIndex;
  readonly spatialIndex: SpatialIndex<TRecord>;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface RegisterDatasetOptions extends RecordNormalizationOptions {
  readonly now?: number;
}

export interface SearchRuntimeOptions {
  readonly maxDatasets?: number;
  readonly cacheSize?: number;
  readonly defaultLimit?: number;
  readonly maxLimit?: number;
  readonly candidatePlanner?: CandidatePlannerOptions;
  readonly spatial?: SpatialIndexOptions;
  readonly clock?: () => number;
}

export interface SearchRuntimeSnapshot {
  readonly datasetCount: number;
  readonly cacheEntries: number;
  readonly searches: number;
  readonly cacheHits: number;
  readonly cacheMisses: number;
  readonly aborts: number;
  readonly registrations: number;
  readonly replacements: number;
  readonly evictions: number;
}

export const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const isAbortSignal = (value: unknown): value is AbortSignal =>
  isRecord(value) && typeof value.aborted === 'boolean' && typeof value.addEventListener === 'function';

export const createAbortError = (message = 'Data search operation aborted'): Error => {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
};

export const throwIfAborted = (signal: AbortSignal | null | undefined): void => {
  if (signal?.aborted) throw createAbortError();
};

export const assertNever = (value: never, message = 'Unexpected value'): never => {
  throw new Error(`${message}: ${String(value)}`);
};
