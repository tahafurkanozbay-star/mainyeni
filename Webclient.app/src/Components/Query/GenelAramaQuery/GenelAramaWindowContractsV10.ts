import type { NormalizedSearchRecord } from '../_Common/QuerySearchRuntime';

export const GENERAL_SEARCH_WINDOW_VERSION_V10 = 'general-search-window-v10' as const;

export type GeneralSearchSortModeV10 =
  | 'relevance'
  | 'source-order'
  | 'title'
  | 'category'
  | 'address';

export type GeneralSearchFacetKindV10 = 'category' | 'type';

export type GeneralSearchMoveCommandV10 =
  | 'previous'
  | 'next'
  | 'first'
  | 'last'
  | 'page-previous'
  | 'page-next';

export type GeneralSearchGuidanceToneV10 = 'neutral' | 'info' | 'warning' | 'success';

export interface GeneralSearchWindowPolicyV10 {
  readonly maxRecords?: number;
  readonly maxRefinementLength?: number;
  readonly maxFacetBuckets?: number;
  readonly maxSelectedFacets?: number;
  readonly renderWindowSize?: number;
  readonly renderOverscan?: number;
  readonly keyboardPageSize?: number;
  readonly maxHighlightSegments?: number;
  readonly maxAnnouncementLength?: number;
}

export interface GeneralSearchHighlightSegmentV10 {
  readonly text: string;
  readonly matched: boolean;
}

export interface GeneralSearchPresentedRecordV10 {
  readonly identity: string;
  readonly sourceIndex: number;
  readonly record: NormalizedSearchRecord;
  readonly normalizedTitle: string;
  readonly normalizedAddress: string;
  readonly normalizedCategory: string;
  readonly normalizedType: string;
  readonly searchableText: string;
  readonly titleSegments: readonly GeneralSearchHighlightSegmentV10[];
  readonly addressSegments: readonly GeneralSearchHighlightSegmentV10[];
  readonly score: number;
  readonly active: boolean;
}

export interface GeneralSearchFacetBucketV10 {
  readonly kind: GeneralSearchFacetKindV10;
  readonly value: string;
  readonly normalizedValue: string;
  readonly count: number;
  readonly selected: boolean;
  readonly disabled: boolean;
}

export interface GeneralSearchFacetModelV10 {
  readonly kind: GeneralSearchFacetKindV10;
  readonly label: string;
  readonly buckets: readonly GeneralSearchFacetBucketV10[];
  readonly totalBuckets: number;
  readonly truncated: boolean;
}

export interface GeneralSearchRenderWindowV10 {
  readonly startIndex: number;
  readonly endIndexExclusive: number;
  readonly count: number;
  readonly totalMatched: number;
  readonly hasBefore: boolean;
  readonly hasAfter: boolean;
}

export interface GeneralSearchGuidanceV10 {
  readonly tone: GeneralSearchGuidanceToneV10;
  readonly title: string;
  readonly detail: string;
  readonly actionLabel: string | null;
}

export interface GeneralSearchWindowSnapshotV10 {
  readonly version: typeof GENERAL_SEARCH_WINDOW_VERSION_V10;
  readonly revision: number;
  readonly recordsFingerprint: string;
  readonly totalCount: number;
  readonly matchedCount: number;
  readonly refinement: string;
  readonly normalizedRefinement: string;
  readonly selectedCategories: readonly string[];
  readonly selectedTypes: readonly string[];
  readonly sortMode: GeneralSearchSortModeV10;
  readonly activeIdentity: string | null;
  readonly activeIndex: number;
  readonly activeRecord: NormalizedSearchRecord | null;
  readonly items: readonly GeneralSearchPresentedRecordV10[];
  readonly visibleItems: readonly GeneralSearchPresentedRecordV10[];
  readonly facets: readonly GeneralSearchFacetModelV10[];
  readonly renderWindow: GeneralSearchRenderWindowV10;
  readonly guidance: GeneralSearchGuidanceV10;
  readonly announcement: string;
  readonly hasFilters: boolean;
  readonly resultLimitReached: boolean;
  readonly fingerprint: string;
}

export interface GeneralSearchWindowDiagnosticsV10 {
  readonly version: typeof GENERAL_SEARCH_WINDOW_VERSION_V10;
  readonly revision: number;
  readonly sourceRecords: number;
  readonly retainedRecords: number;
  readonly duplicateIdentities: number;
  readonly invalidRecords: number;
  readonly recomputations: number;
  readonly refinementChanges: number;
  readonly facetChanges: number;
  readonly sortChanges: number;
  readonly activeMoves: number;
  readonly windowMoves: number;
  readonly resultLimitReached: boolean;
  readonly fingerprint: string;
}

export interface GeneralSearchNormalizedPolicyV10 {
  readonly maxRecords: number;
  readonly maxRefinementLength: number;
  readonly maxFacetBuckets: number;
  readonly maxSelectedFacets: number;
  readonly renderWindowSize: number;
  readonly renderOverscan: number;
  readonly keyboardPageSize: number;
  readonly maxHighlightSegments: number;
  readonly maxAnnouncementLength: number;
}

export interface GeneralSearchInternalRecordV10 {
  readonly identity: string;
  readonly sourceIndex: number;
  readonly record: NormalizedSearchRecord;
  readonly title: string;
  readonly address: string;
  readonly category: string;
  readonly type: string;
  readonly normalizedTitle: string;
  readonly normalizedAddress: string;
  readonly normalizedCategory: string;
  readonly normalizedType: string;
  readonly normalizedPhone: string;
  readonly normalizedSearchableText: string;
}

export interface GeneralSearchMutableDiagnosticsV10 {
  sourceRecords: number;
  retainedRecords: number;
  duplicateIdentities: number;
  invalidRecords: number;
  recomputations: number;
  refinementChanges: number;
  facetChanges: number;
  sortChanges: number;
  activeMoves: number;
  windowMoves: number;
  resultLimitReached: boolean;
}

export interface GeneralSearchMutableStateV10 {
  revision: number;
  refinement: string;
  selectedCategories: Set<string>;
  selectedTypes: Set<string>;
  sortMode: GeneralSearchSortModeV10;
  activeIdentity: string | null;
  preferredWindowStart: number | null;
}

export interface GeneralSearchKeyboardDecisionV10 {
  readonly handled: boolean;
  readonly command: GeneralSearchMoveCommandV10 | 'activate' | 'clear' | null;
  readonly preventDefault: boolean;
}

export const GENERAL_SEARCH_SORT_LABELS_V10: Readonly<Record<GeneralSearchSortModeV10, string>> = Object.freeze({
  relevance: 'En uygun',
  'source-order': 'Kaynak sırası',
  title: 'Ada göre',
  category: 'Kategoriye göre',
  address: 'Adrese göre',
});

export const GENERAL_SEARCH_FACET_LABELS_V10: Readonly<Record<GeneralSearchFacetKindV10, string>> = Object.freeze({
  category: 'Kategori',
  type: 'Tür',
});

export const GENERAL_SEARCH_SORT_MODES_V10: readonly GeneralSearchSortModeV10[] = Object.freeze([
  'relevance',
  'source-order',
  'title',
  'category',
  'address',
]);

export const GENERAL_SEARCH_MOVE_COMMANDS_V10: readonly GeneralSearchMoveCommandV10[] = Object.freeze([
  'previous',
  'next',
  'first',
  'last',
  'page-previous',
  'page-next',
]);
