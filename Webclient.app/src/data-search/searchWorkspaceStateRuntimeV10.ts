import {
  hashFingerprint,
  normalizeInteger,
  normalizeSearchText,
  normalizeText,
  stableSerialize,
} from './normalization';
import type {
  SearchWorkspaceActionKindV10,
  SearchWorkspaceHandoffModelV10,
  SearchWorkspaceResultV10,
  SearchWorkspaceSurfaceV10,
} from './searchWorkspaceHandoffRuntimeV10';

export const SEARCH_WORKSPACE_STATE_VERSION_V10 = 'search-workspace-state-v10' as const;

export type SearchWorkspaceStateTransitionKindV10 =
  | 'replace-model'
  | 'focus-surface'
  | 'set-active'
  | 'select'
  | 'toggle-selection'
  | 'clear-selection'
  | 'open-details'
  | 'close-details'
  | 'request-map-focus'
  | 'clear-map-focus'
  | 'reset';

export interface SearchWorkspaceStatePolicyV10 {
  readonly maxSelected?: number;
  readonly maxHistory?: number;
  readonly preserveSurfaceAcrossModelRefresh?: boolean;
  readonly preserveSelectionAcrossEquivalentRevision?: boolean;
  readonly clearDetailWhenResultDisappears?: boolean;
  readonly clearMapFocusWhenResultDisappears?: boolean;
}

export interface SearchWorkspaceStateSnapshotV10 {
  readonly version: typeof SEARCH_WORKSPACE_STATE_VERSION_V10;
  readonly datasetKey: string | null;
  readonly datasetRevision: number | null;
  readonly datasetFingerprint: string | null;
  readonly modelFingerprint: string | null;
  readonly requestFingerprint: string | null;
  readonly surface: SearchWorkspaceSurfaceV10;
  readonly activeResultKey: string | null;
  readonly selectedResultKeys: readonly string[];
  readonly detailResultKey: string | null;
  readonly mapResultKey: string | null;
  readonly resultCount: number;
  readonly transitionSequence: number;
  readonly staleSelectionDrops: number;
  readonly staleDetailDrops: number;
  readonly staleMapDrops: number;
  readonly selectionLimitDrops: number;
  readonly fingerprint: string;
}

export interface SearchWorkspaceStateTransitionV10 {
  readonly sequence: number;
  readonly kind: SearchWorkspaceStateTransitionKindV10;
  readonly accepted: boolean;
  readonly reason: string;
  readonly previousFingerprint: string;
  readonly nextFingerprint: string;
  readonly at: number;
}

export interface SearchWorkspaceResultHandoffV10 {
  readonly key: string;
  readonly recordFingerprint: string;
  readonly title: string;
  readonly latitude: number | null;
  readonly longitude: number | null;
  readonly hasCoordinates: boolean;
  readonly datasetKey: string;
  readonly datasetRevision: number;
  readonly datasetFingerprint: string;
  readonly modelFingerprint: string;
}

interface NormalizedStatePolicyV10 {
  readonly maxSelected: number;
  readonly maxHistory: number;
  readonly preserveSurfaceAcrossModelRefresh: boolean;
  readonly preserveSelectionAcrossEquivalentRevision: boolean;
  readonly clearDetailWhenResultDisappears: boolean;
  readonly clearMapFocusWhenResultDisappears: boolean;
}

interface MutableStateV10 {
  model: SearchWorkspaceHandoffModelV10 | null;
  surface: SearchWorkspaceSurfaceV10;
  activeResultKey: string | null;
  selectedResultKeys: string[];
  detailResultKey: string | null;
  mapResultKey: string | null;
  transitionSequence: number;
  staleSelectionDrops: number;
  staleDetailDrops: number;
  staleMapDrops: number;
  selectionLimitDrops: number;
}

const DEFAULT_SURFACE: SearchWorkspaceSurfaceV10 = 'query';

const normalizePolicy = (
  policy: SearchWorkspaceStatePolicyV10 = {},
): NormalizedStatePolicyV10 => Object.freeze({
  maxSelected: normalizeInteger(policy.maxSelected, { min: 1, max: 2_000, fallback: 250 }),
  maxHistory: normalizeInteger(policy.maxHistory, { min: 1, max: 2_000, fallback: 128 }),
  preserveSurfaceAcrossModelRefresh: policy.preserveSurfaceAcrossModelRefresh !== false,
  preserveSelectionAcrossEquivalentRevision: policy.preserveSelectionAcrossEquivalentRevision !== false,
  clearDetailWhenResultDisappears: policy.clearDetailWhenResultDisappears !== false,
  clearMapFocusWhenResultDisappears: policy.clearMapFocusWhenResultDisappears !== false,
});

const normalizeSurface = (value: unknown): SearchWorkspaceSurfaceV10 => {
  const normalized = normalizeSearchText(value);
  if (normalized === 'query'
    || normalized === 'filters'
    || normalized === 'results'
    || normalized === 'map'
    || normalized === 'details'
    || normalized === 'history'
    || normalized === 'guidance') return normalized;
  return DEFAULT_SURFACE;
};

const resultMap = (
  model: SearchWorkspaceHandoffModelV10 | null,
): ReadonlyMap<string, SearchWorkspaceResultV10> => new Map(
  (model?.results ?? []).map(result => [result.key, result] as const),
);

const identityEquivalent = (
  left: SearchWorkspaceHandoffModelV10 | null,
  right: SearchWorkspaceHandoffModelV10,
): boolean => Boolean(left
  && left.dataset.key === right.dataset.key
  && left.dataset.revision === right.dataset.revision
  && left.dataset.fingerprint === right.dataset.fingerprint);

const cleanKeys = (
  values: readonly string[],
  available: ReadonlyMap<string, SearchWorkspaceResultV10>,
  maximum: number,
): readonly string[] => {
  const output: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const key = normalizeText(value);
    if (!key || seen.has(key) || !available.has(key)) continue;
    seen.add(key);
    output.push(key);
    if (output.length >= maximum) break;
  }
  return Object.freeze(output);
};

const stateFingerprint = (state: MutableStateV10): string => hashFingerprint(stableSerialize({
  version: SEARCH_WORKSPACE_STATE_VERSION_V10,
  modelFingerprint: state.model?.fingerprint ?? null,
  dataset: state.model?.dataset ?? null,
  requestFingerprint: state.model?.requestFingerprint ?? null,
  surface: state.surface,
  activeResultKey: state.activeResultKey,
  selectedResultKeys: state.selectedResultKeys,
  detailResultKey: state.detailResultKey,
  mapResultKey: state.mapResultKey,
  transitionSequence: state.transitionSequence,
  counters: {
    staleSelectionDrops: state.staleSelectionDrops,
    staleDetailDrops: state.staleDetailDrops,
    staleMapDrops: state.staleMapDrops,
    selectionLimitDrops: state.selectionLimitDrops,
  },
}));

const snapshotFor = (state: MutableStateV10): SearchWorkspaceStateSnapshotV10 => Object.freeze({
  version: SEARCH_WORKSPACE_STATE_VERSION_V10,
  datasetKey: state.model?.dataset.key ?? null,
  datasetRevision: state.model?.dataset.revision ?? null,
  datasetFingerprint: state.model?.dataset.fingerprint ?? null,
  modelFingerprint: state.model?.fingerprint ?? null,
  requestFingerprint: state.model?.requestFingerprint ?? null,
  surface: state.surface,
  activeResultKey: state.activeResultKey,
  selectedResultKeys: Object.freeze([...state.selectedResultKeys]),
  detailResultKey: state.detailResultKey,
  mapResultKey: state.mapResultKey,
  resultCount: state.model?.results.length ?? 0,
  transitionSequence: state.transitionSequence,
  staleSelectionDrops: state.staleSelectionDrops,
  staleDetailDrops: state.staleDetailDrops,
  staleMapDrops: state.staleMapDrops,
  selectionLimitDrops: state.selectionLimitDrops,
  fingerprint: stateFingerprint(state),
});

const handoffFor = (
  result: SearchWorkspaceResultV10,
  model: SearchWorkspaceHandoffModelV10,
): SearchWorkspaceResultHandoffV10 => Object.freeze({
  key: result.key,
  recordFingerprint: result.recordFingerprint,
  title: result.title.value,
  latitude: result.latitude,
  longitude: result.longitude,
  hasCoordinates: result.hasCoordinates,
  datasetKey: model.dataset.key,
  datasetRevision: model.dataset.revision,
  datasetFingerprint: model.dataset.fingerprint,
  modelFingerprint: model.fingerprint,
});

export class SearchWorkspaceStateRuntimeV10 {
  readonly #policy: NormalizedStatePolicyV10;
  readonly #history: SearchWorkspaceStateTransitionV10[] = [];
  readonly #clock: () => number;
  readonly #state: MutableStateV10 = {
    model: null,
    surface: DEFAULT_SURFACE,
    activeResultKey: null,
    selectedResultKeys: [],
    detailResultKey: null,
    mapResultKey: null,
    transitionSequence: 0,
    staleSelectionDrops: 0,
    staleDetailDrops: 0,
    staleMapDrops: 0,
    selectionLimitDrops: 0,
  };

  constructor(
    policy: SearchWorkspaceStatePolicyV10 = {},
    clock: () => number = () => Date.now(),
  ) {
    this.#policy = normalizePolicy(policy);
    this.#clock = typeof clock === 'function' ? clock : () => Date.now();
  }

  #now(): number {
    const value = Number(this.#clock());
    return Number.isFinite(value) && value >= 0 ? Math.trunc(value) : Date.now();
  }

  #record(
    kind: SearchWorkspaceStateTransitionKindV10,
    accepted: boolean,
    reason: string,
    previousFingerprint: string,
  ): SearchWorkspaceStateSnapshotV10 {
    this.#state.transitionSequence += 1;
    const next = snapshotFor(this.#state);
    this.#history.push(Object.freeze({
      sequence: this.#state.transitionSequence,
      kind,
      accepted,
      reason: normalizeText(reason).slice(0, 200),
      previousFingerprint,
      nextFingerprint: next.fingerprint,
      at: this.#now(),
    }));
    while (this.#history.length > this.#policy.maxHistory) this.#history.shift();
    return next;
  }

  #reject(kind: SearchWorkspaceStateTransitionKindV10, reason: string): SearchWorkspaceStateSnapshotV10 {
    const previous = stateFingerprint(this.#state);
    return this.#record(kind, false, reason, previous);
  }

  replaceModel(model: SearchWorkspaceHandoffModelV10): SearchWorkspaceStateSnapshotV10 {
    if (model.version !== 'search-workspace-handoff-v10') {
      throw new TypeError('Workspace state v10 requires canonical handoff v10 models');
    }
    const previousFingerprint = stateFingerprint(this.#state);
    const previousModel = this.#state.model;
    const equivalent = identityEquivalent(previousModel, model);
    const available = resultMap(model);

    let nextSelected: readonly string[] = Object.freeze([]);
    if (equivalent && this.#policy.preserveSelectionAcrossEquivalentRevision) {
      nextSelected = cleanKeys(this.#state.selectedResultKeys, available, this.#policy.maxSelected);
    } else {
      nextSelected = cleanKeys(model.selectedResultKeys, available, this.#policy.maxSelected);
    }
    this.#state.staleSelectionDrops += Math.max(0, this.#state.selectedResultKeys.length - nextSelected.length);
    this.#state.selectedResultKeys = [...nextSelected];

    const modelActive = model.activeResultKey && available.has(model.activeResultKey)
      ? model.activeResultKey
      : model.results[0]?.key ?? null;
    this.#state.activeResultKey = equivalent && this.#state.activeResultKey && available.has(this.#state.activeResultKey)
      ? this.#state.activeResultKey
      : modelActive;

    if (this.#state.detailResultKey && !available.has(this.#state.detailResultKey)) {
      if (this.#policy.clearDetailWhenResultDisappears) {
        this.#state.detailResultKey = null;
        this.#state.staleDetailDrops += 1;
      }
    }
    if (this.#state.mapResultKey && !available.has(this.#state.mapResultKey)) {
      if (this.#policy.clearMapFocusWhenResultDisappears) {
        this.#state.mapResultKey = null;
        this.#state.staleMapDrops += 1;
      }
    }

    this.#state.model = model;
    if (!this.#policy.preserveSurfaceAcrossModelRefresh || previousModel === null) {
      this.#state.surface = model.preferredSurface;
    } else if (this.#state.surface === 'details' && this.#state.detailResultKey === null) {
      this.#state.surface = model.preferredSurface;
    } else if (this.#state.surface === 'map' && !model.hasMappableResults) {
      this.#state.surface = model.preferredSurface;
    }
    return this.#record('replace-model', true, equivalent ? 'equivalent-dataset-refresh' : 'dataset-or-revision-refresh', previousFingerprint);
  }

  focusSurface(surfaceInput: unknown): SearchWorkspaceStateSnapshotV10 {
    const previous = stateFingerprint(this.#state);
    const surface = normalizeSurface(surfaceInput);
    if (surface === 'details' && this.#state.detailResultKey === null) {
      return this.#record('focus-surface', false, 'details-requires-result', previous);
    }
    if (surface === 'map' && !this.#state.model?.hasMappableResults) {
      return this.#record('focus-surface', false, 'map-requires-mappable-results', previous);
    }
    this.#state.surface = surface;
    return this.#record('focus-surface', true, 'surface-updated', previous);
  }

  setActive(resultKeyInput: unknown): SearchWorkspaceStateSnapshotV10 {
    const previous = stateFingerprint(this.#state);
    const resultKey = normalizeText(resultKeyInput);
    const available = resultMap(this.#state.model);
    if (!resultKey || !available.has(resultKey)) {
      return this.#record('set-active', false, 'unknown-result', previous);
    }
    this.#state.activeResultKey = resultKey;
    this.#state.surface = 'results';
    return this.#record('set-active', true, 'active-result-updated', previous);
  }

  select(resultKeyInput: unknown): SearchWorkspaceStateSnapshotV10 {
    const previous = stateFingerprint(this.#state);
    const resultKey = normalizeText(resultKeyInput);
    const available = resultMap(this.#state.model);
    if (!resultKey || !available.has(resultKey)) {
      return this.#record('select', false, 'unknown-result', previous);
    }
    if (!this.#state.selectedResultKeys.includes(resultKey)) {
      if (this.#state.selectedResultKeys.length >= this.#policy.maxSelected) {
        this.#state.selectionLimitDrops += 1;
        return this.#record('select', false, 'selection-limit', previous);
      }
      this.#state.selectedResultKeys.push(resultKey);
    }
    this.#state.activeResultKey = resultKey;
    return this.#record('select', true, 'result-selected', previous);
  }

  toggleSelection(resultKeyInput: unknown): SearchWorkspaceStateSnapshotV10 {
    const previous = stateFingerprint(this.#state);
    const resultKey = normalizeText(resultKeyInput);
    const available = resultMap(this.#state.model);
    if (!resultKey || !available.has(resultKey)) {
      return this.#record('toggle-selection', false, 'unknown-result', previous);
    }
    const index = this.#state.selectedResultKeys.indexOf(resultKey);
    if (index >= 0) this.#state.selectedResultKeys.splice(index, 1);
    else if (this.#state.selectedResultKeys.length < this.#policy.maxSelected) this.#state.selectedResultKeys.push(resultKey);
    else {
      this.#state.selectionLimitDrops += 1;
      return this.#record('toggle-selection', false, 'selection-limit', previous);
    }
    this.#state.activeResultKey = resultKey;
    return this.#record('toggle-selection', true, index >= 0 ? 'result-deselected' : 'result-selected', previous);
  }

  clearSelection(): SearchWorkspaceStateSnapshotV10 {
    const previous = stateFingerprint(this.#state);
    this.#state.selectedResultKeys = [];
    return this.#record('clear-selection', true, 'selection-cleared', previous);
  }

  openDetails(resultKeyInput: unknown): SearchWorkspaceStateSnapshotV10 {
    const previous = stateFingerprint(this.#state);
    const resultKey = normalizeText(resultKeyInput);
    const available = resultMap(this.#state.model);
    if (!resultKey || !available.has(resultKey)) {
      return this.#record('open-details', false, 'unknown-result', previous);
    }
    this.#state.detailResultKey = resultKey;
    this.#state.activeResultKey = resultKey;
    this.#state.surface = 'details';
    return this.#record('open-details', true, 'detail-opened', previous);
  }

  closeDetails(): SearchWorkspaceStateSnapshotV10 {
    const previous = stateFingerprint(this.#state);
    this.#state.detailResultKey = null;
    if (this.#state.surface === 'details') {
      this.#state.surface = this.#state.model?.preferredSurface ?? DEFAULT_SURFACE;
    }
    return this.#record('close-details', true, 'detail-closed', previous);
  }

  requestMapFocus(resultKeyInput: unknown): SearchWorkspaceStateSnapshotV10 {
    const previous = stateFingerprint(this.#state);
    const resultKey = normalizeText(resultKeyInput);
    const result = resultMap(this.#state.model).get(resultKey);
    if (!result) return this.#record('request-map-focus', false, 'unknown-result', previous);
    if (!result.hasCoordinates) return this.#record('request-map-focus', false, 'result-has-no-coordinates', previous);
    this.#state.mapResultKey = resultKey;
    this.#state.activeResultKey = resultKey;
    this.#state.surface = 'map';
    return this.#record('request-map-focus', true, 'map-focus-requested', previous);
  }

  clearMapFocus(): SearchWorkspaceStateSnapshotV10 {
    const previous = stateFingerprint(this.#state);
    this.#state.mapResultKey = null;
    if (this.#state.surface === 'map') {
      this.#state.surface = this.#state.model?.preferredSurface ?? DEFAULT_SURFACE;
    }
    return this.#record('clear-map-focus', true, 'map-focus-cleared', previous);
  }

  resultHandoff(resultKeyInput: unknown): SearchWorkspaceResultHandoffV10 | null {
    const model = this.#state.model;
    if (!model) return null;
    const resultKey = normalizeText(resultKeyInput);
    const result = resultMap(model).get(resultKey);
    return result ? handoffFor(result, model) : null;
  }

  mapHandoff(): SearchWorkspaceResultHandoffV10 | null {
    return this.#state.mapResultKey ? this.resultHandoff(this.#state.mapResultKey) : null;
  }

  detailHandoff(): SearchWorkspaceResultHandoffV10 | null {
    return this.#state.detailResultKey ? this.resultHandoff(this.#state.detailResultKey) : null;
  }

  applyActionKind(kind: SearchWorkspaceActionKindV10, resultKey?: unknown): SearchWorkspaceStateSnapshotV10 {
    if (kind === 'focus-query') return this.focusSurface('query');
    if (kind === 'focus-filters') return this.focusSurface('filters');
    if (kind === 'focus-results') return this.focusSurface('results');
    if (kind === 'focus-map') return this.focusSurface('map');
    if (kind === 'open-details') return this.openDetails(resultKey);
    if (kind === 'close-details') return this.closeDetails();
    if (kind === 'select-result') return this.select(resultKey);
    if (kind === 'toggle-result') return this.toggleSelection(resultKey);
    if (kind === 'clear-selection') return this.clearSelection();
    if (kind === 'show-result-on-map') return this.requestMapFocus(resultKey);
    return this.snapshot();
  }

  reset(): SearchWorkspaceStateSnapshotV10 {
    const previous = stateFingerprint(this.#state);
    this.#state.model = null;
    this.#state.surface = DEFAULT_SURFACE;
    this.#state.activeResultKey = null;
    this.#state.selectedResultKeys = [];
    this.#state.detailResultKey = null;
    this.#state.mapResultKey = null;
    return this.#record('reset', true, 'state-reset', previous);
  }

  snapshot(): SearchWorkspaceStateSnapshotV10 {
    return snapshotFor(this.#state);
  }

  history(): readonly SearchWorkspaceStateTransitionV10[] {
    return Object.freeze(this.#history.map(entry => Object.freeze({ ...entry })));
  }
}

export const createSearchWorkspaceStateRuntimeV10 = (
  policy: SearchWorkspaceStatePolicyV10 = {},
  clock?: () => number,
): SearchWorkspaceStateRuntimeV10 => new SearchWorkspaceStateRuntimeV10(policy, clock);
