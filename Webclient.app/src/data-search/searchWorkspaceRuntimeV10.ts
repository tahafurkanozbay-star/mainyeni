import type {
  Coordinate,
  SearchFilter,
  SearchRequest,
  SearchSortMode,
} from './contracts';
import {
  hashFingerprint,
  normalizeInteger,
  normalizeSearchText,
  normalizeText,
  stableSerialize,
} from './normalization';
import {
  SearchExperienceRuntimeV9,
  type SearchExperiencePageModelV9,
  type SearchExperienceSearchOptionsV9,
} from './searchExperienceRuntimeV9';
import type { SearchGuidanceActionV9 } from './searchGuidanceRuntimeV9';
import type { SearchGroupingModeV9 } from './searchGroupingRuntimeV9';
import type { SearchSelectionSnapshotV9 } from './searchSelectionRuntimeV9';
import {
  SearchFilterDraftRuntimeV10,
  type SearchFilterDraftPolicyV10,
  type SearchFilterDraftSnapshotV10,
} from './searchFilterDraftRuntimeV10';
import {
  decodeSearchRouteStateV10,
  encodeSearchRouteStateV10,
  type SearchRouteDecodeDiagnosticsV10,
  type SearchRouteStatePolicyV10,
} from './searchRouteStateRuntimeV10';
import {
  SearchViewportRuntimeV10,
  type SearchViewportPolicyV10,
  type SearchViewportSnapshotV10,
} from './searchViewportRuntimeV10';

export const SEARCH_WORKSPACE_VERSION_V10 = 'search-workspace-v10' as const;

export type SearchWorkspacePhaseV10 = 'idle' | 'ready' | 'empty' | 'blocked';

export interface SearchWorkspacePolicyV10 {
  readonly route?: SearchRouteStatePolicyV10;
  readonly filters?: SearchFilterDraftPolicyV10;
  readonly viewport?: SearchViewportPolicyV10;
  readonly search?: SearchExperienceSearchOptionsV9;
  readonly defaultLimit?: number;
  readonly maximumLimit?: number;
  readonly defaultGrouping?: SearchGroupingModeV9;
  readonly maximumQueryLength?: number;
  readonly maximumFacetFields?: number;
}

export interface SearchWorkspaceActivationV10 {
  readonly kind: 'none' | 'focus-map' | 'open-details';
  readonly key: string | null;
  readonly recordId: string | null;
  readonly datasetKey: string;
  readonly datasetRevision: number | null;
  readonly datasetFingerprint: string | null;
  readonly coordinates: Coordinate | null;
  readonly title: string;
  readonly reason: 'no-active-result' | 'has-coordinates' | 'record-details';
}

export interface SearchWorkspaceSnapshotV10 {
  readonly version: typeof SEARCH_WORKSPACE_VERSION_V10;
  readonly phase: SearchWorkspacePhaseV10;
  readonly datasetKey: string;
  readonly request: SearchRequest;
  readonly grouping: SearchGroupingModeV9;
  readonly route: string;
  readonly routeDiagnostics: SearchRouteDecodeDiagnosticsV10 | null;
  readonly filters: SearchFilterDraftSnapshotV10;
  readonly model: SearchExperiencePageModelV9 | null;
  readonly viewport: SearchViewportSnapshotV10;
  readonly activation: SearchWorkspaceActivationV10;
  readonly dirtyFilters: boolean;
  readonly hasResults: boolean;
  readonly hasPreviousPage: boolean;
  readonly hasNextPage: boolean;
  readonly canClear: boolean;
  readonly canSearch: boolean;
  readonly searches: number;
  readonly routeHydrations: number;
  readonly pageChanges: number;
  readonly filterApplications: number;
  readonly selectionChanges: number;
  readonly fingerprint: string;
}

interface NormalizedWorkspacePolicyV10 {
  readonly route: SearchRouteStatePolicyV10;
  readonly filters: SearchFilterDraftPolicyV10;
  readonly viewport: SearchViewportPolicyV10;
  readonly search: SearchExperienceSearchOptionsV9;
  readonly defaultLimit: number;
  readonly maximumLimit: number;
  readonly defaultGrouping: SearchGroupingModeV9;
  readonly maximumQueryLength: number;
  readonly maximumFacetFields: number;
}

interface MutableWorkspaceStatsV10 {
  searches: number;
  routeHydrations: number;
  pageChanges: number;
  filterApplications: number;
  selectionChanges: number;
}

const GROUPINGS = new Set<SearchGroupingModeV9>([
  'none',
  'category',
  'type',
  'district',
  'neighborhood',
  'distance',
]);

const SORTS = new Set<SearchSortMode>(['relevance', 'distance', 'title', 'source-order']);

const normalizeGrouping = (value: unknown): SearchGroupingModeV9 => {
  const normalized = normalizeSearchText(value) as SearchGroupingModeV9;
  return GROUPINGS.has(normalized) ? normalized : 'none';
};

const normalizeSort = (value: unknown): SearchSortMode => {
  const normalized = normalizeSearchText(value) as SearchSortMode;
  return SORTS.has(normalized) ? normalized : 'relevance';
};

const normalizePolicy = (
  policy: SearchWorkspacePolicyV10 = {},
): NormalizedWorkspacePolicyV10 => {
  const maximumLimit = normalizeInteger(policy.maximumLimit, { min: 1, max: 2_000, fallback: 250 });
  return Object.freeze({
    route: Object.freeze({ ...policy.route }),
    filters: Object.freeze({ ...policy.filters }),
    viewport: Object.freeze({ ...policy.viewport }),
    search: Object.freeze({ ...policy.search }),
    defaultLimit: normalizeInteger(policy.defaultLimit, {
      min: 1,
      max: maximumLimit,
      fallback: Math.min(50, maximumLimit),
    }),
    maximumLimit,
    defaultGrouping: normalizeGrouping(policy.defaultGrouping),
    maximumQueryLength: normalizeInteger(policy.maximumQueryLength, { min: 32, max: 4_096, fallback: 512 }),
    maximumFacetFields: normalizeInteger(policy.maximumFacetFields, { min: 0, max: 64, fallback: 12 }),
  });
};

const normalizeDatasetKey = (value: unknown): string => normalizeSearchText(value)
  .replace(/[^a-z0-9_-]+/g, '-')
  .replace(/^-+|-+$/g, '')
  .slice(0, 160);

const immutableRequest = (
  request: SearchRequest,
  policy: NormalizedWorkspacePolicyV10,
): SearchRequest => {
  const query = normalizeText(request.query).slice(0, policy.maximumQueryLength);
  const limit = normalizeInteger(request.limit, {
    min: 1,
    max: policy.maximumLimit,
    fallback: policy.defaultLimit,
  });
  const offset = normalizeInteger(request.offset, { min: 0, max: 10_000_000, fallback: 0 });
  const facets = Array.from(new Set((request.facetFields ?? [])
    .map(normalizeText)
    .filter(Boolean)))
    .slice(0, policy.maximumFacetFields);
  return Object.freeze({
    ...request,
    ...(query ? { query } : { query: '' }),
    ...(request.filters ? { filters: Object.freeze([...request.filters]) } : {}),
    ...(facets.length ? { facetFields: Object.freeze(facets) } : { facetFields: Object.freeze([]) }),
    sort: normalizeSort(request.sort),
    offset,
    limit,
    signal: null,
  });
};

const updateRequest = (
  request: SearchRequest,
  patch: Partial<SearchRequest>,
  policy: NormalizedWorkspacePolicyV10,
): SearchRequest => immutableRequest({ ...request, ...patch }, policy);

const phaseFor = (model: SearchExperiencePageModelV9 | null): SearchWorkspacePhaseV10 => {
  if (!model) return 'idle';
  if (model.blocked) return 'blocked';
  return model.cards.length ? 'ready' : 'empty';
};

const requestHasState = (request: SearchRequest): boolean => Boolean(
  normalizeText(request.query)
  || (request.filters?.length ?? 0) > 0
  || (request.facetFields?.length ?? 0) > 0
  || request.center
  || request.level
  || normalizeText(request.district)
  || normalizeText(request.neighborhood)
  || normalizeText(request.street)
  || normalizeSearchText(request.sort) && normalizeSearchText(request.sort) !== 'relevance'
  || (Number(request.offset) || 0) > 0,
);

const activationFromModel = (
  datasetKey: string,
  model: SearchExperiencePageModelV9 | null,
): SearchWorkspaceActivationV10 => {
  const activeKey = model?.selection.activeKey ?? null;
  const card = activeKey ? model?.cards.find(candidate => candidate.key === activeKey) ?? null : null;
  if (!model || !card) {
    return Object.freeze({
      kind: 'none',
      key: null,
      recordId: null,
      datasetKey,
      datasetRevision: model?.datasetRevision ?? null,
      datasetFingerprint: model?.datasetFingerprint ?? null,
      coordinates: null,
      title: '',
      reason: 'no-active-result',
    });
  }
  const coordinates = card.latitude !== null && card.longitude !== null
    ? Object.freeze({ latitude: card.latitude, longitude: card.longitude })
    : null;
  return Object.freeze({
    kind: coordinates ? 'focus-map' : 'open-details',
    key: card.key,
    recordId: card.recordId,
    datasetKey,
    datasetRevision: model.datasetRevision,
    datasetFingerprint: model.datasetFingerprint,
    coordinates,
    title: card.title.value,
    reason: coordinates ? 'has-coordinates' : 'record-details',
  });
};

export class SearchWorkspaceRuntimeV10 {
  readonly #runtime: SearchExperienceRuntimeV9;
  readonly #policy: NormalizedWorkspacePolicyV10;
  readonly #filters: SearchFilterDraftRuntimeV10;
  readonly #viewport: SearchViewportRuntimeV10;
  readonly #stats: MutableWorkspaceStatsV10 = {
    searches: 0,
    routeHydrations: 0,
    pageChanges: 0,
    filterApplications: 0,
    selectionChanges: 0,
  };
  #datasetKey: string;
  #request: SearchRequest;
  #grouping: SearchGroupingModeV9;
  #model: SearchExperiencePageModelV9 | null = null;
  #routeDiagnostics: SearchRouteDecodeDiagnosticsV10 | null = null;

  constructor(
    runtime: SearchExperienceRuntimeV9,
    datasetKeyInput: unknown,
    initialRequest: SearchRequest = {},
    policyInput: SearchWorkspacePolicyV10 = {},
  ) {
    if (!(runtime instanceof SearchExperienceRuntimeV9)) {
      throw new TypeError('SearchWorkspaceRuntimeV10 requires SearchExperienceRuntimeV9');
    }
    this.#runtime = runtime;
    this.#policy = normalizePolicy(policyInput);
    this.#datasetKey = normalizeDatasetKey(datasetKeyInput);
    if (!this.#datasetKey) throw new TypeError('Search workspace dataset key is required');
    this.#request = immutableRequest(initialRequest, this.#policy);
    this.#grouping = this.#policy.defaultGrouping;
    this.#filters = new SearchFilterDraftRuntimeV10(this.#request.filters ?? [], this.#policy.filters);
    this.#viewport = new SearchViewportRuntimeV10(this.#policy.viewport);
  }

  datasetKey(): string {
    return this.#datasetKey;
  }

  request(): SearchRequest {
    return this.#request;
  }

  grouping(): SearchGroupingModeV9 {
    return this.#grouping;
  }

  model(): SearchExperiencePageModelV9 | null {
    return this.#model;
  }

  setDataset(datasetKeyInput: unknown, reset = true): SearchWorkspaceSnapshotV10 {
    const datasetKey = normalizeDatasetKey(datasetKeyInput);
    if (!datasetKey) return this.snapshot();
    if (datasetKey === this.#datasetKey) return this.snapshot();
    this.#datasetKey = datasetKey;
    this.#model = null;
    this.#routeDiagnostics = null;
    if (reset) {
      this.#request = immutableRequest({}, this.#policy);
      this.#grouping = this.#policy.defaultGrouping;
      this.#filters.reset([]);
      this.#viewport.setResults([]);
    }
    return this.snapshot();
  }

  setQuery(queryInput: unknown): SearchWorkspaceSnapshotV10 {
    const query = normalizeText(queryInput).slice(0, this.#policy.maximumQueryLength);
    this.#request = updateRequest(this.#request, { query, offset: 0 }, this.#policy);
    return this.snapshot();
  }

  setSort(sortInput: unknown): SearchWorkspaceSnapshotV10 {
    this.#request = updateRequest(this.#request, {
      sort: normalizeSort(sortInput),
      offset: 0,
    }, this.#policy);
    return this.snapshot();
  }

  setGrouping(groupingInput: unknown): SearchWorkspaceSnapshotV10 {
    this.#grouping = normalizeGrouping(groupingInput);
    return this.snapshot();
  }

  setFacetFields(fields: readonly string[]): SearchWorkspaceSnapshotV10 {
    const facets = Array.from(new Set(fields.map(normalizeText).filter(Boolean)))
      .slice(0, this.#policy.maximumFacetFields);
    this.#request = updateRequest(this.#request, {
      facetFields: Object.freeze(facets),
      offset: 0,
    }, this.#policy);
    return this.snapshot();
  }

  setSpatial(center: Coordinate | readonly [number, number] | null, radiusMeters?: number): SearchWorkspaceSnapshotV10 {
    this.#request = updateRequest(this.#request, {
      center,
      ...(radiusMeters === undefined ? {} : { radiusMeters }),
      offset: 0,
    }, this.#policy);
    return this.snapshot();
  }

  clearSpatial(): SearchWorkspaceSnapshotV10 {
    this.#request = updateRequest(this.#request, {
      center: null,
      radiusMeters: 0,
      offset: 0,
    }, this.#policy);
    return this.snapshot();
  }

  setAddressScope(scope: Readonly<{
    level?: SearchRequest['level'];
    district?: string | null;
    neighborhood?: string | null;
    street?: string | null;
  }>): SearchWorkspaceSnapshotV10 {
    this.#request = updateRequest(this.#request, {
      ...(scope.level === undefined ? {} : { level: scope.level }),
      ...(scope.district === undefined ? {} : { district: scope.district }),
      ...(scope.neighborhood === undefined ? {} : { neighborhood: scope.neighborhood }),
      ...(scope.street === undefined ? {} : { street: scope.street }),
      offset: 0,
    }, this.#policy);
    return this.snapshot();
  }

  clearAddressScope(): SearchWorkspaceSnapshotV10 {
    this.#request = updateRequest(this.#request, {
      level: null,
      district: '',
      neighborhood: '',
      street: '',
      offset: 0,
    }, this.#policy);
    return this.snapshot();
  }

  replaceFilterDraft(filters: readonly SearchFilter[]): SearchWorkspaceSnapshotV10 {
    this.#filters.replace(filters);
    return this.snapshot();
  }

  toggleFacetValue(field: unknown, value: unknown): SearchWorkspaceSnapshotV10 {
    this.#filters.toggleFacetValue(field, value);
    return this.snapshot();
  }

  setFilterRange(field: unknown, minimum: unknown, maximum: unknown): SearchWorkspaceSnapshotV10 {
    this.#filters.setRange(field, minimum, maximum);
    return this.snapshot();
  }

  removeFilter(field: unknown, operator?: unknown): SearchWorkspaceSnapshotV10 {
    this.#filters.remove(field, operator);
    return this.snapshot();
  }

  clearFilterDraft(): SearchWorkspaceSnapshotV10 {
    this.#filters.clear();
    return this.snapshot();
  }

  undoFilterDraft(): SearchWorkspaceSnapshotV10 {
    this.#filters.undo();
    return this.snapshot();
  }

  redoFilterDraft(): SearchWorkspaceSnapshotV10 {
    this.#filters.redo();
    return this.snapshot();
  }

  applyFilters(): SearchWorkspaceSnapshotV10 {
    const applied = this.#filters.apply();
    if (!applied.valid || applied.dirty) return this.snapshot();
    this.#request = updateRequest(this.#request, {
      filters: applied.applied,
      offset: 0,
    }, this.#policy);
    this.#stats.filterApplications += 1;
    return this.snapshot();
  }

  revertFilters(): SearchWorkspaceSnapshotV10 {
    this.#filters.revert();
    return this.snapshot();
  }

  clearAll(): SearchWorkspaceSnapshotV10 {
    this.#request = immutableRequest({}, this.#policy);
    this.#grouping = this.#policy.defaultGrouping;
    this.#filters.reset([]);
    this.#model = null;
    this.#routeDiagnostics = null;
    this.#viewport.setResults([]);
    return this.snapshot();
  }

  hydrateRoute(route: unknown): SearchWorkspaceSnapshotV10 {
    const decoded = decodeSearchRouteStateV10(route, this.#policy.route);
    if (decoded.state.datasetKey) this.#datasetKey = decoded.state.datasetKey;
    this.#request = immutableRequest(decoded.state.request, this.#policy);
    this.#grouping = normalizeGrouping(decoded.state.grouping);
    this.#filters.reset(this.#request.filters ?? []);
    this.#model = null;
    this.#routeDiagnostics = decoded.diagnostics;
    this.#viewport.setResults([]);
    this.#stats.routeHydrations += 1;
    return this.snapshot();
  }

  execute(options: SearchExperienceSearchOptionsV9 = {}): SearchWorkspaceSnapshotV10 {
    const model = this.#runtime.search(this.#datasetKey, this.#request, {
      ...this.#policy.search,
      ...options,
      grouping: options.grouping ?? this.#grouping,
    });
    this.#model = model;
    this.#stats.searches += 1;
    this.#synchronizeViewport(model.selection);
    return this.snapshot();
  }

  applyGuidance(action: SearchGuidanceActionV9): SearchWorkspaceSnapshotV10 {
    this.#request = immutableRequest(this.#runtime.applyAction(this.#request, action), this.#policy);
    this.#filters.reset(this.#request.filters ?? []);
    return this.snapshot();
  }

  previousPage(): SearchWorkspaceSnapshotV10 {
    const previous = this.#model?.pagination.previousOffset ?? null;
    if (previous === null) return this.snapshot();
    this.#request = updateRequest(this.#request, { offset: previous }, this.#policy);
    this.#stats.pageChanges += 1;
    return this.snapshot();
  }

  nextPage(): SearchWorkspaceSnapshotV10 {
    const next = this.#model?.pagination.nextOffset ?? null;
    if (next === null) return this.snapshot();
    this.#request = updateRequest(this.#request, { offset: next }, this.#policy);
    this.#stats.pageChanges += 1;
    return this.snapshot();
  }

  setPageSize(limitInput: unknown): SearchWorkspaceSnapshotV10 {
    const limit = normalizeInteger(limitInput, {
      min: 1,
      max: this.#policy.maximumLimit,
      fallback: this.#policy.defaultLimit,
    });
    this.#request = updateRequest(this.#request, { limit, offset: 0 }, this.#policy);
    this.#stats.pageChanges += 1;
    return this.snapshot();
  }

  #synchronizeViewport(selection?: SearchSelectionSnapshotV9): void {
    const model = this.#model;
    if (!model) {
      this.#viewport.setResults([]);
      return;
    }
    const actualSelection = selection ?? model.selection;
    this.#viewport.setResults(model.cards, {
      activeKey: actualSelection.activeKey,
      selectedKeys: actualSelection.selectedKeys,
      preserveStart: true,
    });
  }

  #selectionChanged(selection: SearchSelectionSnapshotV9): SearchWorkspaceSnapshotV10 {
    this.#stats.selectionChanges += 1;
    if (this.#model) {
      this.#model = Object.freeze({ ...this.#model, selection });
      this.#synchronizeViewport(selection);
    }
    return this.snapshot();
  }

  setActive(key: unknown): SearchWorkspaceSnapshotV10 {
    return this.#selectionChanged(this.#runtime.setActive(key));
  }

  select(key?: unknown): SearchWorkspaceSnapshotV10 {
    return this.#selectionChanged(this.#runtime.select(key));
  }

  toggleSelection(key?: unknown): SearchWorkspaceSnapshotV10 {
    return this.#selectionChanged(this.#runtime.toggleSelection(key));
  }

  nextResult(): SearchWorkspaceSnapshotV10 {
    return this.#selectionChanged(this.#runtime.next());
  }

  previousResult(): SearchWorkspaceSnapshotV10 {
    return this.#selectionChanged(this.#runtime.previous());
  }

  pageNextResult(): SearchWorkspaceSnapshotV10 {
    return this.#selectionChanged(this.#runtime.pageNext());
  }

  pagePreviousResult(): SearchWorkspaceSnapshotV10 {
    return this.#selectionChanged(this.#runtime.pagePrevious());
  }

  firstResult(): SearchWorkspaceSnapshotV10 {
    return this.#selectionChanged(this.#runtime.first());
  }

  lastResult(): SearchWorkspaceSnapshotV10 {
    return this.#selectionChanged(this.#runtime.last());
  }

  clearSelection(): SearchWorkspaceSnapshotV10 {
    return this.#selectionChanged(this.#runtime.clearSelection());
  }

  setViewportStart(start: unknown): SearchWorkspaceSnapshotV10 {
    this.#viewport.setStart(start);
    return this.snapshot();
  }

  route(): string {
    return encodeSearchRouteStateV10({
      datasetKey: this.#datasetKey,
      request: this.#request,
      grouping: this.#grouping,
    }, this.#policy.route);
  }

  activation(): SearchWorkspaceActivationV10 {
    return activationFromModel(this.#datasetKey, this.#model);
  }

  snapshot(): SearchWorkspaceSnapshotV10 {
    const filters = this.#filters.snapshot();
    const viewport = this.#viewport.snapshot();
    const activation = activationFromModel(this.#datasetKey, this.#model);
    const route = this.route();
    const phase = phaseFor(this.#model);
    const hasResults = Boolean(this.#model?.cards.length);
    const hasPreviousPage = this.#model?.pagination.hasPrevious === true;
    const hasNextPage = this.#model?.pagination.hasNext === true;
    const canClear = requestHasState(this.#request) || filters.filterCount > 0 || this.#grouping !== this.#policy.defaultGrouping;
    const fingerprint = hashFingerprint(stableSerialize({
      version: SEARCH_WORKSPACE_VERSION_V10,
      phase,
      datasetKey: this.#datasetKey,
      request: this.#request,
      grouping: this.#grouping,
      route,
      model: this.#model?.fingerprint ?? null,
      filters: filters.fingerprint,
      viewport: viewport.fingerprint,
      activation,
      stats: this.#stats,
    }));
    return Object.freeze({
      version: SEARCH_WORKSPACE_VERSION_V10,
      phase,
      datasetKey: this.#datasetKey,
      request: this.#request,
      grouping: this.#grouping,
      route,
      routeDiagnostics: this.#routeDiagnostics,
      filters,
      model: this.#model,
      viewport,
      activation,
      dirtyFilters: filters.dirty,
      hasResults,
      hasPreviousPage,
      hasNextPage,
      canClear,
      canSearch: Boolean(this.#datasetKey),
      searches: this.#stats.searches,
      routeHydrations: this.#stats.routeHydrations,
      pageChanges: this.#stats.pageChanges,
      filterApplications: this.#stats.filterApplications,
      selectionChanges: this.#stats.selectionChanges,
      fingerprint,
    });
  }
}

export const createSearchWorkspaceRuntimeV10 = (
  runtime: SearchExperienceRuntimeV9,
  datasetKey: unknown,
  initialRequest: SearchRequest = {},
  policy: SearchWorkspacePolicyV10 = {},
): SearchWorkspaceRuntimeV10 => new SearchWorkspaceRuntimeV10(runtime, datasetKey, initialRequest, policy);
