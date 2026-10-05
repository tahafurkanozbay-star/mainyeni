import type { SearchRequest } from './contracts';
import { hashFingerprint, normalizeInteger, normalizeText, stableSerialize } from './normalization';
import {
  SearchExperienceRuntimeV9,
  type SearchExperiencePageModelV9,
  type SearchExperienceSearchOptionsV9,
} from './searchExperienceRuntimeV9';
import {
  SearchWorkspaceHandoffRuntimeV10,
  type SearchWorkspaceActionV10,
  type SearchWorkspaceHandoffModelV10,
  type SearchWorkspacePolicyV10,
} from './searchWorkspaceHandoffRuntimeV10';
import {
  SearchWorkspaceStateRuntimeV10,
  type SearchWorkspaceResultHandoffV10,
  type SearchWorkspaceStatePolicyV10,
  type SearchWorkspaceStateSnapshotV10,
} from './searchWorkspaceStateRuntimeV10';
import {
  SearchWorkspaceAccessibilityRuntimeV10,
  type SearchWorkspaceAccessibilityModelV10,
  type SearchWorkspaceAccessibilityPolicyV10,
} from './searchWorkspaceAccessibilityRuntimeV10';

export const SEARCH_WORKSPACE_RUNTIME_VERSION_V10 = 'search-workspace-runtime-v10' as const;

export interface SearchWorkspaceRuntimePolicyV10 {
  readonly handoff?: SearchWorkspacePolicyV10;
  readonly state?: SearchWorkspaceStatePolicyV10;
  readonly accessibility?: SearchWorkspaceAccessibilityPolicyV10;
  readonly maxActionHistory?: number;
  readonly maxModelHistory?: number;
  readonly clock?: () => number;
}

export interface SearchWorkspaceSearchOptionsV10 extends SearchExperienceSearchOptionsV9 {
  readonly preserveSurface?: boolean;
}

export interface SearchWorkspacePageV10 {
  readonly version: typeof SEARCH_WORKSPACE_RUNTIME_VERSION_V10;
  readonly experience: SearchExperiencePageModelV9;
  readonly handoff: SearchWorkspaceHandoffModelV10;
  readonly state: SearchWorkspaceStateSnapshotV10;
  readonly accessibility: SearchWorkspaceAccessibilityModelV10;
  readonly request: SearchRequest;
  readonly createdAt: number;
  readonly fingerprint: string;
}

export interface SearchWorkspaceActionOutcomeV10 {
  readonly kind: 'state-updated' | 'request-updated' | 'handoff-ready' | 'ignored';
  readonly action: SearchWorkspaceActionV10;
  readonly request: SearchRequest;
  readonly state: SearchWorkspaceStateSnapshotV10;
  readonly resultHandoff: SearchWorkspaceResultHandoffV10 | null;
  readonly shouldSearch: boolean;
  readonly accepted: boolean;
  readonly reason: string;
  readonly fingerprint: string;
}

export interface SearchWorkspaceActionHistoryEntryV10 {
  readonly sequence: number;
  readonly actionKind: SearchWorkspaceActionV10['kind'];
  readonly actionId: string;
  readonly outcome: SearchWorkspaceActionOutcomeV10['kind'];
  readonly accepted: boolean;
  readonly stateFingerprint: string;
  readonly at: number;
}

export interface SearchWorkspaceModelHistoryEntryV10 {
  readonly sequence: number;
  readonly datasetKey: string;
  readonly datasetRevision: number;
  readonly requestFingerprint: string;
  readonly modelFingerprint: string;
  readonly resultCount: number;
  readonly totalResultCount: number;
  readonly blocked: boolean;
  readonly recovered: boolean;
  readonly at: number;
}

export interface SearchWorkspaceRuntimeSnapshotV10 {
  readonly version: typeof SEARCH_WORKSPACE_RUNTIME_VERSION_V10;
  readonly searches: number;
  readonly adoptedModels: number;
  readonly actionExecutions: number;
  readonly stateActions: number;
  readonly requestActions: number;
  readonly mapHandoffs: number;
  readonly detailHandoffs: number;
  readonly ignoredActions: number;
  readonly modelHistorySize: number;
  readonly actionHistorySize: number;
  readonly lastPageFingerprint: string | null;
  readonly handoff: ReturnType<SearchWorkspaceHandoffRuntimeV10['snapshot']>;
  readonly state: SearchWorkspaceStateSnapshotV10;
  readonly accessibility: ReturnType<SearchWorkspaceAccessibilityRuntimeV10['snapshot']>;
  readonly fingerprint: string;
}

interface Policy {
  readonly maxActionHistory: number;
  readonly maxModelHistory: number;
  readonly clock: () => number;
}

interface Stats {
  searches: number;
  adoptedModels: number;
  actionExecutions: number;
  stateActions: number;
  requestActions: number;
  mapHandoffs: number;
  detailHandoffs: number;
  ignoredActions: number;
  lastPageFingerprint: string | null;
}

const policyFor = (input: SearchWorkspaceRuntimePolicyV10): Policy => Object.freeze({
  maxActionHistory: normalizeInteger(input.maxActionHistory, { min: 1, max: 2_000, fallback: 128 }),
  maxModelHistory: normalizeInteger(input.maxModelHistory, { min: 1, max: 1_000, fallback: 64 }),
  clock: typeof input.clock === 'function' ? input.clock : () => Date.now(),
});

const safeNow = (clock: () => number): number => {
  const value = Number(clock());
  return Number.isFinite(value) && value >= 0 ? Math.trunc(value) : Date.now();
};

const immutableRequest = (request: SearchRequest): SearchRequest => Object.freeze({
  ...request,
  ...(request.filters ? { filters: Object.freeze([...request.filters]) } : {}),
  ...(request.facetFields ? { facetFields: Object.freeze([...request.facetFields]) } : {}),
});

const requestAction = (kind: SearchWorkspaceActionV10['kind']): boolean =>
  kind === 'previous-page'
  || kind === 'next-page'
  || kind === 'first-page'
  || kind === 'apply-guidance'
  || kind === 'clear-filters'
  || kind === 'clear-spatial'
  || kind === 'clear-address-scope'
  || kind === 'show-all-results'
  || kind === 'use-query'
  || kind === 'repeat-history-query';

const stateAction = (kind: SearchWorkspaceActionV10['kind']): boolean =>
  kind === 'focus-query'
  || kind === 'focus-filters'
  || kind === 'focus-results'
  || kind === 'focus-map'
  || kind === 'open-details'
  || kind === 'close-details'
  || kind === 'select-result'
  || kind === 'toggle-result'
  || kind === 'clear-selection'
  || kind === 'show-result-on-map';

const pageFingerprint = (
  experience: SearchExperiencePageModelV9,
  handoff: SearchWorkspaceHandoffModelV10,
  state: SearchWorkspaceStateSnapshotV10,
  accessibility: SearchWorkspaceAccessibilityModelV10,
  request: SearchRequest,
): string => hashFingerprint(stableSerialize({
  version: SEARCH_WORKSPACE_RUNTIME_VERSION_V10,
  experience: experience.fingerprint,
  handoff: handoff.fingerprint,
  state: state.fingerprint,
  accessibility: accessibility.fingerprint,
  request: {
    query: normalizeText(request.query),
    offset: request.offset ?? null,
    limit: request.limit ?? null,
    sort: request.sort ?? null,
    filterCount: request.filters?.length ?? 0,
  },
}));

export class SearchWorkspaceRuntimeV10 {
  readonly #experience: SearchExperienceRuntimeV9;
  readonly #handoff: SearchWorkspaceHandoffRuntimeV10;
  readonly #state: SearchWorkspaceStateRuntimeV10;
  readonly #accessibility: SearchWorkspaceAccessibilityRuntimeV10;
  readonly #policy: Policy;
  readonly #actions: SearchWorkspaceActionHistoryEntryV10[] = [];
  readonly #models: SearchWorkspaceModelHistoryEntryV10[] = [];
  readonly #stats: Stats = {
    searches: 0,
    adoptedModels: 0,
    actionExecutions: 0,
    stateActions: 0,
    requestActions: 0,
    mapHandoffs: 0,
    detailHandoffs: 0,
    ignoredActions: 0,
    lastPageFingerprint: null,
  };
  #current: SearchWorkspacePageV10 | null = null;
  #actionSequence = 0;
  #modelSequence = 0;

  constructor(experience: SearchExperienceRuntimeV9, policy: SearchWorkspaceRuntimePolicyV10 = {}) {
    if (!(experience instanceof SearchExperienceRuntimeV9)) throw new TypeError('SearchWorkspaceRuntimeV10 requires SearchExperienceRuntimeV9');
    this.#experience = experience;
    this.#policy = policyFor(policy);
    this.#handoff = new SearchWorkspaceHandoffRuntimeV10(policy.handoff);
    this.#state = new SearchWorkspaceStateRuntimeV10(policy.state, this.#policy.clock);
    this.#accessibility = new SearchWorkspaceAccessibilityRuntimeV10(policy.accessibility);
  }

  experienceRuntime(): SearchExperienceRuntimeV9 { return this.#experience; }

  #now(): number { return safeNow(this.#policy.clock); }

  #build(
    experience: SearchExperiencePageModelV9,
    requestInput: SearchRequest,
    preserveSurface = true,
  ): SearchWorkspacePageV10 {
    const request = immutableRequest(requestInput);
    const handoff = this.#handoff.handoff(experience);
    if (!preserveSurface) this.#state.reset();
    const state = this.#state.replaceModel(handoff);
    const accessibility = this.#accessibility.build(handoff, state);
    const createdAt = this.#now();
    const fingerprint = pageFingerprint(experience, handoff, state, accessibility, request);
    const page: SearchWorkspacePageV10 = Object.freeze({
      version: SEARCH_WORKSPACE_RUNTIME_VERSION_V10,
      experience,
      handoff,
      state,
      accessibility,
      request,
      createdAt,
      fingerprint,
    });
    this.#current = page;
    this.#stats.lastPageFingerprint = fingerprint;
    this.#modelSequence += 1;
    this.#models.push(Object.freeze({
      sequence: this.#modelSequence,
      datasetKey: handoff.dataset.key,
      datasetRevision: handoff.dataset.revision,
      requestFingerprint: handoff.requestFingerprint,
      modelFingerprint: fingerprint,
      resultCount: handoff.resultCount,
      totalResultCount: handoff.totalResultCount,
      blocked: handoff.status.status === 'blocked',
      recovered: handoff.status.recovered,
      at: createdAt,
    }));
    while (this.#models.length > this.#policy.maxModelHistory) this.#models.shift();
    return page;
  }

  search(datasetKey: unknown, request: SearchRequest = {}, options: SearchWorkspaceSearchOptionsV10 = {}): SearchWorkspacePageV10 {
    this.#stats.searches += 1;
    const experience = this.#experience.search(datasetKey, request, options);
    return this.#build(experience, request, options.preserveSurface !== false);
  }

  adoptExperienceModel(
    experience: SearchExperiencePageModelV9,
    request: SearchRequest = {},
    options: Readonly<{ preserveSurface?: boolean }> = {},
  ): SearchWorkspacePageV10 {
    if (experience.version !== 'search-experience-v9') throw new TypeError('Canonical v9 experience model is required');
    this.#stats.adoptedModels += 1;
    return this.#build(experience, request, options.preserveSurface !== false);
  }

  current(): SearchWorkspacePageV10 | null { return this.#current; }

  action(actionIdInput: unknown): SearchWorkspaceActionV10 | null {
    const id = normalizeText(actionIdInput);
    return id && this.#current ? this.#current.handoff.actions.find(action => action.id === id) ?? null : null;
  }

  executeAction(requestInput: SearchRequest, action: SearchWorkspaceActionV10): SearchWorkspaceActionOutcomeV10 {
    if (!this.#current) throw new Error('A current workspace page is required');
    const request = immutableRequest(requestInput);
    this.#stats.actionExecutions += 1;
    let kind: SearchWorkspaceActionOutcomeV10['kind'] = 'ignored';
    let accepted = false;
    let reason = 'unsupported-action';
    let nextRequest = request;
    let resultHandoff: SearchWorkspaceResultHandoffV10 | null = null;

    if (!action.enabled) {
      reason = 'action-disabled';
      this.#stats.ignoredActions += 1;
    } else if (requestAction(action.kind)) {
      nextRequest = this.#handoff.requestPatchForAction(request, this.#current.experience, action);
      kind = 'request-updated';
      accepted = true;
      reason = 'request-patch-ready';
      this.#stats.requestActions += 1;
    } else if (stateAction(action.kind)) {
      const before = this.#state.snapshot();
      const after = this.#state.applyActionKind(action.kind, action.resultKey);
      accepted = after.transitionSequence > before.transitionSequence;
      kind = action.kind === 'open-details' || action.kind === 'show-result-on-map' ? 'handoff-ready' : 'state-updated';
      reason = accepted ? 'workspace-state-processed' : 'workspace-state-unchanged';
      this.#stats.stateActions += 1;
      if (kind === 'handoff-ready') {
        resultHandoff = action.resultKey ? this.#state.resultHandoff(action.resultKey) : null;
        if (!resultHandoff) {
          kind = 'ignored';
          accepted = false;
          reason = 'result-handoff-unavailable';
          this.#stats.ignoredActions += 1;
        } else if (action.kind === 'show-result-on-map') this.#stats.mapHandoffs += 1;
        else this.#stats.detailHandoffs += 1;
      }
    } else this.#stats.ignoredActions += 1;

    const state = this.#state.snapshot();
    const fingerprint = hashFingerprint(stableSerialize({
      version: SEARCH_WORKSPACE_RUNTIME_VERSION_V10,
      action: action.fingerprint,
      kind,
      accepted,
      reason,
      state: state.fingerprint,
      request: { query: normalizeText(nextRequest.query), offset: nextRequest.offset ?? null },
      handoff: resultHandoff,
    }));
    const outcome: SearchWorkspaceActionOutcomeV10 = Object.freeze({
      kind,
      action,
      request: nextRequest,
      state,
      resultHandoff,
      shouldSearch: kind === 'request-updated' && accepted,
      accepted,
      reason,
      fingerprint,
    });
    this.#actionSequence += 1;
    this.#actions.push(Object.freeze({
      sequence: this.#actionSequence,
      actionKind: action.kind,
      actionId: action.id,
      outcome: kind,
      accepted,
      stateFingerprint: state.fingerprint,
      at: this.#now(),
    }));
    while (this.#actions.length > this.#policy.maxActionHistory) this.#actions.shift();
    return outcome;
  }

  runAction(datasetKey: unknown, request: SearchRequest, action: SearchWorkspaceActionV10, options: SearchWorkspaceSearchOptionsV10 = {}): Readonly<{ outcome: SearchWorkspaceActionOutcomeV10; page: SearchWorkspacePageV10 | null }> {
    const outcome = this.executeAction(request, action);
    if (outcome.shouldSearch) return Object.freeze({ outcome, page: this.search(datasetKey, outcome.request, options) });
    const current = this.#current;
    if (current && (outcome.kind === 'state-updated' || outcome.kind === 'handoff-ready')) {
      const state = this.#state.snapshot();
      const accessibility = this.#accessibility.build(current.handoff, state);
      const fingerprint = pageFingerprint(current.experience, current.handoff, state, accessibility, current.request);
      this.#current = Object.freeze({ ...current, state, accessibility, fingerprint });
    }
    return Object.freeze({ outcome, page: this.#current });
  }

  resultHandoff(key: unknown): SearchWorkspaceResultHandoffV10 | null { return this.#state.resultHandoff(key); }
  mapHandoff(): SearchWorkspaceResultHandoffV10 | null { return this.#state.mapHandoff(); }
  detailHandoff(): SearchWorkspaceResultHandoffV10 | null { return this.#state.detailHandoff(); }
  actionHistory(): readonly SearchWorkspaceActionHistoryEntryV10[] { return Object.freeze([...this.#actions]); }
  modelHistory(): readonly SearchWorkspaceModelHistoryEntryV10[] { return Object.freeze([...this.#models]); }

  snapshot(): SearchWorkspaceRuntimeSnapshotV10 {
    const handoff = this.#handoff.snapshot();
    const state = this.#state.snapshot();
    const accessibility = this.#accessibility.snapshot();
    const fingerprint = hashFingerprint(stableSerialize({
      version: SEARCH_WORKSPACE_RUNTIME_VERSION_V10,
      stats: this.#stats,
      actionHistorySize: this.#actions.length,
      modelHistorySize: this.#models.length,
      handoff: handoff.fingerprint,
      state: state.fingerprint,
      accessibility: accessibility.fingerprint,
    }));
    return Object.freeze({
      version: SEARCH_WORKSPACE_RUNTIME_VERSION_V10,
      ...this.#stats,
      modelHistorySize: this.#models.length,
      actionHistorySize: this.#actions.length,
      handoff,
      state,
      accessibility,
      fingerprint,
    });
  }

  reset(): void {
    this.#current = null;
    this.#state.reset();
    this.#accessibility.clearPrevious();
  }
}

export const createSearchWorkspaceRuntimeV10 = (
  experience: SearchExperienceRuntimeV9,
  policy: SearchWorkspaceRuntimePolicyV10 = {},
): SearchWorkspaceRuntimeV10 => new SearchWorkspaceRuntimeV10(experience, policy);
