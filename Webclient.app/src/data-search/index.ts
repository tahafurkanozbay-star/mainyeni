export type {
  AddressEvidence,
  AddressLevel,
  AddressQueryAnalysis,
  AddressQueryOptions,
  AddressScore,
  AddressSemanticFields,
  AddressTokenClass,
  AddressTokenDescriptor,
  AddressTokenMatch,
  CandidateIndex,
  CandidatePlan,
  CandidatePlannerOptions,
  Coordinate,
  DataQualityIssue,
  DataQualitySummary,
  DatasetSnapshot,
  FacetBucket,
  FilterOperator,
  GeocodeCandidate,
  GeocodeDiagnostics,
  GeocodePage,
  NormalizedRecord,
  NormalizedSearchRequest,
  Page,
  PageInfo,
  PaginationRequest,
  RecordAliasSchema,
  RecordNormalizationOptions,
  RecordNormalizationResult,
  RegisterDatasetOptions,
  SearchDiagnostics,
  SearchFilter,
  SearchHit,
  SearchRequest,
  SearchResponse,
  SearchRuntimeOptions,
  SearchRuntimeSnapshot,
  SearchSortMode,
  SpatialBounds,
  SpatialHit,
  SpatialIndex,
  SpatialIndexOptions,
} from './contracts';

export type {
  IconCoverageReport,
  SearchPresentationModel,
  Shared3DModel,
  SharedIconModel,
  SharedMarkerModel,
} from './presentationAdapter';

export {
  assertNever,
  createAbortError,
  isAbortSignal,
  isRecord,
  throwIfAborted,
} from './contracts';

export {
  DEFAULT_LOCALE,
  DEFAULT_MAX_RECORDS,
  HARD_MAX_RECORDS,
  DEFAULT_RECORD_SCHEMA,
  buildFacetCounts,
  compileRecordSchema,
  createDatasetFingerprint,
  createPageInfo,
  getRecordSources,
  hashFingerprint,
  normalizeCategoryKey,
  normalizeCoordinateAxis,
  normalizeCoordinates,
  normalizeId,
  normalizeInteger,
  normalizePhone,
  normalizePostalCode,
  normalizeRecord,
  normalizeRecordCollection,
  normalizeSearchText,
  normalizeSearchToken,
  normalizeText,
  normalizeUrl,
  readAliasedValue,
  stableSerialize,
  tokenizeSearchText,
} from './normalization';

export {
  ADDRESS_BUILDING_TOKENS,
  ADDRESS_LEVELS,
  ADDRESS_LOCALITY_TOKENS,
  ADDRESS_QUERY_VERSION,
  ADDRESS_ROAD_TOKENS,
  ADDRESS_STRUCTURE_TOKENS,
  ADDRESS_TOKEN_ALIASES,
  addressTokensForCandidatePlanning,
  analyzeAddressQuery,
  canonicalAddressRecordTokens,
  canonicalizeAddressText,
  canonicalizeAddressToken,
  canonicalizeAddressTokens,
  classifyAddressToken,
  createAddressSemanticFields,
  createAddressSuggestions,
  createAddressTokenDescriptor,
  evaluateAddressEvidence,
  findBestAddressTokenMatch,
  inferAddressQueryLevel,
  matchesAddressHierarchy,
  normalizeAddressSemanticText,
  normalizeDoorToken,
  parseAddressNumberToken,
  scoreAddressRecord,
  scoreAddressSemanticField,
  scoreSemanticToken,
  tokenizeAddressSemanticText,
} from './addressSemantics';

export {
  DEFAULT_FALLBACK_SCAN_THRESHOLD,
  DEFAULT_MAX_PREFIX_LENGTH,
  DEFAULT_MAX_PREFIX_POSTINGS,
  DEFAULT_MAX_TOKEN_POSTINGS,
  buildCandidateIndex,
  candidateIndexDiagnostics,
  planCandidates,
  validateCandidatePlan,
} from './candidatePlanner';

export {
  DEFAULT_CELL_SIZE_METERS,
  DEFAULT_MAX_CELLS_PER_QUERY,
  DEFAULT_MAX_SPATIAL_CANDIDATES,
  EARTH_RADIUS_METERS,
  buildSpatialIndex,
  collectSpatialCandidatePositions,
  createSpatialBounds,
  haversineDistanceMeters,
  isCoordinateInsideBounds,
  nearest,
  searchRadius,
  spatialIndexDiagnostics,
  validateSpatialIndex,
} from './spatialIndex';

export {
  adaptGeocodingPayload,
  geocodeCandidateToRecordSource,
  geocodingPayloadDiagnostics,
  isProjectedCoordinateCandidate,
  mergeGeocodePages,
} from './geocodingAdapter';

export {
  DEFAULT_CACHE_SIZE,
  DEFAULT_MAX_DATASETS,
  DEFAULT_MAX_SEARCH_LIMIT,
  DEFAULT_SEARCH_LIMIT,
  DataSearchRuntime,
  createDataSearchRuntime,
  matchesFilter,
  normalizeSearchRequest,
} from './searchRuntime';

export {
  createIconCoverageReport,
  createRecordPresentation,
  createSearchHitPresentation,
  createSearchPresentations,
} from './presentationAdapter';

// Production v2 layers. Kept in the same strict TypeScript boundary so legacy
// JavaScript callers can continue to use DataSearchNextRuntime while new code
// adopts typed imports directly.
export * from './schemaEvolution';
export * from './dataIntegrity';
export * from './cursorPagination';
export * from './queryPlanRuntime';
export * from './datasetCatalog';
export * from './geocodingRuntime';
export * from './searchSession';
export * from './searchObservability';
export * from './productionRuntime';

export * from './runtimeReadiness';

// Production v3 governance and federated-data layers. These remain transport
// agnostic: callers inject source adapters, while this boundary owns request
// complexity, workload admission, transactional data integrity and replica
// reconciliation without introducing new network endpoints.
export * from './searchRequestPolicy';
export * from './searchWorkloadGovernor';
export * from './federatedSearchRuntime';
export * from './datasetDeltaRuntime';
export * from './searchReplicaReconciler';

// Production v4 address authority. These layers remain provider-neutral and
// endpoint-free: hierarchy, confidence, provider consensus and race-safe
// resolution are composed over verified local records and injected adapters.
export * from './addressHierarchyRuntime';
export * from './addressConfidenceRuntime';
export * from './geocodingConsensusRuntime';
export * from './addressResolutionSession';

// Production v5 data-governance layers. These extend the existing strict
// TypeScript authority with canonical category semantics, indexed filter
// planning, versioned schema admission, revision-safe caching and deterministic
// spatial keyset pagination. They remain endpoint-free and preserve the shared
// GIS icon resolver as the single presentation authority.
export * from './categoryOntologyRuntime';
export * from './filterIndexRuntime';
export * from './schemaRegistryRuntime';
export * from './revisionedSearchCache';
export * from './spatialCursorRuntime';
export * from './dataSearchGovernanceRuntime';

// Production v6 text-search execution. Existing normalization/filter/schema
// authorities remain canonical; this layer adds bounded query semantics,
// deterministic relevance scoring, faceting/autocomplete, revision-bound
// keyset cursors and atomic corpus refresh without adding a network transport.
export * from './textQueryAnalysisRuntime';
export * from './relevanceIndexRuntime';
export * from './facetAggregationRuntime';
export * from './searchSuggestionRuntime';
export * from './relevanceCursorRuntime';
export * from './dataSearchQueryEngineV6';
export * from './searchCorpusRuntimeV6';

// Production v7 unified local execution. This compatibility layer does not
// replace the existing authorities: it recognizes safe coordinate literals,
// classifies text/address/spatial intent, composes the v1 candidate/spatial
// indexes + v4 address semantics + v6 relevance engine, and reuses the v5
// revision-bound cache plus the existing SearchSession cancellation/debounce
// authority. No network or alternate presentation/icon path is introduced.
export * from './coordinateQueryRuntimeV7';
export * from './searchIntentRuntimeV7';
export * from './dataSearchExecutionRuntimeV7';
export * from './dataSearchExecutionRegistryV7';
