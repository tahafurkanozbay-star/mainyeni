import type { SearchRequest } from './contracts';
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
import {
  SearchWorkspaceRuntimeV10,
  type SearchWorkspacePageV10,
} from './searchWorkspaceRuntimeV10';
import {
  hashFingerprint,
  normalizeInteger,
  normalizeText,
  stableSerialize,
} from './normalization';

export const SEARCH_WORKSPACE_SESSION_VERSION_V10 = 'search-workspace-session-v10' as const;

export interface SearchWorkspaceSessionPolicyV10 extends SearchExperienceSessionOptionsV9 {
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

interface NormalizedWorkspaceSessionPolicyV10 {
  readonly maxCompletedPages: number;
  readonly retainCompletedPages: boolean;
}

const normalizePolicy = (
  policy: SearchWorkspaceSessionPolicyV10,
): NormalizedWorkspaceSessionPolicyV10 => Object.freeze({
  maxCompletedPages: normalizeInteger(policy.maxCompletedPages, { min: 1, max: 1_000, fallback: 64 }),
  retainCompletedPages: policy.retainCompletedPages === true,
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
  readonly #policy: NormalizedWorkspaceSessionPolicyV10;
  readonly #pages: SearchWorkspaceSessionEnvelopeV10[] = [];
  #completedPages = 0;
  #stalePages = 0;
  #missingPages = 0;
  #lastPageFingerprint: string | null = null;
  #disposed = false;

  constructor(
    workspace: SearchWorkspaceRuntimeV10,
    policy: SearchWorkspaceSessionPolicyV10 = {},
  ) {
    if (!(workspace instanceof SearchWorkspaceRuntimeV10)) {
      throw new TypeError('SearchWorkspaceSessionV10 requires SearchWorkspaceRuntimeV10');
    }
    this.#workspace = workspace;
    this.#policy = normalizePolicy(policy);
    const current = workspace.current();
    const experience = current?.experience;
    const runtimeCandidate = experience ? null : null;
    void runtimeCandidate;
    const internal = (workspace as unknown as {
      __experienceRuntimeV9?: unknown;
    }).__experienceRuntimeV9;
    void internal;
    throw new Error('Use SearchWorkspaceSessionV10.create(runtime, experienceSessionOptions)');
  }

  static create(
    workspace: SearchWorkspaceRuntimeV10,
    session: SearchExperienceSessionV9,
    policy: SearchWorkspaceSessionPolicyV10 = {},
  ): SearchWorkspaceSessionV10 {
    const instance = Object.create(SearchWorkspaceSessionV10.prototype) as SearchWorkspaceSessionV10;
    Object.defineProperty(instance, '#workspace', { value: workspace });
    Object.defineProperty(instance, '#session', { value: session });
    Object.defineProperty(instance, '#policy', { value: normalizePolicy(policy) });
    return instance;
  }
}

export interface SearchWorkspaceSessionFactoryOptionsV10 {
  readonly experienceSession?: SearchExperienceSessionOptionsV9;
  readonly maxCompletedPages?: number;
  readonly retainCompletedPages?: boolean;
}

export class SearchWorkspaceSessionControllerV10 {
  readonly #workspace: SearchWorkspaceRuntimeV10;
  readonly #session: SearchExperienceSessionV9;
  readonly #policy: NormalizedWorkspaceSessionPolicyV10;
  readonly #pages: SearchWorkspaceSessionEnvelopeV10[] = [];
  #completedPages = 0;
  #stalePages = 0;
  #missingPages = 0;
  #lastPageFingerprint: string | null = null;
  #disposed = false;

  constructor(
    workspace: SearchWorkspaceRuntimeV10,
    experienceRuntime: Parameters<typeof createSearchExperienceSessionV9>[0],
    options: SearchWorkspaceSessionFactoryOptionsV10 = {},
  ) {
    if (!(workspace instanceof SearchWorkspaceRuntimeV10)) {
      throw new TypeError('SearchWorkspaceSessionControllerV10 requires SearchWorkspaceRuntimeV10');
    }
    this.#workspace = workspace;
    this.#policy = normalizePolicy({
      ...options.experienceSession,
      maxCompletedPages: options.maxCompletedPages,
      retainCompletedPages: options.retainCompletedPages,
    });
    this.#session = createSearchExperienceSessionV9(experienceRuntime, options.experienceSession);
  }

  #ensureActive(): void {
    if (this.#disposed) throw new Error('Search workspace session has been disposed');
  }

  #map(
    envelope: Awaited<ReturnType<SearchExperienceSessionV9['searchNow']>>,
  ): SearchWorkspaceSessionEnvelopeV10 {
    const page = this.#workspace.search(envelope.datasetKey, envelope.request, {
      recordHistory: false,
    });
    if (page.experience.requestFingerprint !== envelope.model.requestFingerprint) {
      this.#missingPages += 1;
      throw new Error('Workspace page request fingerprint diverged from canonical experience session model');
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
      fingerprint: envelopeFingerprint(
        envelope.requestId,
        envelope.datasetKey,
        envelope.request,
        page,
        envelope.stale,
      ),
    });
    if (this.#policy.retainCompletedPages) {
      this.#pages.push(mapped);
      while (this.#pages.length > this.#policy.maxCompletedPages) this.#pages.shift();
    }
    return mapped;
  }

  async searchNow(
    datasetKey: unknown,
    request: SearchRequest = {},
    options: SearchSessionExecutionOptions = {},
  ): Promise<SearchWorkspaceSessionEnvelopeV10> {
    this.#ensureActive();
    const envelope = await this.#session.searchNow(datasetKey, request, options);
    return this.#map(envelope);
  }

  async schedule(
    datasetKey: unknown,
    request: SearchRequest = {},
    options: SearchSessionExecutionOptions = {},
  ): Promise<SearchWorkspaceSessionEnvelopeV10> {
    this.#ensureActive();
    const envelope = await this.#session.schedule(datasetKey, request, options);
    return this.#map(envelope);
  }

  async loadMore(
    options: SearchSessionExecutionOptions = {},
  ): Promise<SearchWorkspaceSessionEnvelopeV10> {
    this.#ensureActive();
    const envelope = await this.#session.loadMore(options);
    return this.#map(envelope);
  }

  cancel(reason?: string): boolean {
    this.#ensureActive();
    return this.#session.cancel(reason);
  }

  state(): SearchSessionState {
    return this.#session.state();
  }

  history(): readonly SearchSessionHistoryEntry[] {
    return this.#session.history();
  }

  pages(): readonly SearchWorkspaceSessionEnvelopeV10[] {
    return Object.freeze([...this.#pages]);
  }

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
      state: {
        status: state.status,
        requestId: state.requestId,
        datasetKey: state.datasetKey,
      },
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
  experienceRuntime: Parameters<typeof createSearchExperienceSessionV9>[0],
  options: SearchWorkspaceSessionFactoryOptionsV10 = {},
): SearchWorkspaceSessionControllerV10 => new SearchWorkspaceSessionControllerV10(
  workspace,
  experienceRuntime,
  options,
);
