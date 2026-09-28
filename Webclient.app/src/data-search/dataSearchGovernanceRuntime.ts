import type {
  NormalizedRecord,
  RecordAliasSchema,
  RecordNormalizationOptions,
  SearchFilter,
  SpatialHit,
} from './contracts';
import {
  hashFingerprint,
  normalizeInteger,
  normalizeRecordCollection,
  normalizeSearchText,
  normalizeText,
  stableSerialize,
} from './normalization';
import {
  CategoryOntologyRuntime,
  type CategoryCoverageReport,
  type CategoryOntologyEntry,
  type CategoryOntologyOptions,
  type CategoryResolution,
} from './categoryOntologyRuntime';
import {
  FilterIndexRuntime,
  defaultSearchFilterFields,
  type FilterExecutionPlan,
  type FilterIndexFieldConfig,
  type FilterIndexOptions,
} from './filterIndexRuntime';
import {
  RevisionedSearchCache,
  type SearchCacheGetResult,
  type SearchCacheOptions,
  type SearchCacheSetResult,
} from './revisionedSearchCache';
import {
  SchemaRegistryRuntime,
  type SchemaContractInput,
  type SchemaRegistryEvaluation,
  type SchemaRegistryOptions,
} from './schemaRegistryRuntime';
import {
  createSpatialCursorPage,
  type SpatialCursorContext,
  type SpatialCursorPage,
} from './spatialCursorRuntime';

export interface DataSearchGovernanceOptions {
  readonly maxDatasets?: number;
  readonly normalization?: RecordNormalizationOptions;
  readonly categories?: CategoryOntologyOptions;
  readonly categoryEntries?: readonly CategoryOntologyEntry[];
  readonly filterIndex?: FilterIndexOptions;
  readonly filterFields?: readonly FilterIndexFieldConfig[];
  readonly schema?: SchemaRegistryOptions;
  readonly cache?: SearchCacheOptions;
}

export interface DataSearchDatasetInput {
  readonly key: string;
  readonly version: string;
  readonly records: unknown;
  readonly aliases?: RecordAliasSchema;
  readonly expectedRevision?: number | null;
  readonly observedAt?: number;
}

export interface GovernedDatasetSnapshot {
  readonly key: string;
  readonly version: string;
  readonly revision: number;
  readonly fingerprint: string;
  readonly records: readonly NormalizedRecord[];
  readonly recordCount: number;
  readonly qualityFingerprint: string;
  readonly schema: SchemaRegistryEvaluation;
  readonly categoryCoverage: CategoryCoverageReport;
  readonly filterIndexFingerprint: string;
  readonly observedAt: number;
}

export interface DataSearchDatasetRegistration {
  readonly accepted: boolean;
  readonly reason: 'accepted' | 'schema-rejected' | 'dataset-capacity';
  readonly snapshot: GovernedDatasetSnapshot | null;
  readonly schema: SchemaRegistryEvaluation;
  readonly invalidatedCacheEntries: number;
}

export interface DataSearchGovernanceSnapshot {
  readonly version: 1;
  readonly datasetCount: number;
  readonly categoryFingerprint: string;
  readonly schemaFingerprint: string;
  readonly cacheFingerprint: string;
  readonly fingerprint: string;
  readonly datasets: readonly Readonly<{
    key: string;
    version: string;
    revision: number;
    fingerprint: string;
    recordCount: number;
  }>[];
}

interface GovernedDatasetInternal {
  readonly snapshot: GovernedDatasetSnapshot;
  readonly filterIndex: FilterIndexRuntime;
}

interface NormalizedGovernanceOptions {
  readonly maxDatasets: number;
  readonly normalization: RecordNormalizationOptions;
  readonly filterFields: readonly FilterIndexFieldConfig[];
  readonly filterIndex: FilterIndexOptions;
}

const DEFAULT_MAX_DATASETS = 64;

const normalizeDatasetKey = (value: unknown): string => normalizeSearchText(value)
  .replace(/[^a-z0-9_-]+/g, '-')
  .replace(/^-+|-+$/g, '')
  .slice(0, 160);

const normalizeVersion = (value: unknown): string => normalizeText(value).slice(0, 120);

const normalizeObservedAt = (value: unknown): number => {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? Math.trunc(numeric) : Date.now();
};

const normalizeOptions = (
  options: DataSearchGovernanceOptions,
): NormalizedGovernanceOptions => Object.freeze({
  maxDatasets: normalizeInteger(options.maxDatasets, {
    min: 1,
    max: 1_024,
    fallback: DEFAULT_MAX_DATASETS,
  }),
  normalization: Object.freeze({ ...options.normalization }),
  filterFields: Object.freeze([...(options.filterFields ?? defaultSearchFilterFields())]),
  filterIndex: Object.freeze({ ...options.filterIndex }),
});

const createDatasetFingerprint = (records: readonly NormalizedRecord[]): string =>
  hashFingerprint(stableSerialize(records.map(record => [
    record.id,
    record.fingerprint,
    record.categoryKey,
    record.typeKey,
    record.coordinates,
  ])));

const createQualityFingerprint = (
  records: readonly NormalizedRecord[],
  issues: readonly unknown[],
): string => hashFingerprint(stableSerialize({
  records: records.map(record => record.fingerprint),
  issues,
}));

export class DataSearchGovernanceRuntime {
  readonly #options: NormalizedGovernanceOptions;
  readonly #categories: CategoryOntologyRuntime;
  readonly #schema: SchemaRegistryRuntime;
  readonly #cache: RevisionedSearchCache<unknown>;
  readonly #datasets = new Map<string, GovernedDatasetInternal>();

  constructor(options: DataSearchGovernanceOptions = {}) {
    this.#options = normalizeOptions(options);
    this.#categories = new CategoryOntologyRuntime(
      options.categoryEntries ?? [],
      options.categories,
    );
    this.#schema = new SchemaRegistryRuntime(options.schema);
    this.#cache = new RevisionedSearchCache<unknown>(options.cache);
  }

  registerDataset(input: DataSearchDatasetInput): DataSearchDatasetRegistration {
    const key = normalizeDatasetKey(input.key);
    const version = normalizeVersion(input.version);
    if (!key) throw new TypeError('Governed dataset key is required');
    if (!version) throw new TypeError('Governed dataset version is required');

    const schemaInput: SchemaContractInput = {
      datasetKey: key,
      version,
      records: input.records,
      ...(input.aliases ? { aliases: input.aliases } : {}),
      ...(input.expectedRevision === undefined
        ? {}
        : { expectedRevision: input.expectedRevision }),
      ...(input.observedAt === undefined ? {} : { observedAt: input.observedAt }),
    };
    const schema = this.#schema.register(schemaInput);
    if (schema.decision === 'rejected') {
      return Object.freeze({
        accepted: false,
        reason: 'schema-rejected',
        snapshot: null,
        schema,
        invalidatedCacheEntries: 0,
      });
    }

    const existing = this.#datasets.get(key) ?? null;
    if (!existing && this.#datasets.size >= this.#options.maxDatasets) {
      return Object.freeze({
        accepted: false,
        reason: 'dataset-capacity',
        snapshot: null,
        schema,
        invalidatedCacheEntries: 0,
      });
    }

    const normalized = normalizeRecordCollection(input.records, {
      ...this.#options.normalization,
      ...(input.aliases ? { schema: input.aliases } : {}),
    });
    const records = normalized.records;
    const fingerprint = createDatasetFingerprint(records);
    const filterIndex = new FilterIndexRuntime(
      records,
      this.#options.filterFields,
      this.#options.filterIndex,
    );
    const categoryCoverage = this.#categories.coverage(records);
    const observedAt = normalizeObservedAt(input.observedAt);
    const previousRevision = existing?.snapshot.revision ?? 0;
    const revision = existing?.snapshot.fingerprint === fingerprint
      ? previousRevision
      : previousRevision + 1;
    const snapshot: GovernedDatasetSnapshot = Object.freeze({
      key,
      version,
      revision,
      fingerprint,
      records,
      recordCount: records.length,
      qualityFingerprint: createQualityFingerprint(records, normalized.quality.issues),
      schema,
      categoryCoverage,
      filterIndexFingerprint: filterIndex.snapshot().fingerprint,
      observedAt,
    });
    const invalidatedCacheEntries = existing && (
      existing.snapshot.revision !== revision
      || existing.snapshot.fingerprint !== fingerprint
    )
      ? this.#cache.invalidateRevision(key, revision, fingerprint)
      : 0;
    this.#datasets.delete(key);
    this.#datasets.set(key, Object.freeze({ snapshot, filterIndex }));
    return Object.freeze({
      accepted: true,
      reason: 'accepted',
      snapshot,
      schema,
      invalidatedCacheEntries,
    });
  }

  dataset(keyInput: unknown): GovernedDatasetSnapshot | null {
    const key = normalizeDatasetKey(keyInput);
    return this.#datasets.get(key)?.snapshot ?? null;
  }

  records(keyInput: unknown): readonly NormalizedRecord[] {
    return this.dataset(keyInput)?.records ?? Object.freeze([]);
  }

  resolveCategory(record: NormalizedRecord): CategoryResolution {
    return this.#categories.resolveRecord(record);
  }

  categoryCoverage(keyInput: unknown): CategoryCoverageReport | null {
    return this.dataset(keyInput)?.categoryCoverage ?? null;
  }

  replaceCategoryOntology(entries: readonly CategoryOntologyEntry[]): void {
    this.#categories.replace(entries);
    for (const [key, internal] of this.#datasets) {
      const coverage = this.#categories.coverage(internal.snapshot.records);
      const nextSnapshot = Object.freeze({
        ...internal.snapshot,
        categoryCoverage: coverage,
      });
      this.#datasets.set(key, Object.freeze({
        snapshot: nextSnapshot,
        filterIndex: internal.filterIndex,
      }));
    }
  }

  planFilters(
    datasetKeyInput: unknown,
    filters: readonly SearchFilter[],
  ): FilterExecutionPlan {
    const key = normalizeDatasetKey(datasetKeyInput);
    const internal = this.#datasets.get(key);
    if (!internal) {
      return Object.freeze({
        strategy: 'empty' as const,
        positions: Object.freeze([]),
        indexedFilterCount: 0,
        residualFilterCount: filters.length,
        estimatedScanCount: 0,
        truncated: false,
        steps: Object.freeze([]),
        fingerprint: hashFingerprint(stableSerialize({ key, missing: true, filters })),
      });
    }
    return internal.filterIndex.plan(filters);
  }

  candidateRecords(
    datasetKeyInput: unknown,
    filters: readonly SearchFilter[],
  ): readonly NormalizedRecord[] {
    const key = normalizeDatasetKey(datasetKeyInput);
    return this.#datasets.get(key)?.filterIndex.candidates(filters) ?? Object.freeze([]);
  }

  cacheGet<T>(
    datasetKeyInput: unknown,
    requestFingerprint: string,
    windowFingerprint?: string | null,
    namespace?: string | null,
  ): SearchCacheGetResult<T> {
    const dataset = this.dataset(datasetKeyInput);
    if (!dataset) {
      return Object.freeze({ hit: false, stale: false, value: null, entry: null });
    }
    const result = this.#cache.get({
      dataset: {
        datasetKey: dataset.key,
        revision: dataset.revision,
        fingerprint: dataset.fingerprint,
      },
      requestFingerprint,
      ...(windowFingerprint === undefined ? {} : { windowFingerprint }),
      ...(namespace === undefined ? {} : { namespace }),
    });
    return result as SearchCacheGetResult<T>;
  }

  cacheSet<T>(
    datasetKeyInput: unknown,
    requestFingerprint: string,
    value: T,
    options: {
      readonly windowFingerprint?: string | null;
      readonly namespace?: string | null;
      readonly ttlMs?: number;
    } = {},
  ): SearchCacheSetResult<T> {
    const dataset = this.dataset(datasetKeyInput);
    if (!dataset) {
      return Object.freeze({
        stored: false,
        reason: 'invalid-identity' as const,
        entry: null,
        evicted: 0,
      });
    }
    const result = this.#cache.set({
      dataset: {
        datasetKey: dataset.key,
        revision: dataset.revision,
        fingerprint: dataset.fingerprint,
      },
      requestFingerprint,
      ...(options.windowFingerprint === undefined
        ? {}
        : { windowFingerprint: options.windowFingerprint }),
      ...(options.namespace === undefined ? {} : { namespace: options.namespace }),
    }, value, options.ttlMs);
    return result as SearchCacheSetResult<T>;
  }

  spatialPage<TRecord extends NormalizedRecord>(
    datasetKeyInput: unknown,
    hits: readonly SpatialHit<TRecord>[],
    queryFingerprint: string,
    options: {
      readonly cursor?: string | null;
      readonly limit?: number;
      readonly now?: number;
      readonly maxAgeMs?: number;
    } = {},
  ): SpatialCursorPage<TRecord> {
    const dataset = this.dataset(datasetKeyInput);
    if (!dataset) {
      return Object.freeze({
        items: Object.freeze([]),
        count: 0,
        limit: normalizeInteger(options.limit, { min: 1, max: 500, fallback: 50 }),
        hasMore: false,
        nextCursor: null,
        datasetRevision: 0,
        queryFingerprint: normalizeText(queryFingerprint),
      });
    }
    const context: SpatialCursorContext = {
      dataset: {
        datasetKey: dataset.key,
        revision: dataset.revision,
        fingerprint: dataset.fingerprint,
      },
      queryFingerprint,
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.maxAgeMs === undefined ? {} : { maxAgeMs: options.maxAgeMs }),
    };
    return createSpatialCursorPage(hits, context, {
      ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
      ...(options.limit === undefined ? {} : { limit: options.limit }),
    });
  }

  removeDataset(keyInput: unknown): boolean {
    const key = normalizeDatasetKey(keyInput);
    const removed = this.#datasets.delete(key);
    if (removed) {
      this.#schema.remove(key);
      this.#cache.invalidateDataset(key);
    }
    return removed;
  }

  snapshot(): DataSearchGovernanceSnapshot {
    const datasets = [...this.#datasets.values()]
      .map(internal => Object.freeze({
        key: internal.snapshot.key,
        version: internal.snapshot.version,
        revision: internal.snapshot.revision,
        fingerprint: internal.snapshot.fingerprint,
        recordCount: internal.snapshot.recordCount,
      }))
      .sort((left, right) => left.key.localeCompare(right.key));
    const categoryFingerprint = this.#categories.snapshot().fingerprint;
    const schemaFingerprint = this.#schema.snapshot().fingerprint;
    const cacheFingerprint = this.#cache.stats().fingerprint;
    const fingerprint = hashFingerprint(stableSerialize({
      datasets,
      categoryFingerprint,
      schemaFingerprint,
      cacheFingerprint,
    }));
    return Object.freeze({
      version: 1 as const,
      datasetCount: datasets.length,
      categoryFingerprint,
      schemaFingerprint,
      cacheFingerprint,
      fingerprint,
      datasets: Object.freeze(datasets),
    });
  }
}

export const createDataSearchGovernanceRuntime = (
  options: DataSearchGovernanceOptions = {},
): DataSearchGovernanceRuntime => new DataSearchGovernanceRuntime(options);
