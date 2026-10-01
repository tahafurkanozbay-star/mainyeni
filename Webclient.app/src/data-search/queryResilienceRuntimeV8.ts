import type { DatasetSnapshot, SearchRequest, SearchResponse } from './contracts';
import { throwIfAborted } from './contracts';
import { normalizeInteger } from './normalization';
import {
  DataSearchExecutionRuntimeV7,
  type DataSearchExecutionPolicyV7,
  type DataSearchExecutionResultV7,
} from './dataSearchExecutionRuntimeV7';
import {
  TermLexiconRuntimeV8,
  type TermLexiconPolicyV8,
} from './termLexiconRuntimeV8';
import {
  QueryRewriteRuntimeV8,
  type QueryRewritePlanV8,
  type QueryRewritePolicyV8,
} from './queryRewriteRuntimeV8';

export interface QueryResiliencePolicyV8 {
  readonly execution?: DataSearchExecutionPolicyV7;
  readonly lexicon?: TermLexiconPolicyV8;
  readonly rewrite?: QueryRewritePolicyV8;
  readonly fallbackResultThreshold?: number;
  readonly maximumFallbackAttempts?: number;
  readonly requireStrictImprovement?: boolean;
}

export interface QueryResilienceDiagnosticsV8 {
  readonly version: 8;
  readonly originalResultCount: number;
  readonly fallbackResultCount: number;
  readonly originalTopScore: number;
  readonly fallbackTopScore: number;
  readonly rewriteEligible: boolean;
  readonly rewriteChanged: boolean;
  readonly rewriteUsed: boolean;
  readonly fallbackAttempted: boolean;
  readonly fallbackAccepted: boolean;
  readonly fallbackAttempts: number;
  readonly canonicalBlocked: boolean;
  readonly fallbackBlocked: boolean;
  readonly decision: 'original' | 'suggestion-only' | 'fallback-accepted' | 'fallback-rejected' | 'rewrite-unavailable';
}

export interface QueryResilienceResultV8 {
  readonly response: SearchResponse;
  readonly selected: DataSearchExecutionResultV7;
  readonly original: DataSearchExecutionResultV7;
  readonly fallback: DataSearchExecutionResultV7 | null;
  readonly rewrite: QueryRewritePlanV8;
  readonly diagnostics: QueryResilienceDiagnosticsV8;
}

export interface QueryResilienceSnapshotV8 {
  readonly version: 8;
  readonly datasetKey: string;
  readonly datasetRevision: number;
  readonly datasetFingerprint: string;
  readonly searches: number;
  readonly rewriteEligible: number;
  readonly fallbackAttempts: number;
  readonly fallbackAccepted: number;
  readonly fallbackRejected: number;
  readonly suggestionOnly: number;
  readonly blockedCanonical: number;
  readonly lexicon: ReturnType<TermLexiconRuntimeV8['snapshot']>;
  readonly rewrite: ReturnType<QueryRewriteRuntimeV8['snapshot']>;
  readonly execution: ReturnType<DataSearchExecutionRuntimeV7['snapshot']>;
}

interface NormalizedPolicyV8 {
  readonly fallbackResultThreshold: number;
  readonly maximumFallbackAttempts: number;
  readonly requireStrictImprovement: boolean;
}

interface MutableStatsV8 {
  searches: number;
  rewriteEligible: number;
  fallbackAttempts: number;
  fallbackAccepted: number;
  fallbackRejected: number;
  suggestionOnly: number;
  blockedCanonical: number;
}

const VERSION = 8 as const;

const normalizePolicy = (input: QueryResiliencePolicyV8): NormalizedPolicyV8 => Object.freeze({
  fallbackResultThreshold: normalizeInteger(input.fallbackResultThreshold, {
    min: 0,
    max: 100,
    fallback: 0,
  }),
  maximumFallbackAttempts: normalizeInteger(input.maximumFallbackAttempts, {
    min: 0,
    max: 1,
    fallback: 1,
  }),
  requireStrictImprovement: input.requireStrictImprovement !== false,
});

const topScore = (result: DataSearchExecutionResultV7): number => result.response.results[0]?.score ?? 0;

const resultCount = (result: DataSearchExecutionResultV7): number => result.response.results.length;

const rewriteRequest = (
  request: SearchRequest,
  rewrite: QueryRewritePlanV8,
): SearchRequest => Object.freeze({
  ...request,
  query: rewrite.rewrittenQuery,
});

const shouldAttemptFallback = (
  original: DataSearchExecutionResultV7,
  rewrite: QueryRewritePlanV8,
  policy: NormalizedPolicyV8,
): boolean => policy.maximumFallbackAttempts > 0
  && !original.diagnostics.blocked
  && rewrite.mode === 'fallback'
  && rewrite.eligible
  && rewrite.changed
  && resultCount(original) <= policy.fallbackResultThreshold;

const improvesResult = (
  original: DataSearchExecutionResultV7,
  fallback: DataSearchExecutionResultV7,
  strict: boolean,
): boolean => {
  if (fallback.diagnostics.blocked) return false;
  const originalCount = resultCount(original);
  const fallbackCount = resultCount(fallback);
  if (originalCount === 0) return fallbackCount > 0;
  if (fallbackCount > originalCount) return true;
  if (!strict && fallbackCount === originalCount) return topScore(fallback) >= topScore(original);
  return fallbackCount === originalCount && topScore(fallback) > topScore(original);
};

const decisionFor = (
  original: DataSearchExecutionResultV7,
  fallback: DataSearchExecutionResultV7 | null,
  rewrite: QueryRewritePlanV8,
  accepted: boolean,
): QueryResilienceDiagnosticsV8['decision'] => {
  if (!rewrite.eligible || !rewrite.changed) return 'rewrite-unavailable';
  if (rewrite.mode === 'suggest') return 'suggestion-only';
  if (!fallback) return 'original';
  return accepted ? 'fallback-accepted' : 'fallback-rejected';
};

export class QueryResilienceRuntimeV8 {
  readonly #dataset: DatasetSnapshot;
  readonly #execution: DataSearchExecutionRuntimeV7;
  readonly #lexicon: TermLexiconRuntimeV8;
  readonly #rewrite: QueryRewriteRuntimeV8;
  readonly #policy: NormalizedPolicyV8;
  readonly #stats: MutableStatsV8 = {
    searches: 0,
    rewriteEligible: 0,
    fallbackAttempts: 0,
    fallbackAccepted: 0,
    fallbackRejected: 0,
    suggestionOnly: 0,
    blockedCanonical: 0,
  };

  constructor(
    dataset: DatasetSnapshot,
    policy: QueryResiliencePolicyV8 = {},
  ) {
    this.#dataset = dataset;
    this.#execution = new DataSearchExecutionRuntimeV7(dataset, policy.execution);
    this.#lexicon = new TermLexiconRuntimeV8(
      dataset.records,
      `${dataset.revision}:${dataset.fingerprint}`,
      policy.lexicon,
    );
    this.#rewrite = new QueryRewriteRuntimeV8(this.#lexicon, policy.rewrite);
    this.#policy = normalizePolicy(policy);
  }

  dataset(): DatasetSnapshot {
    return this.#dataset;
  }

  lexicon(): TermLexiconRuntimeV8 {
    return this.#lexicon;
  }

  rewrite(input: unknown): QueryRewritePlanV8 {
    return this.#rewrite.plan(input);
  }

  search(request: SearchRequest = {}): QueryResilienceResultV8 {
    throwIfAborted(request.signal);
    this.#stats.searches += 1;
    const original = this.#execution.search(request);
    if (original.diagnostics.blocked) this.#stats.blockedCanonical += 1;
    const rewrite = this.#rewrite.plan(request.query);
    if (rewrite.eligible && rewrite.changed) this.#stats.rewriteEligible += 1;
    if (rewrite.mode === 'suggest' && rewrite.eligible && rewrite.changed) this.#stats.suggestionOnly += 1;

    let fallback: DataSearchExecutionResultV7 | null = null;
    let accepted = false;
    if (shouldAttemptFallback(original, rewrite, this.#policy)) {
      throwIfAborted(request.signal);
      this.#stats.fallbackAttempts += 1;
      fallback = this.#execution.search(rewriteRequest(request, rewrite));
      accepted = improvesResult(original, fallback, this.#policy.requireStrictImprovement);
      if (accepted) this.#stats.fallbackAccepted += 1;
      else this.#stats.fallbackRejected += 1;
    }

    const selected = accepted && fallback ? fallback : original;
    const diagnostics: QueryResilienceDiagnosticsV8 = Object.freeze({
      version: VERSION,
      originalResultCount: resultCount(original),
      fallbackResultCount: fallback ? resultCount(fallback) : 0,
      originalTopScore: topScore(original),
      fallbackTopScore: fallback ? topScore(fallback) : 0,
      rewriteEligible: rewrite.eligible,
      rewriteChanged: rewrite.changed,
      rewriteUsed: accepted,
      fallbackAttempted: fallback !== null,
      fallbackAccepted: accepted,
      fallbackAttempts: fallback ? 1 : 0,
      canonicalBlocked: original.diagnostics.blocked,
      fallbackBlocked: fallback?.diagnostics.blocked ?? false,
      decision: decisionFor(original, fallback, rewrite, accepted),
    });
    return Object.freeze({
      response: selected.response,
      selected,
      original,
      fallback,
      rewrite,
      diagnostics,
    });
  }

  searchResponse(request: SearchRequest = {}): SearchResponse {
    return this.search(request).response;
  }

  snapshot(): QueryResilienceSnapshotV8 {
    return Object.freeze({
      version: VERSION,
      datasetKey: this.#dataset.key,
      datasetRevision: this.#dataset.revision,
      datasetFingerprint: this.#dataset.fingerprint,
      searches: this.#stats.searches,
      rewriteEligible: this.#stats.rewriteEligible,
      fallbackAttempts: this.#stats.fallbackAttempts,
      fallbackAccepted: this.#stats.fallbackAccepted,
      fallbackRejected: this.#stats.fallbackRejected,
      suggestionOnly: this.#stats.suggestionOnly,
      blockedCanonical: this.#stats.blockedCanonical,
      lexicon: this.#lexicon.snapshot(),
      rewrite: this.#rewrite.snapshot(),
      execution: this.#execution.snapshot(),
    });
  }
}

export const createQueryResilienceRuntimeV8 = (
  dataset: DatasetSnapshot,
  policy: QueryResiliencePolicyV8 = {},
): QueryResilienceRuntimeV8 => new QueryResilienceRuntimeV8(dataset, policy);
