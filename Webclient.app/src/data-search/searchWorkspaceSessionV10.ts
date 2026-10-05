import type { SearchRequest } from './contracts';
import { hashFingerprint, normalizeInteger, normalizeText, stableSerialize } from './normalization';
import type {
  SearchSessionExecutionOptions,
  SearchSessionHistoryEntry,
  SearchSessionState,
} from './searchSession';
import {
  createSearchExperienceSessionV9,
  type SearchExperienceSessionOptionsV9,
  type SearchExperienceSessionV9,
} from './searchExperienceSessionV9';
import type { SearchExperienceRuntimeV9 } from './searchExperienceRuntimeV9';
import {
  SearchWorkspaceRuntimeV10,
  type SearchWorkspacePageV10,
} from './searchWorkspaceRuntimeV10';

export const SEARCH_WORKSPACE_SESSION_VERSION_V10 = 'search-workspace-session-v10' as const;

export interface SearchWorkspaceSessionOptionsV10 {
  readonly experienceSession?: SearchExperienceSessionOptionsV9;
  readonly maxCompletedPages?: number;
  readonly retainCompletedPages?: boolean;
}

export interface SearchWorkspaceSessionEnvelopeV10 {
  readonly version: typeof SEARCH_WORKSPACE_SESSION_VERSION_V10;
  readonly requestId: number;
  readonly datasetKey: string;
  readonly request: SearchRequest;
  readonly page: SearchWorkspacePageV10;
  readonly stale: boolean;
  readonly startedAt: number;
  readonly completedAt: number;
  readonly fingerprint: string;
}

export interface SearchWorkspaceSessionSnapshotV10 {
  readonly version: typeof SEARCH_WORKSPACE_SESSION_VERSION_V10;
  readonly state: SearchSessionState;
  readonly historySize: number;
  readonly completedPages: number;
  readonly retainedPages: number;
  readonly stalePages: number;
  readonly missingPages: number;
  readonly lastPageFingerprint: string | null;
  readonly workspace: ReturnType<SearchWorkspaceRuntimeV10['snapshot']>;
  readonly fingerprint: string;
}

interface Policy {
  readonly maxCompletedPages: number;
  readonly retainCompletedPages: boolean;
}

const policyFor = (options: SearchWorkspaceSessionOptionsV10): Policy => Object.freeze({
  maxCompletedPages: normalizeInteger(options.maxCompletedPages, { min: 1, max: 1_000, fallback: 64 }),
  retainCompletedPages: options.retainCompletedPages === true,
});

const envelopeFingerprint = (
  requestId: number,
  datasetKey: string,
  request: SearchRequest,
  page: SearchWorkspacePageV10,
  stale: boolean,
): string => hashFingerprint(stableSerialize({
  version: SEARCH_WORKSPACE_SESSION_VERSION_V10,
  requestId,
  datasetKey,
  request: {
    query: normalizeText(request.query),
    offset: request.offset ?? null,
    limit: request.limit ?? null,
    filterCount: request.filters?.length ?? 0,
  },
  pageFingerprint: page.fingerprint,
  stale,
}));

export class SearchWorkspaceSessionV10 {
  readonly #workspace: SearchWorkspaceRuntimeV10;
  readonly #session: SearchExperienceSessionV9;
  readonly #policy: Policy;
  readonly #pages: SearchWorkspaceSessionEnvelopeV10[] = [];
  #completedPages = 0;
  #stalePages = 0;
  #missingPages = 0;
  #lastPageFingerprint: string | null = null;
  #disposed = false;

  constructor(
    workspace: SearchWorkspaceRuntimeV10,
    experience: SearchExperienceRuntimeV9,
    options: SearchWorkspaceSessionOptionsV10 = {},
  ) {
    if (!(workspace instanceof SearchWorkspaceRuntimeV10)) throw new TypeError('SearchWorkspaceSessionV10 requires SearchWorkspaceRuntimeV10');
    this.#workspace = workspace;
    this.#policy = policyFor(options);
    this.#session = createSearchExperienceSessionV9(experience, options.experienceSession);
  }

  #ensureActive(): void {
    if (this.#disposed) throw new Error('SearchWorkspaceSessionV10 has been disposed');
  }

  #map(
    envelope: Awaited<ReturnType<SearchExperienceSessionV9['searchNow']>>,
  ): SearchWorkspaceSessionEnvelopeV10 {
    let page: SearchWorkspacePageV10;
    try {
      page = this.#workspace.adoptExperienceModel(envelope.model, envelope.request);
    } catch (error) {
      this.#missingPages += 1;
      throw error;
    }
    this.#completedPages += 1;
    if (envelope.stale) this.#stalePages += 1;
    this.#lastPageFingerprint = page.fingerprint;
    const mapped: SearchWorkspaceSessionEnvelopeV10 = Object.freeze({
      version: SEARCH_WORKSPACE_SESSION_VERSION_V10,
      requestId: envelope.requestId,
      datasetKey: envelope.datasetKey,
      request: envelope.request,
      page,
      stale: envelope.stale,
      startedAt: envelope.startedAt,
      completedAt: envelope.completedAt,
      fingerprint: envelopeFingerprint(envelope.requestId, envelope.datasetKey, envelope.request, page, envelope.stale),
    });
    if (this.#policy.retainCompletedPages) {
      this.#pages.push(mapped);
      while (this.#pages.length > this.#policy.maxCompletedPages) this.#pages.shift();
    }
    return mapped;
  }

  async searchNow(datasetKey: unknown, request: SearchRequest = {}, options: SearchSessionExecutionOptions = {}): Promise<SearchWorkspaceSessionEnvelopeV10> {
    this.#ensureActive();
    return this.#map(await this.#session.searchNow(datasetKey, request, options));
  }

  async schedule(datasetKey: unknown, request: SearchRequest = {}, options: SearchSessionExecutionOptions = {}): Promise<SearchWorkspaceSessionEnvelopeV10> {
    this.#ensureActive();
    return this.#map(await this.#session.schedule(datasetKey, request, options));
  }

  async loadMore(options: SearchSessionExecutionOptions = {}): Promise<SearchWorkspaceSessionEnvelopeV10> {
    this.#ensureActive();
    return this.#map(await this.#session.loadMore(options));
  }

  cancel(reason?: string): boolean {
    this.#ensureActive();
    return this.#session.cancel(reason);
  }

  state(): SearchSessionState { return this.#session.state(); }
  history(): readonly SearchSessionHistoryEntry[] { return this.#session.history(); }
  pages(): readonly SearchWorkspaceSessionEnvelopeV10[] { return Object.freeze([...this.#pages]); }

  snapshot(): SearchWorkspaceSessionSnapshotV10 {
    const workspace = this.#workspace.snapshot();
    const state = this.#session.state();
    const historySize = this.#session.history().length;
    const fingerprint = hashFingerprint(stableSerialize({
      version: SEARCH_WORKSPACE_SESSION_VERSION_V10,
      completedPages: this.#completedPages,
      retainedPages: this.#pages.length,
      stalePages: this.#stalePages,
      missingPages: this.#missingPages,
      lastPageFingerprint: this.#lastPageFingerprint,
      sessionState: { status: state.status, requestId: state.requestId, datasetKey: state.datasetKey },
      workspace: workspace.fingerprint,
    }));
    return Object.freeze({
      version: SEARCH_WORKSPACE_SESSION_VERSION_V10,
      state,
      historySize,
      completedPages: this.#completedPages,
      retainedPages: this.#pages.length,
      stalePages: this.#stalePages,
      missingPages: this.#missingPages,
      lastPageFingerprint: this.#lastPageFingerprint,
      workspace,
      fingerprint,
    });
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#session.dispose();
    this.#pages.length = 0;
    this.#disposed = true;
  }
}

export const createSearchWorkspaceSessionV10 = (
  workspace: SearchWorkspaceRuntimeV10,
  experience: SearchExperienceRuntimeV9,
  options: SearchWorkspaceSessionOptionsV10 = {},
): SearchWorkspaceSessionV10 => new SearchWorkspaceSessionV10(workspace, experience, options);
