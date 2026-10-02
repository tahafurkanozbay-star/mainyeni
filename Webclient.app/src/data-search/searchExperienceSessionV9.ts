import type { SearchRequest } from './contracts';
import {
  createSearchSession,
  type SearchSession,
  type SearchSessionEnvelope,
  type SearchSessionExecutionOptions,
  type SearchSessionHistoryEntry,
  type SearchSessionOptions,
  type SearchSessionState,
} from './searchSession';
import {
  SearchExperienceRuntimeV9,
  type SearchExperiencePageModelV9,
  type SearchExperienceSearchOptionsV9,
} from './searchExperienceRuntimeV9';
import { normalizeInteger } from './normalization';

export const SEARCH_EXPERIENCE_SESSION_VERSION_V9 = 'search-experience-session-v9' as const;

export interface SearchExperienceSessionOptionsV9 extends SearchSessionOptions {
  readonly maxPendingModels?: number;
  readonly search?: SearchExperienceSearchOptionsV9;
}

export interface SearchExperienceSessionEnvelopeV9 {
  readonly requestId: number;
  readonly datasetKey: string;
  readonly request: SearchRequest;
  readonly model: SearchExperiencePageModelV9;
  readonly stale: boolean;
  readonly startedAt: number;
  readonly completedAt: number;
}

export interface SearchExperienceSessionSnapshotV9 {
  readonly version: typeof SEARCH_EXPERIENCE_SESSION_VERSION_V9;
  readonly state: SearchSessionState;
  readonly historySize: number;
  readonly pendingModels: number;
  readonly completedModels: number;
  readonly missingModels: number;
  readonly diagnostics: Readonly<Record<string, unknown>>;
}

const signatureForEnvelope = (envelope: SearchSessionEnvelope): string | null =>
  envelope.result?.diagnostics.querySignature ?? null;

export class SearchExperienceSessionV9 {
  readonly #runtime: SearchExperienceRuntimeV9;
  readonly #session: SearchSession;
  readonly #models = new Map<string, SearchExperiencePageModelV9>();
  readonly #maxPendingModels: number;
  readonly #searchOptions: SearchExperienceSearchOptionsV9;
  #completedModels = 0;
  #missingModels = 0;
  #disposed = false;

  constructor(
    runtime: SearchExperienceRuntimeV9,
    options: SearchExperienceSessionOptionsV9 = {},
  ) {
    if (!(runtime instanceof SearchExperienceRuntimeV9)) {
      throw new TypeError('SearchExperienceSessionV9 requires SearchExperienceRuntimeV9');
    }
    this.#runtime = runtime;
    this.#maxPendingModels = normalizeInteger(options.maxPendingModels, {
      min: 1,
      max: 1_000,
      fallback: 64,
    });
    this.#searchOptions = Object.freeze({ ...options.search });
    this.#session = createSearchSession((datasetKey, request) => {
      const model = this.#runtime.search(datasetKey, request, this.#searchOptions);
      const signature = model.recovery.response.diagnostics.querySignature;
      this.#models.delete(signature);
      this.#models.set(signature, model);
      while (this.#models.size > this.#maxPendingModels) {
        const oldest = this.#models.keys().next().value as string | undefined;
        if (!oldest) break;
        this.#models.delete(oldest);
      }
      return model.recovery.response;
    }, options);
  }

  #ensureActive(): void {
    if (this.#disposed) throw new Error('SearchExperienceSessionV9 has been disposed');
  }

  #mapEnvelope(envelope: SearchSessionEnvelope): SearchExperienceSessionEnvelopeV9 {
    const signature = signatureForEnvelope(envelope);
    const model = signature ? this.#models.get(signature) ?? null : null;
    if (!model) {
      this.#missingModels += 1;
      throw new Error('Search experience model was not available for the completed search response');
    }
    this.#models.delete(signature ?? '');
    this.#completedModels += 1;
    return Object.freeze({
      requestId: envelope.requestId,
      datasetKey: envelope.datasetKey,
      request: envelope.request,
      model,
      stale: envelope.stale,
      startedAt: envelope.startedAt,
      completedAt: envelope.completedAt,
    });
  }

  async searchNow(
    datasetKey: unknown,
    request: SearchRequest = {},
    options: SearchSessionExecutionOptions = {},
  ): Promise<SearchExperienceSessionEnvelopeV9> {
    this.#ensureActive();
    const envelope = await this.#session.searchNow(datasetKey, request, options);
    return this.#mapEnvelope(envelope);
  }

  async schedule(
    datasetKey: unknown,
    request: SearchRequest = {},
    options: SearchSessionExecutionOptions = {},
  ): Promise<SearchExperienceSessionEnvelopeV9> {
    this.#ensureActive();
    const envelope = await this.#session.schedule(datasetKey, request, options);
    return this.#mapEnvelope(envelope);
  }

  async loadMore(
    options: SearchSessionExecutionOptions = {},
  ): Promise<SearchExperienceSessionEnvelopeV9> {
    this.#ensureActive();
    const envelope = await this.#session.loadMore(options);
    return this.#mapEnvelope(envelope);
  }

  cancel(reason?: string): boolean {
    this.#ensureActive();
    return this.#session.cancel(reason);
  }

  state(): SearchSessionState {
    return this.#session.getState();
  }

  history(): readonly SearchSessionHistoryEntry[] {
    return this.#session.getHistory();
  }

  snapshot(): SearchExperienceSessionSnapshotV9 {
    return Object.freeze({
      version: SEARCH_EXPERIENCE_SESSION_VERSION_V9,
      state: this.#session.getState(),
      historySize: this.#session.getHistory().length,
      pendingModels: this.#models.size,
      completedModels: this.#completedModels,
      missingModels: this.#missingModels,
      diagnostics: this.#session.diagnostics(),
    });
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#session.dispose();
    this.#models.clear();
    this.#disposed = true;
  }
}

export const createSearchExperienceSessionV9 = (
  runtime: SearchExperienceRuntimeV9,
  options: SearchExperienceSessionOptionsV9 = {},
): SearchExperienceSessionV9 => new SearchExperienceSessionV9(runtime, options);
