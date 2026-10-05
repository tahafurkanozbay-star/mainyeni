import type { SearchRequest } from './contracts';
import {
  hashFingerprint,
  normalizeInteger,
  normalizeSearchText,
  normalizeText,
  stableSerialize,
} from './normalization';
import type {
  SearchExperienceFacetV9,
  SearchExperiencePageModelV9,
  SearchExperiencePaginationV9,
} from './searchExperienceRuntimeV9';
import type { SearchGuidanceActionV9 } from './searchGuidanceRuntimeV9';
import type { SearchResultBadgeV9, SearchResultCardV9 } from './searchResultPresentationRuntimeV9';

export const SEARCH_WORKSPACE_HANDOFF_VERSION_V10 = 'search-workspace-handoff-v10' as const;

export type SearchWorkspaceSurfaceV10 =
  | 'query'
  | 'filters'
  | 'results'
  | 'map'
  | 'details'
  | 'history'
  | 'guidance';

export type SearchWorkspaceStatusV10 =
  | 'ready'
  | 'recovered'
  | 'partial'
  | 'empty'
  | 'blocked';

export type SearchWorkspaceActionKindV10 =
  | 'focus-query'
  | 'focus-filters'
  | 'focus-results'
  | 'focus-map'
  | 'open-details'
  | 'close-details'
  | 'select-result'
  | 'toggle-result'
  | 'clear-selection'
  | 'show-result-on-map'
  | 'previous-page'
  | 'next-page'
  | 'first-page'
  | 'apply-guidance'
  | 'clear-filters'
  | 'clear-spatial'
  | 'clear-address-scope'
  | 'show-all-results'
  | 'use-query'
  | 'repeat-history-query';

export interface SearchWorkspacePolicyV10 {
  readonly maxResults?: number;
  readonly maxFacets?: number;
  readonly maxFacetBuckets?: number;
  readonly maxActions?: number;
  readonly maxBadgesPerResult?: number;
  readonly maxGuidanceActions?: number;
  readonly maxTitleLength?: number;
  readonly maxSubtitleLength?: number;
  readonly maxSnippetLength?: number;
  readonly maxActionLabelLength?: number;
  readonly includeMapActions?: boolean;
  readonly includeDetailsActions?: boolean;
  readonly includePaginationActions?: boolean;
}

export interface SearchWorkspaceDatasetIdentityV10 {
  readonly key: string;
  readonly revision: number;
  readonly fingerprint: string;
}

export interface SearchWorkspaceTextV10 {
  readonly value: string;
  readonly truncated: boolean;
}

export interface SearchWorkspaceBadgeV10 {
  readonly kind: string;
  readonly value: string;
  readonly label: string;
}

export interface SearchWorkspaceResultV10 {
  readonly key: string;
  readonly recordFingerprint: string;
  readonly recordId: string | null;
  readonly sourceIndex: number;
  readonly title: SearchWorkspaceTextV10;
  readonly subtitle: SearchWorkspaceTextV10 | null;
  readonly snippet: SearchWorkspaceTextV10 | null;
  readonly category: string;
  readonly type: string;
  readonly district: string;
  readonly neighborhood: string;
  readonly street: string;
  readonly address: string;
  readonly hasCoordinates: boolean;
  readonly latitude: number | null;
  readonly longitude: number | null;
  readonly distanceMeters: number | null;
  readonly score: number;
  readonly badges: readonly SearchWorkspaceBadgeV10[];
  readonly selected: boolean;
  readonly active: boolean;
  readonly position: number;
  readonly setSize: number;
  readonly label: string;
  readonly description: string;
  readonly canShowOnMap: boolean;
  readonly canOpenDetails: boolean;
  readonly fingerprint: string;
}

export interface SearchWorkspaceFacetBucketV10 {
  readonly value: string;
  readonly count: number;
  readonly label: string;
}

export interface SearchWorkspaceFacetV10 {
  readonly field: string;
  readonly label: string;
  readonly buckets: readonly SearchWorkspaceFacetBucketV10[];
  readonly totalBuckets: number;
  readonly truncated: boolean;
}

export interface SearchWorkspaceActionV10 {
  readonly id: string;
  readonly kind: SearchWorkspaceActionKindV10;
  readonly label: string;
  readonly description: string;
  readonly surface: SearchWorkspaceSurfaceV10;
  readonly enabled: boolean;
  readonly resultKey: string | null;
  readonly query: string | null;
  readonly offset: number | null;
  readonly guidanceActionId: string | null;
  readonly fingerprint: string;
}

export interface SearchWorkspaceStatusModelV10 {
  readonly status: SearchWorkspaceStatusV10;
  readonly severity: 'neutral' | 'success' | 'info' | 'warning' | 'error';
  readonly headline: string;
  readonly message: string;
  readonly announcement: string;
  readonly resultCountText: string;
  readonly blockedReason: string | null;
  readonly recovered: boolean;
}

export interface SearchWorkspacePaginationV10 extends SearchExperiencePaginationV9 {
  readonly currentPage: number;
  readonly pageCount: number;
  readonly label: string;
}

export interface SearchWorkspaceHandoffModelV10 {
  readonly version: typeof SEARCH_WORKSPACE_HANDOFF_VERSION_V10;
  readonly dataset: SearchWorkspaceDatasetIdentityV10;
  readonly requestFingerprint: string;
  readonly request: SearchExperiencePageModelV9['request'];
  readonly status: SearchWorkspaceStatusModelV10;
  readonly results: readonly SearchWorkspaceResultV10[];
  readonly facets: readonly SearchWorkspaceFacetV10[];
  readonly pagination: SearchWorkspacePaginationV10;
  readonly actions: readonly SearchWorkspaceActionV10[];
  readonly activeResultKey: string | null;
  readonly selectedResultKeys: readonly string[];
  readonly resultCount: number;
  readonly totalResultCount: number;
  readonly resultsTruncated: boolean;
  readonly actionsTruncated: boolean;
  readonly hasMappableResults: boolean;
  readonly hasDetails: boolean;
  readonly preferredSurface: SearchWorkspaceSurfaceV10;
  readonly fingerprint: string;
}

export interface SearchWorkspaceHandoffSnapshotV10 {
  readonly version: typeof SEARCH_WORKSPACE_HANDOFF_VERSION_V10;
  readonly modelsBuilt: number;
  readonly resultsBuilt: number;
  readonly actionsBuilt: number;
  readonly truncatedResults: number;
  readonly truncatedActions: number;
  readonly blockedModels: number;
  readonly emptyModels: number;
  readonly recoveredModels: number;
  readonly mappableModels: number;
  readonly lastDatasetKey: string | null;
  readonly lastRequestFingerprint: string | null;
  readonly fingerprint: string;
}

interface NormalizedWorkspacePolicyV10 {
  readonly maxResults: number;
  readonly maxFacets: number;
  readonly maxFacetBuckets: number;
  readonly maxActions: number;
  readonly maxBadgesPerResult: number;
  readonly maxGuidanceActions: number;
  readonly maxTitleLength: number;
  readonly maxSubtitleLength: number;
  readonly maxSnippetLength: number;
  readonly maxActionLabelLength: number;
  readonly includeMapActions: boolean;
  readonly includeDetailsActions: boolean;
  readonly includePaginationActions: boolean;
}

interface MutableHandoffStatsV10 {
  modelsBuilt: number;
  resultsBuilt: number;
  actionsBuilt: number;
  truncatedResults: number;
  truncatedActions: number;
  blockedModels: number;
  emptyModels: number;
  recoveredModels: number;
  mappableModels: number;
  lastDatasetKey: string | null;
  lastRequestFingerprint: string | null;
}

const normalizePolicy = (
  policy: SearchWorkspacePolicyV10 = {},
): NormalizedWorkspacePolicyV10 => Object.freeze({
  maxResults: normalizeInteger(policy.maxResults, { min: 1, max: 2_000, fallback: 250 }),
  maxFacets: normalizeInteger(policy.maxFacets, { min: 0, max: 32, fallback: 12 }),
  maxFacetBuckets: normalizeInteger(policy.maxFacetBuckets, { min: 1, max: 1_000, fallback: 100 }),
  maxActions: normalizeInteger(policy.maxActions, { min: 1, max: 512, fallback: 96 }),
  maxBadgesPerResult: normalizeInteger(policy.maxBadgesPerResult, { min: 0, max: 24, fallback: 8 }),
  maxGuidanceActions: normalizeInteger(policy.maxGuidanceActions, { min: 0, max: 24, fallback: 8 }),
  maxTitleLength: normalizeInteger(policy.maxTitleLength, { min: 16, max: 1_000, fallback: 180 }),
  maxSubtitleLength: normalizeInteger(policy.maxSubtitleLength, { min: 16, max: 2_000, fallback: 260 }),
  maxSnippetLength: normalizeInteger(policy.maxSnippetLength, { min: 32, max: 4_000, fallback: 360 }),
  maxActionLabelLength: normalizeInteger(policy.maxActionLabelLength, { min: 8, max: 240, fallback: 120 }),
  includeMapActions: policy.includeMapActions !== false,
  includeDetailsActions: policy.includeDetailsActions !== false,
  includePaginationActions: policy.includePaginationActions !== false,
});

const boundText = (value: unknown, maximum: number): SearchWorkspaceTextV10 => {
  const text = normalizeText(value);
  if (text.length <= maximum) return Object.freeze({ value: text, truncated: false });
  return Object.freeze({
    value: `${text.slice(0, Math.max(0, maximum - 1)).trimEnd()}…`,
    truncated: true,
  });
};

const boundLabel = (value: unknown, maximum: number): string => {
  const text = normalizeText(value);
  if (text.length <= maximum) return text;
  return `${text.slice(0, Math.max(0, maximum - 1)).trimEnd()}…`;
};

const humanField = (value: unknown): string => {
  const normalized = normalizeSearchText(value);
  if (normalized === 'category') return 'Kategori';
  if (normalized === 'type') return 'Tür';
  if (normalized === 'district') return 'İlçe';
  if (normalized === 'neighborhood') return 'Mahalle';
  if (normalized === 'street') return 'Sokak';
  return normalizeText(value) || 'Filtre';
};

const statusFor = (page: SearchExperiencePageModelV9): SearchWorkspaceStatusModelV10 => {
  const guidance = page.guidance;
  const status: SearchWorkspaceStatusV10 = guidance.status === 'idle'
    ? 'ready'
    : guidance.status === 'success'
      ? 'ready'
      : guidance.status;
  return Object.freeze({
    status,
    severity: guidance.severity,
    headline: normalizeText(guidance.headline),
    message: normalizeText(guidance.message),
    announcement: normalizeText(guidance.announcement),
    resultCountText: normalizeText(guidance.resultCountText),
    blockedReason: guidance.blockedReason === null ? null : normalizeText(guidance.blockedReason),
    recovered: guidance.recovered,
  });
};

const paginationFor = (page: SearchExperiencePaginationV9): SearchWorkspacePaginationV10 => {
  const limit = Math.max(1, Math.trunc(page.limit));
  const offset = Math.max(0, Math.trunc(page.offset));
  const total = Math.max(0, Math.trunc(page.total));
  const currentPage = total === 0 ? 1 : Math.floor(offset / limit) + 1;
  const pageCount = Math.max(1, Math.ceil(total / limit));
  return Object.freeze({
    ...page,
    currentPage,
    pageCount,
    label: `${currentPage}. sayfa / ${pageCount} sayfa`,
  });
};

const badgeFor = (badge: SearchResultBadgeV9): SearchWorkspaceBadgeV10 => Object.freeze({
  kind: normalizeSearchText(badge.kind),
  value: normalizeText(badge.value),
  label: normalizeText(badge.label),
});

const resultDescription = (card: SearchResultCardV9): string => {
  const values = [
    card.subtitle?.value,
    card.snippet?.value,
    card.distanceMeters === null ? '' : `${Math.round(card.distanceMeters)} metre`,
  ].map(normalizeText).filter(Boolean);
  return Array.from(new Set(values)).slice(0, 3).join('. ');
};

const resultLabel = (card: SearchResultCardV9, position: number, setSize: number): string => {
  const prefix = `${position} / ${setSize}`;
  const title = normalizeText(card.title.value) || 'İsimsiz sonuç';
  const district = normalizeText(card.district);
  return district ? `${prefix}. ${title}, ${district}` : `${prefix}. ${title}`;
};

const resultFor = (
  card: SearchResultCardV9,
  page: SearchExperiencePageModelV9,
  position: number,
  setSize: number,
  policy: NormalizedWorkspacePolicyV10,
): SearchWorkspaceResultV10 => {
  const selected = page.selection.selectedKeys.includes(card.key);
  const active = page.selection.activeKey === card.key;
  const badges = Object.freeze(card.badges.slice(0, policy.maxBadgesPerResult).map(badgeFor));
  const result = {
    key: card.key,
    recordFingerprint: card.recordFingerprint,
    recordId: card.recordId,
    sourceIndex: card.sourceIndex,
    title: boundText(card.title.value, policy.maxTitleLength),
    subtitle: card.subtitle ? boundText(card.subtitle.value, policy.maxSubtitleLength) : null,
    snippet: card.snippet ? boundText(card.snippet.value, policy.maxSnippetLength) : null,
    category: normalizeText(card.category),
    type: normalizeText(card.type),
    district: normalizeText(card.district),
    neighborhood: normalizeText(card.neighborhood),
    street: normalizeText(card.street),
    address: normalizeText(card.address),
    hasCoordinates: card.hasCoordinates,
    latitude: card.latitude,
    longitude: card.longitude,
    distanceMeters: card.distanceMeters,
    score: card.score,
    badges,
    selected,
    active,
    position,
    setSize,
    label: resultLabel(card, position, setSize),
    description: resultDescription(card),
    canShowOnMap: policy.includeMapActions && card.hasCoordinates,
    canOpenDetails: policy.includeDetailsActions,
  } satisfies Omit<SearchWorkspaceResultV10, 'fingerprint'>;
  return Object.freeze({
    ...result,
    fingerprint: hashFingerprint(stableSerialize({
      version: SEARCH_WORKSPACE_HANDOFF_VERSION_V10,
      datasetFingerprint: page.datasetFingerprint,
      result,
    })),
  });
};

const facetsFor = (
  facets: readonly SearchExperienceFacetV9[],
  policy: NormalizedWorkspacePolicyV10,
): readonly SearchWorkspaceFacetV10[] => Object.freeze(
  facets.slice(0, policy.maxFacets).map(facet => Object.freeze({
    field: normalizeText(facet.field),
    label: humanField(facet.field),
    buckets: Object.freeze(facet.buckets.slice(0, policy.maxFacetBuckets).map(bucket => Object.freeze({
      value: normalizeText(bucket.value),
      count: Math.max(0, Math.trunc(bucket.count)),
      label: `${normalizeText(bucket.value)} (${Math.max(0, Math.trunc(bucket.count))})`,
    }))),
    totalBuckets: Math.max(0, Math.trunc(facet.totalBuckets)),
    truncated: facet.truncated || facet.buckets.length > policy.maxFacetBuckets,
  })),
);

const actionFingerprint = (
  kind: SearchWorkspaceActionKindV10,
  surface: SearchWorkspaceSurfaceV10,
  resultKey: string | null,
  query: string | null,
  offset: number | null,
  guidanceActionId: string | null,
): string => hashFingerprint(stableSerialize({
  version: SEARCH_WORKSPACE_HANDOFF_VERSION_V10,
  kind,
  surface,
  resultKey,
  query,
  offset,
  guidanceActionId,
}));

const action = (
  kind: SearchWorkspaceActionKindV10,
  label: string,
  description: string,
  surface: SearchWorkspaceSurfaceV10,
  policy: NormalizedWorkspacePolicyV10,
  options: Readonly<{
    enabled?: boolean;
    resultKey?: string | null;
    query?: string | null;
    offset?: number | null;
    guidanceActionId?: string | null;
  }> = {},
): SearchWorkspaceActionV10 => {
  const resultKey = options.resultKey === undefined ? null : normalizeText(options.resultKey) || null;
  const query = options.query === undefined ? null : normalizeText(options.query) || null;
  const offset = options.offset === undefined || options.offset === null
    ? null
    : Math.max(0, Math.trunc(options.offset));
  const guidanceActionId = options.guidanceActionId === undefined
    ? null
    : normalizeText(options.guidanceActionId) || null;
  const fingerprint = actionFingerprint(kind, surface, resultKey, query, offset, guidanceActionId);
  return Object.freeze({
    id: `${kind}:${fingerprint}`,
    kind,
    label: boundLabel(label, policy.maxActionLabelLength),
    description: boundLabel(description, policy.maxActionLabelLength * 2),
    surface,
    enabled: options.enabled !== false,
    resultKey,
    query,
    offset,
    guidanceActionId,
    fingerprint,
  });
};

const guidanceKind = (candidate: SearchGuidanceActionV9): SearchWorkspaceActionKindV10 => {
  if (candidate.kind === 'clear-filters') return 'clear-filters';
  if (candidate.kind === 'clear-spatial') return 'clear-spatial';
  if (candidate.kind === 'clear-address-scope') return 'clear-address-scope';
  if (candidate.kind === 'show-all-results' || candidate.kind === 'reset-query') return 'show-all-results';
  return 'use-query';
};

const guidanceAction = (
  candidate: SearchGuidanceActionV9,
  policy: NormalizedWorkspacePolicyV10,
): SearchWorkspaceActionV10 => action(
  guidanceKind(candidate),
  candidate.label,
  candidate.description,
  'guidance',
  policy,
  {
    query: candidate.query,
    guidanceActionId: candidate.id,
  },
);

const addUniqueAction = (
  output: SearchWorkspaceActionV10[],
  candidate: SearchWorkspaceActionV10,
  maximum: number,
): boolean => {
  if (output.length >= maximum) return false;
  if (output.some(item => item.fingerprint === candidate.fingerprint)) return true;
  output.push(candidate);
  return true;
};

const globalActions = (
  page: SearchExperiencePageModelV9,
  pagination: SearchWorkspacePaginationV10,
  policy: NormalizedWorkspacePolicyV10,
): readonly SearchWorkspaceActionV10[] => {
  const output: SearchWorkspaceActionV10[] = [];
  addUniqueAction(output, action('focus-query', 'Arama kutusuna git', 'Arama sorgusunu düzenlemek için arama alanına odaklanır.', 'query', policy), policy.maxActions);
  if (page.request.filterCount > 0 || page.facets.length > 0) {
    addUniqueAction(output, action('focus-filters', 'Filtrelere git', 'Arama kapsamını daraltan veya genişleten filtrelere odaklanır.', 'filters', policy), policy.maxActions);
  }
  if (page.resultCount > 0) {
    addUniqueAction(output, action('focus-results', 'Sonuçlara git', 'Sonuç listesine veya sonuç tablosuna odaklanır.', 'results', policy), policy.maxActions);
  }
  if (policy.includeMapActions && page.cards.some(card => card.hasCoordinates)) {
    addUniqueAction(output, action('focus-map', 'Haritaya git', 'Harita sonuç yüzeyine odaklanmayı önerir; harita navigasyonunu çalıştırmaz.', 'map', policy), policy.maxActions);
  }
  if (page.selection.selectedKeys.length > 0) {
    addUniqueAction(output, action('clear-selection', 'Seçimi temizle', 'Seçili sonuç kimliklerini temizler.', 'results', policy), policy.maxActions);
  }
  if (policy.includePaginationActions && pagination.hasPrevious && pagination.previousOffset !== null) {
    addUniqueAction(output, action('previous-page', 'Önceki sayfa', 'Bir önceki sonuç sayfasına geçer.', 'results', policy, { offset: pagination.previousOffset }), policy.maxActions);
    addUniqueAction(output, action('first-page', 'İlk sayfa', 'Sonuçların ilk sayfasına döner.', 'results', policy, { offset: 0 }), policy.maxActions);
  }
  if (policy.includePaginationActions && pagination.hasNext && pagination.nextOffset !== null) {
    addUniqueAction(output, action('next-page', 'Sonraki sayfa', 'Bir sonraki sonuç sayfasına geçer.', 'results', policy, { offset: pagination.nextOffset }), policy.maxActions);
  }
  for (const candidate of page.guidance.actions.slice(0, policy.maxGuidanceActions)) {
    if (!addUniqueAction(output, guidanceAction(candidate, policy), policy.maxActions)) break;
  }
  for (const suggestion of page.historySuggestions) {
    if (!addUniqueAction(output, action(
      'repeat-history-query',
      `“${suggestion.query}” aramasını tekrarla`,
      'Daha önce kullanılan sorguyu arama alanına uygular.',
      'history',
      policy,
      { query: suggestion.query },
    ), policy.maxActions)) break;
  }
  return Object.freeze(output);
};

const resultActions = (
  results: readonly SearchWorkspaceResultV10[],
  policy: NormalizedWorkspacePolicyV10,
  currentCount: number,
): readonly SearchWorkspaceActionV10[] => {
  if (currentCount >= policy.maxActions) return Object.freeze([]);
  const output: SearchWorkspaceActionV10[] = [];
  const remaining = policy.maxActions - currentCount;
  for (const result of results) {
    if (output.length >= remaining) break;
    addUniqueAction(output, action(
      result.selected ? 'toggle-result' : 'select-result',
      result.selected ? `${result.title.value} seçimini kaldır` : `${result.title.value} sonucunu seç`,
      'Sonuç kimliğini seçime ekler veya seçimden çıkarır.',
      'results',
      policy,
      { resultKey: result.key },
    ), remaining);
    if (policy.includeDetailsActions && output.length < remaining) {
      addUniqueAction(output, action(
        'open-details',
        `${result.title.value} ayrıntılarını aç`,
        'Sonucun ayrıntı yüzeyinde gösterilmesini ister.',
        'details',
        policy,
        { resultKey: result.key },
      ), remaining);
    }
    if (policy.includeMapActions && result.canShowOnMap && output.length < remaining) {
      addUniqueAction(output, action(
        'show-result-on-map',
        `${result.title.value} sonucunu haritada göster`,
        'Sonuç koordinatının mevcut GIS otoritesine handoff edilmesini ister; navigasyonu kendisi çalıştırmaz.',
        'map',
        policy,
        { resultKey: result.key },
      ), remaining);
    }
  }
  return Object.freeze(output);
};

const preferredSurfaceFor = (
  page: SearchExperiencePageModelV9,
  results: readonly SearchWorkspaceResultV10[],
): SearchWorkspaceSurfaceV10 => {
  if (page.blocked || page.guidance.status === 'empty') return 'guidance';
  if (results.length > 0) return 'results';
  return 'query';
};

const modelFingerprint = (
  page: SearchExperiencePageModelV9,
  results: readonly SearchWorkspaceResultV10[],
  facets: readonly SearchWorkspaceFacetV10[],
  pagination: SearchWorkspacePaginationV10,
  actions: readonly SearchWorkspaceActionV10[],
  status: SearchWorkspaceStatusModelV10,
): string => hashFingerprint(stableSerialize({
  version: SEARCH_WORKSPACE_HANDOFF_VERSION_V10,
  datasetFingerprint: page.datasetFingerprint,
  requestFingerprint: page.requestFingerprint,
  pageFingerprint: page.fingerprint,
  results: results.map(result => result.fingerprint),
  facets,
  pagination,
  actions: actions.map(item => item.fingerprint),
  status,
}));

export class SearchWorkspaceHandoffRuntimeV10 {
  readonly #policy: NormalizedWorkspacePolicyV10;
  readonly #stats: MutableHandoffStatsV10 = {
    modelsBuilt: 0,
    resultsBuilt: 0,
    actionsBuilt: 0,
    truncatedResults: 0,
    truncatedActions: 0,
    blockedModels: 0,
    emptyModels: 0,
    recoveredModels: 0,
    mappableModels: 0,
    lastDatasetKey: null,
    lastRequestFingerprint: null,
  };

  constructor(policy: SearchWorkspacePolicyV10 = {}) {
    this.#policy = normalizePolicy(policy);
  }

  handoff(page: SearchExperiencePageModelV9): SearchWorkspaceHandoffModelV10 {
    if (page.version !== 'search-experience-v9') {
      throw new TypeError('Search workspace v10 requires the canonical v9 search experience model');
    }
    const sourceCards = page.cards;
    const boundedCards = sourceCards.slice(0, this.#policy.maxResults);
    const results = Object.freeze(boundedCards.map((card, index) => resultFor(
      card,
      page,
      index + 1,
      boundedCards.length,
      this.#policy,
    )));
    const facets = facetsFor(page.facets, this.#policy);
    const pagination = paginationFor(page.pagination);
    const status = statusFor(page);
    const globals = globalActions(page, pagination, this.#policy);
    const perResult = resultActions(results, this.#policy, globals.length);
    const actions = Object.freeze([...globals, ...perResult].slice(0, this.#policy.maxActions));
    const resultsTruncated = sourceCards.length > results.length;
    const theoreticalResultActions = results.reduce((count, result) => count
      + 1
      + (this.#policy.includeDetailsActions ? 1 : 0)
      + (this.#policy.includeMapActions && result.canShowOnMap ? 1 : 0), 0);
    const actionsTruncated = globals.length + theoreticalResultActions > actions.length;
    const hasMappableResults = results.some(result => result.canShowOnMap);
    const hasDetails = results.length > 0 && this.#policy.includeDetailsActions;

    this.#stats.modelsBuilt += 1;
    this.#stats.resultsBuilt += results.length;
    this.#stats.actionsBuilt += actions.length;
    if (resultsTruncated) this.#stats.truncatedResults += sourceCards.length - results.length;
    if (actionsTruncated) this.#stats.truncatedActions += 1;
    if (page.blocked) this.#stats.blockedModels += 1;
    if (!page.blocked && results.length === 0) this.#stats.emptyModels += 1;
    if (page.recovered) this.#stats.recoveredModels += 1;
    if (hasMappableResults) this.#stats.mappableModels += 1;
    this.#stats.lastDatasetKey = page.datasetKey;
    this.#stats.lastRequestFingerprint = page.requestFingerprint;

    return Object.freeze({
      version: SEARCH_WORKSPACE_HANDOFF_VERSION_V10,
      dataset: Object.freeze({
        key: page.datasetKey,
        revision: page.datasetRevision,
        fingerprint: page.datasetFingerprint,
      }),
      requestFingerprint: page.requestFingerprint,
      request: page.request,
      status,
      results,
      facets,
      pagination,
      actions,
      activeResultKey: page.selection.activeKey,
      selectedResultKeys: Object.freeze([...page.selection.selectedKeys]),
      resultCount: results.length,
      totalResultCount: page.totalResultCount,
      resultsTruncated,
      actionsTruncated,
      hasMappableResults,
      hasDetails,
      preferredSurface: preferredSurfaceFor(page, results),
      fingerprint: modelFingerprint(page, results, facets, pagination, actions, status),
    });
  }

  requestPatchForAction(
    request: SearchRequest,
    page: SearchExperiencePageModelV9,
    actionInput: SearchWorkspaceActionV10,
  ): SearchRequest {
    const actionModel = actionInput;
    const guidance = actionModel.guidanceActionId
      ? page.guidance.actions.find(item => item.id === actionModel.guidanceActionId) ?? null
      : null;
    if (guidance) {
      const next: SearchRequest = {
        ...request,
        ...(guidance.query === null ? {} : { query: guidance.query }),
        ...(guidance.clearFilters ? { filters: [] } : {}),
        ...(guidance.clearSpatial ? { center: null, radiusMeters: 0 } : {}),
        ...(guidance.clearAddressScope
          ? { level: null, district: null, neighborhood: null, street: null }
          : {}),
        ...(guidance.resetOffset ? { offset: 0 } : {}),
      };
      return Object.freeze(next);
    }
    if (actionModel.kind === 'previous-page'
      || actionModel.kind === 'next-page'
      || actionModel.kind === 'first-page') {
      return Object.freeze({ ...request, offset: actionModel.offset ?? 0 });
    }
    if ((actionModel.kind === 'use-query' || actionModel.kind === 'repeat-history-query')
      && actionModel.query !== null) {
      return Object.freeze({ ...request, query: actionModel.query, offset: 0 });
    }
    if (actionModel.kind === 'clear-filters') return Object.freeze({ ...request, filters: [], offset: 0 });
    if (actionModel.kind === 'clear-spatial') return Object.freeze({ ...request, center: null, radiusMeters: 0, offset: 0 });
    if (actionModel.kind === 'clear-address-scope') {
      return Object.freeze({
        ...request,
        level: null,
        district: null,
        neighborhood: null,
        street: null,
        offset: 0,
      });
    }
    if (actionModel.kind === 'show-all-results') {
      return Object.freeze({
        ...request,
        query: '',
        filters: [],
        center: null,
        radiusMeters: 0,
        level: null,
        district: null,
        neighborhood: null,
        street: null,
        offset: 0,
      });
    }
    return Object.freeze({ ...request });
  }

  snapshot(): SearchWorkspaceHandoffSnapshotV10 {
    const fingerprint = hashFingerprint(stableSerialize({
      version: SEARCH_WORKSPACE_HANDOFF_VERSION_V10,
      stats: this.#stats,
    }));
    return Object.freeze({
      version: SEARCH_WORKSPACE_HANDOFF_VERSION_V10,
      ...this.#stats,
      fingerprint,
    });
  }
}

export const createSearchWorkspaceHandoffRuntimeV10 = (
  policy: SearchWorkspacePolicyV10 = {},
): SearchWorkspaceHandoffRuntimeV10 => new SearchWorkspaceHandoffRuntimeV10(policy);
