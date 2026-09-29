import type { NormalizedRecord } from './contracts';
import { hashFingerprint, stableSerialize } from './normalization';
import {
  DataSearchQueryEngineV6,
  type DataSearchQueryEnginePolicy,
  type DataSearchQueryEngineSnapshotV6,
  type DataSearchQueryRequestV6,
  type DataSearchQueryResponseV6,
} from './dataSearchQueryEngineV6';
import type { FilterIndexFieldConfig } from './filterIndexRuntime';
import type { SearchSuggestionResult } from './searchSuggestionRuntime';

export interface SearchCorpusRuntimePolicyV6 {
  readonly maximumRecords: number;
  readonly maximumMutationsPerCommit: number;
  readonly maximumHistory: number;
  readonly requireExpectedRevision: boolean;
  readonly queryEngine: Partial<DataSearchQueryEnginePolicy>;
}

export interface SearchCorpusMutationV6 {
  readonly expectedRevision?: string | null;
  readonly nextRevision: string;
  readonly upserts?: readonly NormalizedRecord[];
  readonly removeKeys?: readonly string[];
}

export type SearchCorpusMutationReasonV6 =
  | 'committed'
  | 'revision-conflict'
  | 'expected-revision-required'
  | 'invalid-next-revision'
  | 'revision-not-advanced'
  | 'mutation-budget-exceeded'
  | 'record-capacity-exceeded'
  | 'duplicate-upsert-key'
  | 'unknown-remove-key'
  | 'empty-mutation'
  | 'engine-build-failed';

export interface SearchCorpusMutationDecisionV6 {
  readonly committed: boolean;
  readonly reason: SearchCorpusMutationReasonV6;
  readonly previousRevision: string;
  readonly revision: string;
  readonly recordCount: number;
  readonly upserted: number;
  readonly removed: number;
  readonly fingerprint: string;
  readonly detail: string | null;
}

export interface SearchCorpusHistoryEntryV6 extends SearchCorpusMutationDecisionV6 {
  readonly sequence: number;
}

export interface SearchCorpusRuntimeSnapshotV6 {
  readonly version: 6;
  readonly revision: string;
  readonly recordCount: number;
  readonly fingerprint: string;
  readonly sequence: number;
  readonly engine: DataSearchQueryEngineSnapshotV6;
  readonly historySize: number;
}

interface CorpusState {
  readonly revision: string;
  readonly records: readonly NormalizedRecord[];
  readonly byKey: ReadonlyMap<string, NormalizedRecord>;
  readonly fingerprint: string;
  readonly engine: DataSearchQueryEngineV6;
}

interface MutableApplyState {
  readonly byKey: Map<string, NormalizedRecord>;
  upserted: number;
  removed: number;
}

const DEFAULT_POLICY: SearchCorpusRuntimePolicyV6 = Object.freeze({
  maximumRecords: 200_000,
  maximumMutationsPerCommit: 25_000,
  maximumHistory: 128,
  requireExpectedRevision: true,
  queryEngine: Object.freeze({}),
});

const normalizeInteger = (value: number | undefined, fallback: number, minimum: number, maximum: number): number => {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`corpus policy integer must be between ${minimum} and ${maximum}`);
  }
  return value;
};

const normalizePolicy = (input: Partial<SearchCorpusRuntimePolicyV6>): SearchCorpusRuntimePolicyV6 => Object.freeze({
  maximumRecords: normalizeInteger(input.maximumRecords, DEFAULT_POLICY.maximumRecords, 1, 1_000_000),
  maximumMutationsPerCommit: normalizeInteger(input.maximumMutationsPerCommit, DEFAULT_POLICY.maximumMutationsPerCommit, 1, 250_000),
  maximumHistory: normalizeInteger(input.maximumHistory, DEFAULT_POLICY.maximumHistory, 0, 10_000),
  requireExpectedRevision: input.requireExpectedRevision ?? DEFAULT_POLICY.requireExpectedRevision,
  queryEngine: Object.freeze({ ...input.queryEngine }),
});

const normalizeRevision = (value: unknown): string => String(value ?? '').trim().slice(0, 256);

const recordKey = (record: NormalizedRecord): string => record.id ? `id:${record.id}` : `fp:${record.fingerprint}`;

const normalizeRemoveKey = (value: unknown): string => String(value ?? '').trim().slice(0, 1024);

const indexRecords = (records: readonly NormalizedRecord[], maximumRecords: number): ReadonlyMap<string, NormalizedRecord> => {
  if (records.length > maximumRecords) throw new RangeError(`record count exceeds maximumRecords=${maximumRecords}`);
  const byKey = new Map<string, NormalizedRecord>();
  for (const record of records) {
    const key = recordKey(record);
    if (byKey.has(key)) throw new TypeError(`duplicate corpus key: ${key}`);
    byKey.set(key, record);
  }
  return byKey;
};

const sortRecords = (records: readonly NormalizedRecord[]): readonly NormalizedRecord[] => Object.freeze(records.slice().sort((left, right) => {
  const source = left.sourceIndex - right.sourceIndex;
  if (source !== 0) return source;
  const title = left.title.localeCompare(right.title, 'tr-TR', { sensitivity: 'base' });
  if (title !== 0) return title;
  return left.fingerprint.localeCompare(right.fingerprint);
}));

const corpusFingerprint = (revision: string, records: readonly NormalizedRecord[]): string => hashFingerprint(stableSerialize({
  revision,
  records: records.map((record) => [recordKey(record), record.fingerprint]),
}));

const buildState = (
  recordsInput: readonly NormalizedRecord[],
  revision: string,
  policy: SearchCorpusRuntimePolicyV6,
  filterFields: readonly FilterIndexFieldConfig[] | undefined,
): CorpusState => {
  const records = sortRecords(recordsInput);
  const byKey = indexRecords(records, policy.maximumRecords);
  const enginePolicy: Partial<DataSearchQueryEnginePolicy> = {
    ...policy.queryEngine,
    maximumRecords: policy.maximumRecords,
  };
  const engine = filterFields
    ? new DataSearchQueryEngineV6(records, revision, enginePolicy, filterFields)
    : new DataSearchQueryEngineV6(records, revision, enginePolicy);
  return Object.freeze({
    revision,
    records,
    byKey,
    fingerprint: corpusFingerprint(revision, records),
    engine,
  });
};

const cloneMap = (source: ReadonlyMap<string, NormalizedRecord>): Map<string, NormalizedRecord> => {
  const target = new Map<string, NormalizedRecord>();
  for (const [key, record] of source) target.set(key, record);
  return target;
};

const mutationSize = (mutation: SearchCorpusMutationV6): number => (mutation.upserts?.length ?? 0) + (mutation.removeKeys?.length ?? 0);

const validateUpsertKeys = (upserts: readonly NormalizedRecord[]): string | null => {
  const seen = new Set<string>();
  for (const record of upserts) {
    const key = recordKey(record);
    if (seen.has(key)) return key;
    seen.add(key);
  }
  return null;
};

const applyRemovals = (
  state: MutableApplyState,
  removeKeys: readonly string[],
): string | null => {
  const seen = new Set<string>();
  for (const rawKey of removeKeys) {
    const key = normalizeRemoveKey(rawKey);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    if (!state.byKey.has(key)) return key;
    state.byKey.delete(key);
    state.removed += 1;
  }
  return null;
};

const applyUpserts = (
  state: MutableApplyState,
  upserts: readonly NormalizedRecord[],
): void => {
  for (const record of upserts) {
    state.byKey.set(recordKey(record), record);
    state.upserted += 1;
  }
};

const recordsFromMap = (source: ReadonlyMap<string, NormalizedRecord>): readonly NormalizedRecord[] => Object.freeze(Array.from(source.values()));

const decisionFingerprint = (
  previousRevision: string,
  revision: string,
  reason: SearchCorpusMutationReasonV6,
  upserted: number,
  removed: number,
  recordCount: number,
): string => hashFingerprint(stableSerialize({ previousRevision, revision, reason, upserted, removed, recordCount }));

const createDecision = (
  committed: boolean,
  reason: SearchCorpusMutationReasonV6,
  previousRevision: string,
  revision: string,
  recordCount: number,
  upserted: number,
  removed: number,
  detail: string | null,
): SearchCorpusMutationDecisionV6 => Object.freeze({
  committed,
  reason,
  previousRevision,
  revision,
  recordCount,
  upserted,
  removed,
  fingerprint: decisionFingerprint(previousRevision, revision, reason, upserted, removed, recordCount),
  detail,
});

export class SearchCorpusRuntimeV6 {
  readonly #policy: SearchCorpusRuntimePolicyV6;
  readonly #filterFields: readonly FilterIndexFieldConfig[] | undefined;
  readonly #history: SearchCorpusHistoryEntryV6[] = [];
  #state: CorpusState;
  #sequence = 0;

  constructor(
    records: readonly NormalizedRecord[],
    revisionInput: string,
    policyInput: Partial<SearchCorpusRuntimePolicyV6> = {},
    filterFields?: readonly FilterIndexFieldConfig[],
  ) {
    this.#policy = normalizePolicy(policyInput);
    const revision = normalizeRevision(revisionInput);
    if (!revision) throw new TypeError('initial corpus revision is required');
    this.#filterFields = filterFields ? Object.freeze(filterFields.slice()) : undefined;
    this.#state = buildState(records, revision, this.#policy, this.#filterFields);
  }

  policy(): SearchCorpusRuntimePolicyV6 {
    return this.#policy;
  }

  records(): readonly NormalizedRecord[] {
    return this.#state.records;
  }

  snapshot(): SearchCorpusRuntimeSnapshotV6 {
    return Object.freeze({
      version: 6,
      revision: this.#state.revision,
      recordCount: this.#state.records.length,
      fingerprint: this.#state.fingerprint,
      sequence: this.#sequence,
      engine: this.#state.engine.snapshot(),
      historySize: this.#history.length,
    });
  }

  history(): readonly SearchCorpusHistoryEntryV6[] {
    return Object.freeze(this.#history.slice());
  }

  search(request: DataSearchQueryRequestV6 = {}): DataSearchQueryResponseV6 {
    return this.#state.engine.search(request);
  }

  suggest(input: unknown, limit?: number): SearchSuggestionResult {
    return this.#state.engine.suggest(input, limit);
  }

  commit(mutation: SearchCorpusMutationV6): SearchCorpusMutationDecisionV6 {
    const previousRevision = this.#state.revision;
    const expectedRevision = normalizeRevision(mutation.expectedRevision);
    const nextRevision = normalizeRevision(mutation.nextRevision);
    const upserts = mutation.upserts ?? Object.freeze([]);
    const removeKeys = mutation.removeKeys ?? Object.freeze([]);
    const count = mutationSize(mutation);

    if (this.#policy.requireExpectedRevision && !expectedRevision) {
      return this.#record(createDecision(false, 'expected-revision-required', previousRevision, previousRevision, this.#state.records.length, 0, 0, null));
    }
    if (expectedRevision && expectedRevision !== previousRevision) {
      return this.#record(createDecision(false, 'revision-conflict', previousRevision, previousRevision, this.#state.records.length, 0, 0, `expected=${expectedRevision}`));
    }
    if (!nextRevision) {
      return this.#record(createDecision(false, 'invalid-next-revision', previousRevision, previousRevision, this.#state.records.length, 0, 0, null));
    }
    if (nextRevision === previousRevision) {
      return this.#record(createDecision(false, 'revision-not-advanced', previousRevision, previousRevision, this.#state.records.length, 0, 0, null));
    }
    if (count === 0) {
      return this.#record(createDecision(false, 'empty-mutation', previousRevision, previousRevision, this.#state.records.length, 0, 0, null));
    }
    if (count > this.#policy.maximumMutationsPerCommit) {
      return this.#record(createDecision(false, 'mutation-budget-exceeded', previousRevision, previousRevision, this.#state.records.length, 0, 0, `count=${count}`));
    }
    const duplicateKey = validateUpsertKeys(upserts);
    if (duplicateKey) {
      return this.#record(createDecision(false, 'duplicate-upsert-key', previousRevision, previousRevision, this.#state.records.length, 0, 0, duplicateKey));
    }

    const applying: MutableApplyState = { byKey: cloneMap(this.#state.byKey), upserted: 0, removed: 0 };
    const missingRemoveKey = applyRemovals(applying, removeKeys);
    if (missingRemoveKey) {
      return this.#record(createDecision(false, 'unknown-remove-key', previousRevision, previousRevision, this.#state.records.length, 0, 0, missingRemoveKey));
    }
    applyUpserts(applying, upserts);
    if (applying.byKey.size > this.#policy.maximumRecords) {
      return this.#record(createDecision(false, 'record-capacity-exceeded', previousRevision, previousRevision, this.#state.records.length, 0, 0, `count=${applying.byKey.size}`));
    }

    let nextState: CorpusState;
    try {
      nextState = buildState(recordsFromMap(applying.byKey), nextRevision, this.#policy, this.#filterFields);
    } catch (error) {
      const detail = error instanceof Error ? error.message.slice(0, 512) : 'unknown build error';
      return this.#record(createDecision(false, 'engine-build-failed', previousRevision, previousRevision, this.#state.records.length, 0, 0, detail));
    }
    this.#state = nextState;
    return this.#record(createDecision(true, 'committed', previousRevision, nextRevision, nextState.records.length, applying.upserted, applying.removed, null));
  }

  #record(decision: SearchCorpusMutationDecisionV6): SearchCorpusMutationDecisionV6 {
    this.#sequence += 1;
    if (this.#policy.maximumHistory > 0) {
      this.#history.push(Object.freeze({ ...decision, sequence: this.#sequence }));
      if (this.#history.length > this.#policy.maximumHistory) {
        this.#history.splice(0, this.#history.length - this.#policy.maximumHistory);
      }
    }
    return decision;
  }
}
