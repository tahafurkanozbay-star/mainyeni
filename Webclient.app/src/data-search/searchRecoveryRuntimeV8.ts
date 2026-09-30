import type {
  DatasetSnapshot,
  SearchRequest,
  SearchResponse,
} from './contracts';
import { throwIfAborted } from './contracts';
import {
  hashFingerprint,
  normalizeInteger,
  normalizeSearchText,
  stableSerialize,
} from './normalization';
import {
  DataSearchExecutionRegistryV7,
  type DataSearchExecutionRegistrationV7,
  type DataSearchExecutionRegistryOptionsV7,
  type DataSearchExecutionRegistrySnapshotV7,
  type DataSearchExecutionSearchResultV7,
} from './dataSearchExecutionRegistryV7';
import {
  createFuzzyLexiconTermsFromRecordsV8,
  FuzzyLexiconRuntimeV8,
  type FuzzyLexiconPolicyV8,
} from './fuzzyLexiconRuntimeV8';
import {
  createDefaultCivicSynonymsV8,
  SynonymRegistryRuntimeV8,
  type SynonymGroupInputV8,
  type SynonymRegistryPolicyV8,
} from './synonymRegistryRuntimeV8';
import {
  QueryCorrectionRuntimeV8,
  type QueryCorrectionPolicyV8,
  type QueryCorrectionResultV8,
} from './queryCorrectionRuntimeV8';
import {
  createSearchSession,
  type SearchSession,
  type SearchSessionOptions,
} from './searchSession';

export const SEARCH_RECOVERY_VERSION_V8 = 'search-recovery-v8' as const;

export type SearchRecoveryModeV8 =
  | 'none'
  | 'corrected'
  | 'synonym'
  | 'corrected-synonym';

export type SearchRecoverySkipReasonV8 =
  | 'not-needed'
  | 'empty-query'
  | 'blocked-primary'
  | 'coordinate-intent'
  | 'explicit-center'
  | 'correction-unchanged'
  | 'grammar-protected'
  | 'attempt-budget';

export interface SearchRecoveryPolicyV8 {
  readonly minimumPrimaryResults?: number;
  readonly maximumAttempts?: number;
  readonly maximumDatasets?: number;
  readonly enableCorrection?: boolean;
  readonly enableSynonyms?: boolean;
  readonly enableDefaultCivicSynonyms?: boolean;
  readonly allowSynonymAfterCorrection?: boolean;
  readonly registry?: DataSearchExecutionRegistryOptionsV7;
  readonly fuzzy?: FuzzyLexiconPolicyV8;
  readonly correction?: QueryCorrectionPolicyV8;
  readonly synonyms?: SynonymRegistryPolicyV8;
  readonly synonymGroups?: readonly SynonymGroupInputV8[];
}

export interface SearchRecoveryAttemptV8 {
  readonly ordinal: number;
  readonly mode: SearchRecoveryModeV8;
  readonly query: string;
  readonly fingerprint: string;
  readonly resultCount: number;
  readonly blocked: boolean;
  readonly cacheHit: boolean;
}

export interface SearchRecoveryDiagnosticsV8 {
  readonly version: typeof SEARCH_RECOVERY_VERSION_V8;
  readonly datasetKey: string;
  readonly datasetRevision: number;
  readonly datasetFingerprint: string;
  readonly originalQuery: string;
  readonly executedQuery: string;
  readonly mode: SearchRecoveryModeV8;
  readonly recovered: boolean;
  readonly attemptedRecovery: boolean;
  readonly skipReason: SearchRecoverySkipReasonV8 | null;
  readonly primaryResultCount: number;
  readonly finalResultCount: number;
  readonly attempts: readonly SearchRecoveryAttemptV8[];
  readonly correctionFingerprint: string | null;
  readonly requestFingerprint: string;
}

export interface SearchRecoveryResultV8 {
  readonly response: SearchResponse;
  readonly primary: DataSearchExecutionSearchResultV7;
  readonly final: DataSearchExecutionSearchResultV7;
  readonly correction: QueryCorrectionResultV8 | null;
  readonly diagnostics: SearchRecoveryDiagnosticsV8;
}

export interface SearchRecoveryRegistrationV8 extends DataSearchExecutionRegistrationV7 {
  readonly lexiconTerms: number;
  readonly lexiconFingerprint: string;
  readonly correctionFingerprint: string;
}

export interface SearchRecoveryDatasetSnapshotV8 {
  readonly key: string;
  readonly revision: number;
  readonly fingerprint: string;
  readonly lexiconTerms: number;
  readonly lexiconFingerprint: string;
  readonly correctionFingerprint: string;
}

export interface SearchRecoverySnapshotV8 {
  readonly version: typeof SEARCH_RECOVERY_VERSION_V8;
  readonly datasets: number;
  readonly sessions: number;
  readonly searches: number;
  readonly recoveryAttempts: number;
  readonly recoveredSearches: number;
  readonly correctedSearches: number;
  readonly synonymSearches: number;
  readonly skippedSearches: number;
  readonly registry: DataSearchExecutionRegistrySnapshotV7;
  readonly datasetsState: readonly SearchRecoveryDatasetSnapshotV8[];
  readonly fingerprint: string;
}

interface NormalizedRecoveryPolicyV8 {
  readonly minimumPrimaryResults: number;
  readonly maximumAttempts: number;
  readonly maximumDatasets: number;
  readonly enableCorrection: boolean;
  readonly enableSynonyms: boolean;
  readonly enableDefaultCivicSynonyms: boolean;
  readonly allowSynonymAfterCorrection: boolean;
  readonly registry: DataSearchExecutionRegistryOptionsV7;
  readonly fuzzy: FuzzyLexiconPolicyV8;
  readonly correction: QueryCorrectionPolicyV8;
  readonly synonyms: SynonymRegistryPolicyV8;
  readonly synonymGroups: readonly SynonymGroupInputV8[];
}

interface RecoveryDatasetEntryV8 {
  readonly dataset: DatasetSnapshot;
  readonly lexicon: FuzzyLexiconRuntimeV8;
  readonly correction: QueryCorrectionRuntimeV8;
}

interface MutableRecoveryStatsV8 {
  searches: number;
  recoveryAttempts: number;
  recoveredSearches: number;
  correctedSearches: number;
  synonymSearches: number;
  skippedSearches: number;
}

const normalizePolicy = (input: SearchRecoveryPolicyV8 = {}): NormalizedRecoveryPolicyV8 => {
  const maximumDatasets = normalizeInteger(input.maximumDatasets, {
    min: 1,
    max: 1_024,
    fallback: input.registry?.maximumDatasets ?? 32,
  });
  return Object.freeze({
    minimumPrimaryResults: normalizeInteger(input.minimumPrimaryResults, {
      min: 0,
      max: 1_000,
      fallback: 1,
    }),
    maximumAttempts: normalizeInteger(input.maximumAttempts, {
      min: 1,
      max: 3,
      fallback: 3,
    }),
    maximumDatasets,
    enableCorrection: input.enableCorrection !== false,
    enableSynonyms: input.enableSynonyms !== false,
    enableDefaultCivicSynonyms: input.enableDefaultCivicSynonyms !== false,
    allowSynonymAfterCorrection: input.allowSynonymAfterCorrection !== false,
    registry: Object.freeze({
      ...input.registry,
      maximumDatasets,
    }),
    fuzzy: Object.freeze({ ...input.fuzzy }),
    correction: Object.freeze({ ...input.correction }),
    synonyms: Object.freeze({ ...input.synonyms }),
    synonymGroups: Object.freeze([...(input.synonymGroups ?? [])]),
  });
};

const canonicalDatasetKey = (value: unknown): string => normalizeSearchText(value)
  .replace(/[^a-z0-9_-]+/g, '-')
  .replace(/^-+|-+$/g, '')
  .slice(0, 160);

const resultCount = (result: DataSearchExecutionSearchResultV7): number => result.result.response.results.length;

const requestFingerprint = (
  dataset: DatasetSnapshot,
  request: SearchRequest,
): string => hashFingerprint(stableSerialize({
  version: SEARCH_RECOVERY_VERSION_V8,
  key: canonicalDatasetKey(dataset.key),
  revision: dataset.revision,
  fingerprint: dataset.fingerprint,
  query: normalizeSearchText(request.query),
  filters: request.filters ?? [],
  facets: request.facetFields ?? [],
  sort: request.sort ?? 'relevance',
  minScore: request.minScore ?? 0,
  offset: request.offset ?? 0,
  limit: request.limit ?? null,
  center: request.center ?? null,
  radiusMeters: request.radiusMeters ?? 0,
  level: request.level ?? null,
  district: normalizeSearchText(request.district),
  neighborhood: normalizeSearchText(request.neighborhood),
  street: normalizeSearchText(request.street),
}));

const cloneRequestWithQuery = (
  request: SearchRequest,
  query: string,
): SearchRequest => Object.freeze({ ...request, query });

const attemptFingerprint = (
  dataset: DatasetSnapshot,
  mode: SearchRecoveryModeV8,
  query: string,
): string => hashFingerprint(stableSerialize({
  version: SEARCH_RECOVERY_VERSION_V8,
  key: canonicalDatasetKey(dataset.key),
  revision: dataset.revision,
  fingerprint: dataset.fingerprint,
  mode,
  query: normalizeSearchText(query),
}));

const attemptFromResult = (
  dataset: DatasetSnapshot,
  ordinal: number,
  mode: SearchRecoveryModeV8,
  query: string,
  result: DataSearchExecutionSearchResultV7,
): SearchRecoveryAttemptV8 => Object.freeze({
  ordinal,
  mode,
  query,
  fingerprint: attemptFingerprint(dataset, mode, query),
  resultCount: resultCount(result),
  blocked: result.result.diagnostics.blocked,
  cacheHit: result.cacheHit,
});

const grammarProtected = (correction: QueryCorrectionResultV8): boolean => Boolean(
  correction.originalAnalysis.requiredTerms.length
  || correction.originalAnalysis.excludedTerms.length
  || correction.originalAnalysis.phrases.length
  || Object.values(correction.originalAnalysis.fieldTerms).some(values => values.length > 0),
);

const safeSynonymVariant = (
  correction: QueryCorrectionResultV8,
): string | null => {
  if (grammarProtected(correction)) return null;
  if (correction.expandedTerms.length <= correction.correctedAnalysis.positiveTerms.length) return null;
  const values = Array.from(new Set(correction.expandedTerms.map(normalizeSearchText).filter(Boolean)));
  const query = values.join(' ').trim();
  return query && query !== normalizeSearchText(correction.correctedQuery) ? query : null;
};

const recoveryEligible = (
  request: SearchRequest,
  primary: DataSearchExecutionSearchResultV7,
  minimumPrimaryResults: number,
): SearchRecoverySkipReasonV8 | null => {
  const query = normalizeSearchText(request.query);
  if (!query) return 'empty-query';
  if (primary.result.diagnostics.blocked) return 'blocked-primary';
  if (primary.result.intent.kind === 'coordinate') return 'coordinate-intent';
  if (request.center) return 'explicit-center';
  if (resultCount(primary) >= minimumPrimaryResults) return 'not-needed';
  return null;
};

const combineSynonymGroups = (policy: NormalizedRecoveryPolicyV8): readonly SynonymGroupInputV8[] => {
  const groups: SynonymGroupInputV8[] = [];
  if (policy.enableDefaultCivicSynonyms) groups.push(...createDefaultCivicSynonymsV8());
  groups.push(...policy.synonymGroups);
  return Object.freeze(groups);
};

const datasetEntry = (
  dataset: DatasetSnapshot,
  policy: NormalizedRecoveryPolicyV8,
): RecoveryDatasetEntryV8 => {
  const terms = createFuzzyLexiconTermsFromRecordsV8(
    dataset.records,
    canonicalDatasetKey(dataset.key) || 'dataset',
  );
  const lexicon = new FuzzyLexiconRuntimeV8(terms, policy.fuzzy);
  const synonyms = policy.enableSynonyms
    ? new SynonymRegistryRuntimeV8(combineSynonymGroups(policy), policy.synonyms)
    : null;
  const correction = new QueryCorrectionRuntimeV8(lexicon, synonyms, policy.correction);
  return Object.freeze({ dataset, lexicon, correction });
};

const sameDataset = (left: DatasetSnapshot, right: DatasetSnapshot): boolean =>
  left.key === right.key
  && left.revision === right.revision
  && left.fingerprint === right.fingerprint;

const finalDiagnostics = (
  dataset: DatasetSnapshot,
  request: SearchRequest,
  primary: DataSearchExecutionSearchResultV7,
  finalResult: DataSearchExecutionSearchResultV7,
  mode: SearchRecoveryModeV8,
  correction: QueryCorrectionResultV8 | null,
  attempts: readonly SearchRecoveryAttemptV8[],
  skipReason: SearchRecoverySkipReasonV8 | null,
): SearchRecoveryDiagnosticsV8 => Object.freeze({
  version: SEARCH_RECOVERY_VERSION_V8,
  datasetKey: canonicalDatasetKey(dataset.key),
  datasetRevision: dataset.revision,
  datasetFingerprint: dataset.fingerprint,
  originalQuery: String(request.query ?? ''),
  executedQuery: attempts[attempts.length - 1]?.query ?? String(request.query ?? ''),
  mode,
  recovered: finalResult !== primary && resultCount(finalResult) > resultCount(primary),
  attemptedRecovery: attempts.length > 1,
  skipReason,
  primaryResultCount: resultCount(primary),
  finalResultCount: resultCount(finalResult),
  attempts,
  correctionFingerprint: correction?.fingerprint ?? null,
  requestFingerprint: requestFingerprint(dataset, request),
});

export class SearchRecoveryRuntimeV8 {
  readonly #policy: NormalizedRecoveryPolicyV8;
  readonly #registry: DataSearchExecutionRegistryV7;
  readonly #datasets = new Map<string, RecoveryDatasetEntryV8>();
  readonly #sessions = new Set<SearchSession>();
  readonly #stats: MutableRecoveryStatsV8 = {
    searches: 0,
    recoveryAttempts: 0,
    recoveredSearches: 0,
    correctedSearches: 0,
    synonymSearches: 0,
    skippedSearches: 0,
  };
  #disposed = false;

  constructor(policyInput: SearchRecoveryPolicyV8 = {}) {
    this.#policy = normalizePolicy(policyInput);
    this.#registry = new DataSearchExecutionRegistryV7(this.#policy.registry);
  }

  #ensureActive(): void {
    if (this.#disposed) throw new Error('SearchRecoveryRuntimeV8 has been disposed');
  }

  #require(datasetKeyInput: unknown): RecoveryDatasetEntryV8 {
    const key = canonicalDatasetKey(datasetKeyInput);
    const entry = this.#datasets.get(key);
    if (!entry) throw new Error(`Unknown v8 recovery dataset: ${key || '<empty>'}`);
    this.#datasets.delete(key);
    this.#datasets.set(key, entry);
    return entry;
  }

  register(dataset: DatasetSnapshot): SearchRecoveryRegistrationV8 {
    this.#ensureActive();
    const key = canonicalDatasetKey(dataset.key);
    if (!key) throw new TypeError('v8 recovery dataset key is required');
    const previous = this.#datasets.get(key) ?? null;
    const registration = this.#registry.register(dataset);
    if (previous && sameDataset(previous.dataset, dataset)) {
      this.#datasets.delete(key);
      this.#datasets.set(key, previous);
      return Object.freeze({
        ...registration,
        lexiconTerms: previous.lexicon.snapshot().termCount,
        lexiconFingerprint: previous.lexicon.snapshot().fingerprint,
        correctionFingerprint: previous.correction.snapshot().fingerprint,
      });
    }
    if (registration.evictedDatasetKey) this.#datasets.delete(registration.evictedDatasetKey);
    const entry = datasetEntry(dataset, this.#policy);
    this.#datasets.delete(key);
    this.#datasets.set(key, entry);
    while (this.#datasets.size > this.#policy.maximumDatasets) {
      const oldest = this.#datasets.keys().next().value as string | undefined;
      if (!oldest) break;
      this.#datasets.delete(oldest);
    }
    return Object.freeze({
      ...registration,
      lexiconTerms: entry.lexicon.snapshot().termCount,
      lexiconFingerprint: entry.lexicon.snapshot().fingerprint,
      correctionFingerprint: entry.correction.snapshot().fingerprint,
    });
  }

  search(datasetKeyInput: unknown, request: SearchRequest = {}): SearchRecoveryResultV8 {
    this.#ensureActive();
    throwIfAborted(request.signal);
    const entry = this.#require(datasetKeyInput);
    this.#stats.searches += 1;
    const attempts: SearchRecoveryAttemptV8[] = [];
    const primary = this.#registry.search(entry.dataset.key, request);
    attempts.push(attemptFromResult(entry.dataset, 1, 'none', String(request.query ?? ''), primary));
    const skipReason = recoveryEligible(request, primary, this.#policy.minimumPrimaryResults);
    if (skipReason) {
      this.#stats.skippedSearches += 1;
      return Object.freeze({
        response: primary.result.response,
        primary,
        final: primary,
        correction: null,
        diagnostics: finalDiagnostics(entry.dataset, request, primary, primary, 'none', null, attempts, skipReason),
      });
    }

    const correction = entry.correction.correct(request.query);
    let best = primary;
    let mode: SearchRecoveryModeV8 = 'none';
    let attemptsUsed = 1;
    let attemptedCorrection = false;

    if (this.#policy.enableCorrection && correction.changed && attemptsUsed < this.#policy.maximumAttempts) {
      throwIfAborted(request.signal);
      attemptedCorrection = true;
      this.#stats.recoveryAttempts += 1;
      attemptsUsed += 1;
      const correctedRequest = cloneRequestWithQuery(request, correction.correctedQuery);
      const corrected = this.#registry.search(entry.dataset.key, correctedRequest);
      attempts.push(attemptFromResult(
        entry.dataset,
        attemptsUsed,
        'corrected',
        correction.correctedQuery,
        corrected,
      ));
      if (!corrected.result.diagnostics.blocked && resultCount(corrected) > resultCount(best)) {
        best = corrected;
        mode = 'corrected';
        this.#stats.correctedSearches += 1;
      }
    }

    const synonymVariant = this.#policy.enableSynonyms
      ? safeSynonymVariant(correction)
      : null;
    const synonymAllowed = synonymVariant
      && attemptsUsed < this.#policy.maximumAttempts
      && (!attemptedCorrection || this.#policy.allowSynonymAfterCorrection);
    if (synonymAllowed) {
      throwIfAborted(request.signal);
      this.#stats.recoveryAttempts += 1;
      attemptsUsed += 1;
      const synonymRequest = cloneRequestWithQuery(request, synonymVariant);
      const synonym = this.#registry.search(entry.dataset.key, synonymRequest);
      const synonymMode: SearchRecoveryModeV8 = attemptedCorrection ? 'corrected-synonym' : 'synonym';
      attempts.push(attemptFromResult(entry.dataset, attemptsUsed, synonymMode, synonymVariant, synonym));
      if (!synonym.result.diagnostics.blocked && resultCount(synonym) > resultCount(best)) {
        best = synonym;
        mode = synonymMode;
        this.#stats.synonymSearches += 1;
      }
    }

    if (best !== primary) this.#stats.recoveredSearches += 1;
    let terminalSkip: SearchRecoverySkipReasonV8 | null = null;
    if (best === primary) {
      if (!correction.changed && grammarProtected(correction)) terminalSkip = 'grammar-protected';
      else if (!correction.changed) terminalSkip = 'correction-unchanged';
      else if (attemptsUsed >= this.#policy.maximumAttempts) terminalSkip = 'attempt-budget';
    }
    const diagnostics = finalDiagnostics(
      entry.dataset,
      request,
      primary,
      best,
      mode,
      correction,
      Object.freeze(attempts),
      terminalSkip,
    );
    return Object.freeze({
      response: best.result.response,
      primary,
      final: best,
      correction,
      diagnostics,
    });
  }

  searchResponse(datasetKeyInput: unknown, request: SearchRequest = {}): SearchResponse {
    return this.search(datasetKeyInput, request).response;
  }

  createSession(options: SearchSessionOptions = {}): SearchSession {
    this.#ensureActive();
    const session = createSearchSession(
      (datasetKey, request) => this.searchResponse(datasetKey, request),
      options,
    );
    this.#sessions.add(session);
    const dispose = session.dispose.bind(session);
    session.dispose = (): void => {
      dispose();
      this.#sessions.delete(session);
    };
    return session;
  }

  remove(datasetKeyInput: unknown): boolean {
    this.#ensureActive();
    const key = canonicalDatasetKey(datasetKeyInput);
    this.#datasets.delete(key);
    return this.#registry.remove(key);
  }

  datasetKeys(): readonly string[] {
    this.#ensureActive();
    return this.#registry.datasetKeys();
  }

  correction(datasetKeyInput: unknown): QueryCorrectionRuntimeV8 {
    this.#ensureActive();
    return this.#require(datasetKeyInput).correction;
  }

  lexicon(datasetKeyInput: unknown): FuzzyLexiconRuntimeV8 {
    this.#ensureActive();
    return this.#require(datasetKeyInput).lexicon;
  }

  snapshot(): SearchRecoverySnapshotV8 {
    this.#ensureActive();
    const datasetsState = Object.freeze(Array.from(this.#datasets.entries()).map(([key, entry]) => {
      const lexicon = entry.lexicon.snapshot();
      const correction = entry.correction.snapshot();
      return Object.freeze({
        key,
        revision: entry.dataset.revision,
        fingerprint: entry.dataset.fingerprint,
        lexiconTerms: lexicon.termCount,
        lexiconFingerprint: lexicon.fingerprint,
        correctionFingerprint: correction.fingerprint,
      });
    }));
    return Object.freeze({
      version: SEARCH_RECOVERY_VERSION_V8,
      datasets: this.#datasets.size,
      sessions: this.#sessions.size,
      searches: this.#stats.searches,
      recoveryAttempts: this.#stats.recoveryAttempts,
      recoveredSearches: this.#stats.recoveredSearches,
      correctedSearches: this.#stats.correctedSearches,
      synonymSearches: this.#stats.synonymSearches,
      skippedSearches: this.#stats.skippedSearches,
      registry: this.#registry.snapshot(),
      datasetsState,
      fingerprint: hashFingerprint(stableSerialize({
        version: SEARCH_RECOVERY_VERSION_V8,
        policy: this.#policy,
        stats: this.#stats,
        datasets: datasetsState,
      })),
    });
  }

  dispose(): void {
    if (this.#disposed) return;
    for (const session of this.#sessions) session.dispose();
    this.#sessions.clear();
    this.#datasets.clear();
    this.#registry.dispose();
    this.#disposed = true;
  }
}

export const createSearchRecoveryRuntimeV8 = (
  policy: SearchRecoveryPolicyV8 = {},
): SearchRecoveryRuntimeV8 => new SearchRecoveryRuntimeV8(policy);
