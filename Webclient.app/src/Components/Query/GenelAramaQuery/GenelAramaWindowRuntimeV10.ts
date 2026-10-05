import {
  GENERAL_SEARCH_WINDOW_VERSION_V10,
  type GeneralSearchFacetKindV10,
  type GeneralSearchMoveCommandV10,
  type GeneralSearchMutableDiagnosticsV10,
  type GeneralSearchMutableStateV10,
  type GeneralSearchNormalizedPolicyV10,
  type GeneralSearchSortModeV10,
  type GeneralSearchWindowDiagnosticsV10,
  type GeneralSearchWindowPolicyV10,
  type GeneralSearchWindowSnapshotV10,
} from './GenelAramaWindowContractsV10';
import type { NormalizedSearchRecord } from '../_Common/QuerySearchRuntime';
import {
  createGeneralSearchAnnouncementV10,
  createGeneralSearchFacetsV10,
  createGeneralSearchGuidanceV10,
  createGeneralSearchPresentedRecordsV10,
  createGeneralSearchRenderWindowV10,
  filterGeneralSearchRecordsV10,
  generalSearchPresentationFingerprintV10,
  moveGeneralSearchIndexV10,
  normalizeGeneralSearchFacetValueV10,
  normalizeGeneralSearchRefinementV10,
  normalizeGeneralSearchSortModeV10,
  normalizeGeneralSearchWindowPolicyV10,
  prepareGeneralSearchRecordsV10,
  sortGeneralSearchRecordsV10,
  type GeneralSearchPreparedRecordsV10,
} from './GenelAramaWindowPresentationV10';

const emptyPrepared = (
  policy: GeneralSearchNormalizedPolicyV10,
): GeneralSearchPreparedRecordsV10 => prepareGeneralSearchRecordsV10([], policy);

const initialMutableState = (): GeneralSearchMutableStateV10 => ({
  revision: 0,
  refinement: '',
  selectedCategories: new Set<string>(),
  selectedTypes: new Set<string>(),
  sortMode: 'relevance',
  activeIdentity: null,
  preferredWindowStart: null,
});

const initialDiagnostics = (): GeneralSearchMutableDiagnosticsV10 => ({
  sourceRecords: 0,
  retainedRecords: 0,
  duplicateIdentities: 0,
  invalidRecords: 0,
  recomputations: 0,
  refinementChanges: 0,
  facetChanges: 0,
  sortChanges: 0,
  activeMoves: 0,
  windowMoves: 0,
  resultLimitReached: false,
});

const cloneSet = (source: ReadonlySet<string>): Set<string> => new Set(source);

const sortedSetValues = (source: ReadonlySet<string>): readonly string[] => Object.freeze(
  [...source].sort((left, right) => left.localeCompare(right, 'tr-TR', {
    sensitivity: 'base',
    numeric: true,
  })),
);

const clampIndex = (value: number, count: number): number => {
  if (count <= 0) return -1;
  if (!Number.isFinite(value)) return 0;
  return Math.min(count - 1, Math.max(0, Math.trunc(value)));
};

export class GenelAramaWindowRuntimeV10 {
  readonly #policy: GeneralSearchNormalizedPolicyV10;
  #prepared: GeneralSearchPreparedRecordsV10;
  #state: GeneralSearchMutableStateV10 = initialMutableState();
  #diagnostics: GeneralSearchMutableDiagnosticsV10 = initialDiagnostics();
  #snapshot: GeneralSearchWindowSnapshotV10;

  constructor(
    records: readonly NormalizedSearchRecord[] = [],
    policyInput: GeneralSearchWindowPolicyV10 = {},
  ) {
    this.#policy = normalizeGeneralSearchWindowPolicyV10(policyInput);
    this.#prepared = emptyPrepared(this.#policy);
    this.#snapshot = this.#createSnapshot();
    this.replaceRecords(records);
  }

  policy(): GeneralSearchNormalizedPolicyV10 {
    return this.#policy;
  }

  snapshot(): GeneralSearchWindowSnapshotV10 {
    return this.#snapshot;
  }

  diagnostics(): GeneralSearchWindowDiagnosticsV10 {
    const fingerprint = generalSearchPresentationFingerprintV10({
      version: GENERAL_SEARCH_WINDOW_VERSION_V10,
      revision: this.#state.revision,
      sourceRecords: this.#diagnostics.sourceRecords,
      retainedRecords: this.#diagnostics.retainedRecords,
      duplicateIdentities: this.#diagnostics.duplicateIdentities,
      invalidRecords: this.#diagnostics.invalidRecords,
      recomputations: this.#diagnostics.recomputations,
      refinementChanges: this.#diagnostics.refinementChanges,
      facetChanges: this.#diagnostics.facetChanges,
      sortChanges: this.#diagnostics.sortChanges,
      activeMoves: this.#diagnostics.activeMoves,
      windowMoves: this.#diagnostics.windowMoves,
      resultLimitReached: this.#diagnostics.resultLimitReached,
    });
    return Object.freeze({
      version: GENERAL_SEARCH_WINDOW_VERSION_V10,
      revision: this.#state.revision,
      sourceRecords: this.#diagnostics.sourceRecords,
      retainedRecords: this.#diagnostics.retainedRecords,
      duplicateIdentities: this.#diagnostics.duplicateIdentities,
      invalidRecords: this.#diagnostics.invalidRecords,
      recomputations: this.#diagnostics.recomputations,
      refinementChanges: this.#diagnostics.refinementChanges,
      facetChanges: this.#diagnostics.facetChanges,
      sortChanges: this.#diagnostics.sortChanges,
      activeMoves: this.#diagnostics.activeMoves,
      windowMoves: this.#diagnostics.windowMoves,
      resultLimitReached: this.#diagnostics.resultLimitReached,
      fingerprint,
    });
  }

  replaceRecords(records: readonly NormalizedSearchRecord[] | null | undefined): GeneralSearchWindowSnapshotV10 {
    const previousActive = this.#state.activeIdentity;
    this.#prepared = prepareGeneralSearchRecordsV10(records, this.#policy);
    this.#state.revision += 1;
    this.#state.preferredWindowStart = null;
    this.#diagnostics.sourceRecords = this.#prepared.sourceCount;
    this.#diagnostics.retainedRecords = this.#prepared.records.length;
    this.#diagnostics.duplicateIdentities = this.#prepared.duplicateIdentities;
    this.#diagnostics.invalidRecords = this.#prepared.invalidRecords;
    this.#diagnostics.resultLimitReached = this.#prepared.resultLimitReached;

    const activeStillExists = previousActive !== null
      && this.#prepared.records.some(record => record.identity === previousActive);
    this.#state.activeIdentity = activeStillExists
      ? previousActive
      : this.#prepared.records[0]?.identity ?? null;
    return this.#recompute();
  }

  setRefinement(value: unknown): GeneralSearchWindowSnapshotV10 {
    const next = normalizeGeneralSearchRefinementV10(value, this.#policy);
    if (next === this.#state.refinement) return this.#snapshot;
    this.#state.refinement = next;
    this.#state.preferredWindowStart = null;
    this.#diagnostics.refinementChanges += 1;
    return this.#recompute({ preserveActive: true });
  }

  setSortMode(value: unknown): GeneralSearchWindowSnapshotV10 {
    const next = normalizeGeneralSearchSortModeV10(value);
    if (next === this.#state.sortMode) return this.#snapshot;
    this.#state.sortMode = next;
    this.#state.preferredWindowStart = null;
    this.#diagnostics.sortChanges += 1;
    return this.#recompute({ preserveActive: true });
  }

  toggleFacet(kind: GeneralSearchFacetKindV10, value: unknown): GeneralSearchWindowSnapshotV10 {
    const normalized = normalizeGeneralSearchFacetValueV10(value);
    if (!normalized) return this.#snapshot;
    const target = kind === 'category'
      ? this.#state.selectedCategories
      : this.#state.selectedTypes;
    if (!target.has(normalized) && this.#selectedFacetCount() >= this.#policy.maxSelectedFacets) {
      return this.#snapshot;
    }
    if (target.has(normalized)) target.delete(normalized);
    else target.add(normalized);
    this.#state.preferredWindowStart = null;
    this.#diagnostics.facetChanges += 1;
    return this.#recompute({ preserveActive: true });
  }

  setFacetSelection(
    kind: GeneralSearchFacetKindV10,
    values: readonly unknown[],
  ): GeneralSearchWindowSnapshotV10 {
    const normalized = Array.from(new Set(values
      .map(normalizeGeneralSearchFacetValueV10)
      .filter(Boolean)))
      .slice(0, this.#policy.maxSelectedFacets);
    if (kind === 'category') this.#state.selectedCategories = new Set(normalized);
    else this.#state.selectedTypes = new Set(normalized);
    this.#state.preferredWindowStart = null;
    this.#diagnostics.facetChanges += 1;
    return this.#recompute({ preserveActive: true });
  }

  clearFilters(): GeneralSearchWindowSnapshotV10 {
    const changed = Boolean(
      this.#state.refinement
      || this.#state.selectedCategories.size
      || this.#state.selectedTypes.size,
    );
    if (!changed) return this.#snapshot;
    this.#state.refinement = '';
    this.#state.selectedCategories.clear();
    this.#state.selectedTypes.clear();
    this.#state.preferredWindowStart = null;
    this.#diagnostics.facetChanges += 1;
    return this.#recompute({ preserveActive: true });
  }

  setActiveIdentity(identityInput: unknown): GeneralSearchWindowSnapshotV10 {
    const identity = typeof identityInput === 'string' ? identityInput : '';
    if (!identity || identity === this.#state.activeIdentity) return this.#snapshot;
    if (!this.#snapshot.items.some(item => item.identity === identity)) return this.#snapshot;
    this.#state.activeIdentity = identity;
    this.#state.preferredWindowStart = null;
    this.#diagnostics.activeMoves += 1;
    return this.#recompute({ preserveActive: true });
  }

  setActiveIndex(indexInput: unknown): GeneralSearchWindowSnapshotV10 {
    const index = clampIndex(Number(indexInput), this.#snapshot.items.length);
    if (index < 0) return this.#snapshot;
    const identity = this.#snapshot.items[index]?.identity ?? null;
    if (!identity || identity === this.#state.activeIdentity) return this.#snapshot;
    this.#state.activeIdentity = identity;
    this.#state.preferredWindowStart = null;
    this.#diagnostics.activeMoves += 1;
    return this.#recompute({ preserveActive: true });
  }

  moveActive(command: GeneralSearchMoveCommandV10): GeneralSearchWindowSnapshotV10 {
    const count = this.#snapshot.items.length;
    if (count === 0) return this.#snapshot;
    const nextIndex = moveGeneralSearchIndexV10(
      this.#snapshot.activeIndex,
      count,
      command,
      this.#policy,
    );
    const identity = this.#snapshot.items[nextIndex]?.identity ?? null;
    if (!identity || identity === this.#state.activeIdentity) return this.#snapshot;
    this.#state.activeIdentity = identity;
    this.#state.preferredWindowStart = null;
    this.#diagnostics.activeMoves += 1;
    return this.#recompute({ preserveActive: true });
  }

  moveWindow(direction: 'previous' | 'next'): GeneralSearchWindowSnapshotV10 {
    const window = this.#snapshot.renderWindow;
    if (window.count <= 0) return this.#snapshot;
    const delta = direction === 'previous' ? -window.count : window.count;
    const maximumStart = Math.max(0, this.#snapshot.matchedCount - window.count);
    const nextStart = Math.min(
      maximumStart,
      Math.max(0, window.startIndex + delta),
    );
    if (nextStart === window.startIndex) return this.#snapshot;
    this.#state.preferredWindowStart = nextStart;
    const nextActiveIndex = direction === 'previous'
      ? nextStart
      : Math.min(this.#snapshot.matchedCount - 1, nextStart);
    this.#state.activeIdentity = this.#snapshot.items[nextActiveIndex]?.identity
      ?? this.#state.activeIdentity;
    this.#diagnostics.windowMoves += 1;
    return this.#recompute({ preserveActive: true });
  }

  resetView(): GeneralSearchWindowSnapshotV10 {
    this.#state.refinement = '';
    this.#state.selectedCategories.clear();
    this.#state.selectedTypes.clear();
    this.#state.sortMode = 'relevance';
    this.#state.preferredWindowStart = null;
    this.#state.activeIdentity = this.#prepared.records[0]?.identity ?? null;
    return this.#recompute();
  }

  activeRecord(): NormalizedSearchRecord | null {
    return this.#snapshot.activeRecord;
  }

  activeIdentity(): string | null {
    return this.#snapshot.activeIdentity;
  }

  #selectedFacetCount(): number {
    return this.#state.selectedCategories.size + this.#state.selectedTypes.size;
  }

  #recompute(options: { readonly preserveActive?: boolean } = {}): GeneralSearchWindowSnapshotV10 {
    this.#snapshot = this.#createSnapshot(options);
    this.#diagnostics.recomputations += 1;
    return this.#snapshot;
  }

  #createSnapshot(
    options: { readonly preserveActive?: boolean } = {},
  ): GeneralSearchWindowSnapshotV10 {
    const filtered = filterGeneralSearchRecordsV10(
      this.#prepared.records,
      this.#state.refinement,
      this.#state.selectedCategories,
      this.#state.selectedTypes,
    );
    const sorted = sortGeneralSearchRecordsV10(
      filtered,
      this.#state.refinement,
      this.#state.sortMode,
    );

    let activeIdentity = this.#state.activeIdentity;
    let activeIndex = activeIdentity === null
      ? -1
      : sorted.findIndex(record => record.identity === activeIdentity);
    if (activeIndex < 0 && sorted.length > 0) {
      activeIndex = 0;
      activeIdentity = sorted[0]?.identity ?? null;
    }
    if (sorted.length === 0) {
      activeIndex = -1;
      activeIdentity = null;
    }
    if (options.preserveActive !== false) this.#state.activeIdentity = activeIdentity;

    const presented = createGeneralSearchPresentedRecordsV10(
      sorted,
      this.#state.refinement,
      activeIdentity,
      this.#policy,
    );
    const renderWindow = createGeneralSearchRenderWindowV10(
      presented.length,
      activeIndex,
      this.#state.preferredWindowStart,
      this.#policy,
    );
    const visibleItems = Object.freeze(presented.slice(
      renderWindow.startIndex,
      renderWindow.endIndexExclusive,
    ));
    const activeRecord = activeIndex >= 0
      ? presented[activeIndex]?.record ?? null
      : null;
    const facets = createGeneralSearchFacetsV10(
      this.#prepared.records,
      this.#state.refinement,
      this.#state.selectedCategories,
      this.#state.selectedTypes,
      this.#policy,
    );
    const selectedCategories = sortedSetValues(this.#state.selectedCategories);
    const selectedTypes = sortedSetValues(this.#state.selectedTypes);
    const hasFilters = Boolean(
      this.#state.refinement
      || selectedCategories.length
      || selectedTypes.length,
    );
    const guidance = createGeneralSearchGuidanceV10(
      this.#prepared.records.length,
      presented.length,
      this.#state.refinement,
      selectedCategories.length + selectedTypes.length,
      this.#prepared.resultLimitReached,
    );
    const announcement = createGeneralSearchAnnouncementV10(
      this.#prepared.records.length,
      presented.length,
      activeIndex,
      activeRecord,
      renderWindow,
      this.#policy,
    );
    const fingerprint = generalSearchPresentationFingerprintV10({
      version: GENERAL_SEARCH_WINDOW_VERSION_V10,
      revision: this.#state.revision,
      recordsFingerprint: this.#prepared.fingerprint,
      refinement: this.#state.refinement,
      selectedCategories,
      selectedTypes,
      sortMode: this.#state.sortMode,
      activeIdentity,
      identities: presented.map(item => item.identity),
      renderWindow,
    });

    return Object.freeze({
      version: GENERAL_SEARCH_WINDOW_VERSION_V10,
      revision: this.#state.revision,
      recordsFingerprint: this.#prepared.fingerprint,
      totalCount: this.#prepared.records.length,
      matchedCount: presented.length,
      refinement: this.#state.refinement,
      normalizedRefinement: this.#state.refinement.trim().toLocaleUpperCase('tr-TR'),
      selectedCategories,
      selectedTypes,
      sortMode: this.#state.sortMode,
      activeIdentity,
      activeIndex,
      activeRecord,
      items: presented,
      visibleItems,
      facets,
      renderWindow,
      guidance,
      announcement,
      hasFilters,
      resultLimitReached: this.#prepared.resultLimitReached,
      fingerprint,
    });
  }
}

export const createGenelAramaWindowRuntimeV10 = (
  records: readonly NormalizedSearchRecord[] = [],
  policy: GeneralSearchWindowPolicyV10 = {},
): GenelAramaWindowRuntimeV10 => new GenelAramaWindowRuntimeV10(records, policy);

export const cloneGeneralSearchFacetSelectionV10 = (
  values: ReadonlySet<string>,
): ReadonlySet<string> => new Set(cloneSet(values));
