import type {
  DatasetSnapshot,
  RecordAliasSchema,
  RecordNormalizationOptions,
  SearchRequest,
  SearchResponse,
} from './contracts';
import type { IntegrityPolicy, IntegrityReport } from './dataIntegrity';
import type {
  DatasetCatalogEntry,
  DatasetCatalogOptions,
  DatasetSourceKind,
} from './datasetCatalog';
import type {
  ForwardGeocodeRequest,
  GeocodingExecutionOptions,
  GeocodingProvider,
  GeocodingRuntimeOptions,
  GeocodingRuntimeResult,
  ReverseGeocodeRequest,
} from './geocodingRuntime';
import type { SearchObservabilityOptions } from './searchObservability';
import type { QueryPlanOptions, CompiledQueryPlan } from './queryPlanRuntime';
import type { SchemaProfileOptions, SchemaMigrationStep } from './schemaEvolution';
import type { CursorPage } from './cursorPagination';
import type { SearchSessionOptions } from './searchSession';
import { DataSearchRuntime } from './searchRuntime';
import { evaluateDataIntegrity } from './dataIntegrity';
import { createDatasetCatalog, DatasetCatalog } from './datasetCatalog';
import { createGeocodingRuntime, GeocodingRuntime } from './geocodingRuntime';
import { createSearchObservability, SearchObservability } from './searchObservability';
import { compileQueryPlan } from './queryPlanRuntime';
import {
  applyCursorToSearchRequest,
  createCursorPage,
  cursorRequestFingerprint,
  type SearchCursorContext,
} from './cursorPagination';
import {
  profileDatasetSchema,
  SchemaMigrationRegistry,
} from './schemaEvolution';
import { createSearchSession, SearchSession } from './searchSession';
import {
  normalizeInteger,
  normalizeText,
} from './normalization';

export interface ProductionDataSearchOptions {
  readonly search?: ConstructorParameters<typeof DataSearchRuntime>[0];
  readonly catalog?: DatasetCatalogOptions;
  readonly geocoding?: GeocodingRuntimeOptions;
  readonly observability?: SearchObservabilityOptions;
  readonly queryPlan?: QueryPlanOptions;
  readonly schemaProfile?: SchemaProfileOptions;
  readonly defaultIntegrityPolicy?: IntegrityPolicy;
  readonly clock?: () => number;
}

export interface ProductionDatasetRegistrationOptions extends RecordNormalizationOptions {
  readonly title?: string;
  readonly sourceKind?: DatasetSourceKind;
  readonly sourceId?: string | null;
  readonly schemaVersion?: string;
  readonly aliases?: RecordAliasSchema;
  readonly tags?: readonly string[];
  readonly ttlMs?: number;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly integrityPolicy?: IntegrityPolicy;
  readonly includeQuarantined?: boolean;
  readonly allowReleaseBlocked?: boolean;
  readonly profileSchema?: boolean;
  readonly now?: number;
}

export interface ProductionDatasetRegistrationResult {
  readonly dataset: DatasetSnapshot;
  readonly catalog: DatasetCatalogEntry;
  readonly integrity: IntegrityReport;
  readonly indexedCount: number;
  readonly quarantinedExcludedCount: number;
}

export interface ProductionSearchResult {
  readonly response: SearchResponse;
  readonly plan: CompiledQueryPlan;
  readonly catalog: DatasetCatalogEntry | null;
}

export interface ProductionCursorSearchResult extends ProductionSearchResult {
  readonly cursorPage: CursorPage;
}

export interface ProductionRuntimeSnapshot {
  readonly search: ReturnType<DataSearchRuntime['snapshot']>;
  readonly catalog: ReturnType<DatasetCatalog['snapshot']>;
  readonly geocoding: ReturnType<GeocodingRuntime['snapshot']>;
  readonly observability: ReturnType<SearchObservability['snapshot']>;
  readonly performanceGate: ReturnType<SearchObservability['evaluate']>;
  readonly migrations: ReturnType<SchemaMigrationRegistry['snapshot']>;
  readonly sessions: number;
}

export interface MigrateDatasetOptions extends ProductionDatasetRegistrationOptions {
  readonly fromVersion: string;
  readonly toVersion: string;
}

const safeNow = (clock: () => number): number => {
  const value = Number(clock());
  return Number.isFinite(value) && value >= 0 ? Math.trunc(value) : Date.now();
};

const queryLength = (request: SearchRequest): number => normalizeText(request.query).length;

const isAbort = (error: unknown): boolean => error instanceof Error && error.name === 'AbortError';

export class ProductionDataSearchRuntime {
  readonly searchRuntime: DataSearchRuntime;
  readonly catalog: DatasetCatalog;
  readonly geocoding: GeocodingRuntime;
  readonly observability: SearchObservability;
  readonly migrations: SchemaMigrationRegistry;

  private readonly options: Readonly<{
    queryPlan: QueryPlanOptions;
    schemaProfile: SchemaProfileOptions;
    defaultIntegrityPolicy: IntegrityPolicy;
    clock: () => number;
  }>;
  private readonly sessions = new Set<SearchSession>();
  private disposed = false;

  constructor(options: ProductionDataSearchOptions = {}) {
    const clock = typeof options.clock === 'function' ? options.clock : () => Date.now();
    this.searchRuntime = new DataSearchRuntime({ ...options.search, clock: options.search?.clock ?? clock });
    this.catalog = createDatasetCatalog({ ...options.catalog, clock: options.catalog?.clock ?? clock });
    this.geocoding = createGeocodingRuntime({ ...options.geocoding, clock: options.geocoding?.clock ?? clock });
    this.observability = createSearchObservability({ ...options.observability, clock: options.observability?.clock ?? clock });
    this.migrations = new SchemaMigrationRegistry();
    this.options = Object.freeze({
      queryPlan: Object.freeze({ ...options.queryPlan }),
      schemaProfile: Object.freeze({ ...options.schemaProfile }),
      defaultIntegrityPolicy: Object.freeze({ ...options.defaultIntegrityPolicy }),
      clock,
    });
  }

  private now(): number {
    return safeNow(this.options.clock);
  }

  private ensureActive(): void {
    if (this.disposed) throw new Error('Production data search runtime has been disposed');
  }

  private resolveDatasetKey(datasetKeyInput: unknown): string {
    const catalogKey = this.catalog.resolveKey(datasetKeyInput);
    return catalogKey || normalizeText(datasetKeyInput);
  }

  private requireDataset(datasetKeyInput: unknown): DatasetSnapshot {
    const key = this.resolveDatasetKey(datasetKeyInput);
    const dataset = this.searchRuntime.get(key);
    if (!dataset) throw new Error(`Unknown production search dataset: ${key || '<empty>'}`);
    return dataset;
  }

  registerMigration(step: SchemaMigrationStep): void {
    this.ensureActive();
    this.migrations.register(step);
  }

  registerGeocodingProvider(provider: GeocodingProvider): () => void {
    this.ensureActive();
    return this.geocoding.register(provider);
  }

  registerDataset(
    datasetKeyInput: unknown,
    input: unknown,
    options: ProductionDatasetRegistrationOptions = {},
  ): ProductionDatasetRegistrationResult {
    this.ensureActive();
    const startedAt = this.now();
    const key = normalizeText(datasetKeyInput);
    if (!key) throw new TypeError('Dataset key is required');
    const schema = options.aliases ?? options.schema;
    const integrity = evaluateDataIntegrity(input, {
      ...(schema !== undefined ? { schema } : {}),
      dedupe: false,
      keepInvalid: true,
      ...(options.maxRecords !== undefined ? { maxRecords: options.maxRecords } : {}),
      policy: { ...this.options.defaultIntegrityPolicy, ...options.integrityPolicy },
    });
    if (!integrity.report.releaseReady && options.allowReleaseBlocked !== true) {
      const catalogEntry = this.catalog.register({
        key,
        ...(options.title !== undefined ? { title: options.title } : {}),
        ...(options.sourceKind !== undefined ? { sourceKind: options.sourceKind } : {}),
        ...(options.sourceId !== undefined ? { sourceId: options.sourceId } : {}),
        ...(options.schemaVersion !== undefined ? { schemaVersion: options.schemaVersion } : {}),
        ...(schema !== undefined ? { aliases: schema } : {}),
        ...(options.tags !== undefined ? { tags: options.tags } : {}),
        ...(options.ttlMs !== undefined ? { ttlMs: options.ttlMs } : {}),
        ...(options.metadata !== undefined ? { metadata: options.metadata } : {}),
        schemaProfile: options.profileSchema === false ? null : profileDatasetSchema(input, this.options.schemaProfile),
        integrity: integrity.report,
        state: 'quarantined',
        ...(options.now !== undefined ? { now: options.now } : {}),
      });
      this.observability.recordIntegrity(key, integrity.report, Math.max(0, this.now() - startedAt));
      throw Object.assign(new Error(`Dataset ${key} failed data-integrity release policy`), {
        code: 'DATASET_INTEGRITY_BLOCKED',
        catalog: catalogEntry,
        integrity: integrity.report,
      });
    }
    const recordsForIndex = options.includeQuarantined === true
      ? [...integrity.accepted, ...integrity.quarantined]
      : [...integrity.accepted];
    const sourceRecords = recordsForIndex.map(record => record.source);
    const dataset = this.searchRuntime.register(key, sourceRecords, {
      ...(schema !== undefined ? { schema } : {}),
      dedupe: true,
      keepInvalid: false,
      ...(options.maxRecords !== undefined ? { maxRecords: options.maxRecords } : {}),
      ...(options.now !== undefined ? { now: options.now } : {}),
    });
    const schemaProfile = options.profileSchema === false
      ? null
      : profileDatasetSchema(input, this.options.schemaProfile);
    const catalog = this.catalog.register({
      key,
      ...(options.title !== undefined ? { title: options.title } : {}),
      ...(options.sourceKind !== undefined ? { sourceKind: options.sourceKind } : {}),
      ...(options.sourceId !== undefined ? { sourceId: options.sourceId } : {}),
      ...(options.schemaVersion !== undefined ? { schemaVersion: options.schemaVersion } : {}),
      ...(schema !== undefined ? { aliases: schema } : {}),
      ...(options.tags !== undefined ? { tags: options.tags } : {}),
      ...(options.ttlMs !== undefined ? { ttlMs: options.ttlMs } : {}),
      metadata: {
        ...options.metadata,
        searchRevision: dataset.revision,
        searchFingerprint: dataset.fingerprint,
      },
      schemaProfile,
      integrity: integrity.report,
      state: integrity.report.releaseReady ? 'active' : 'quarantined',
      ...(options.now !== undefined ? { now: options.now } : {}),
    });
    this.observability.recordIntegrity(key, integrity.report, Math.max(0, this.now() - startedAt));
    return Object.freeze({
      dataset,
      catalog,
      integrity: integrity.report,
      indexedCount: dataset.records.length,
      quarantinedExcludedCount: options.includeQuarantined === true ? 0 : integrity.quarantined.length,
    });
  }

  migrateAndRegisterDataset(
    datasetKeyInput: unknown,
    input: unknown,
    options: MigrateDatasetOptions,
  ): ProductionDatasetRegistrationResult {
    this.ensureActive();
    const migration = this.migrations.migrate(
      datasetKeyInput,
      input,
      options.fromVersion,
      options.toVersion,
    );
    if (migration.rejectedCount > 0 && options.allowReleaseBlocked !== true) {
      throw Object.assign(new Error('Schema migration rejected one or more records'), {
        code: 'SCHEMA_MIGRATION_REJECTED',
        migration,
      });
    }
    return this.registerDataset(datasetKeyInput, migration.records, {
      ...options,
      schemaVersion: options.toVersion,
      metadata: {
        ...options.metadata,
        migrationPath: migration.path,
        migrationRejectedCount: migration.rejectedCount,
      },
    });
  }

  plan(datasetKeyInput: unknown, request: SearchRequest = {}): CompiledQueryPlan {
    this.ensureActive();
    return compileQueryPlan(this.requireDataset(datasetKeyInput), request, this.options.queryPlan);
  }

  search(datasetKeyInput: unknown, request: SearchRequest = {}): ProductionSearchResult {
    this.ensureActive();
    const dataset = this.requireDataset(datasetKeyInput);
    const startedAt = this.now();
    let plan: CompiledQueryPlan | null = null;
    try {
      plan = compileQueryPlan(dataset, request, this.options.queryPlan);
      const response = this.searchRuntime.search(dataset.key, request);
      this.observability.recordSearch(
        dataset.key,
        queryLength(request),
        response,
        Math.max(0, this.now() - startedAt),
        plan,
      );
      return Object.freeze({
        response,
        plan,
        catalog: this.catalog.get(dataset.key),
      });
    } catch (error) {
      this.observability.recordFailure(
        'search',
        dataset.key,
        Math.max(0, this.now() - startedAt),
        { aborted: isAbort(error), queryLength: queryLength(request) },
      );
      throw error;
    }
  }

  searchPage(
    datasetKeyInput: unknown,
    requestInput: SearchRequest = {},
    cursorToken?: string | null,
  ): ProductionCursorSearchResult {
    this.ensureActive();
    const dataset = this.requireDataset(datasetKeyInput);
    const baseRequest = Object.freeze({ ...requestInput, offset: 0 });
    const querySignature = cursorRequestFingerprint(dataset.key, dataset.revision, baseRequest);
    const context: SearchCursorContext = Object.freeze({
      datasetKey: dataset.key,
      datasetRevision: dataset.revision,
      datasetFingerprint: dataset.fingerprint,
      querySignature,
      now: this.now(),
    });
    const request = cursorToken
      ? applyCursorToSearchRequest(baseRequest, cursorToken, context)
      : requestInput;
    const startedAt = this.now();
    try {
      const plan = compileQueryPlan(dataset, request, this.options.queryPlan);
      const response = this.searchRuntime.search(dataset.key, request);
      const cursorPage = createCursorPage(response, context);
      this.observability.record({
        operation: 'search-page',
        durationMs: Math.max(0, this.now() - startedAt),
        datasetBucket: '',
        queryLengthBucket: '',
        candidateCount: response.diagnostics.candidateCount,
        resultCount: response.results.length,
        cacheHit: response.diagnostics.cacheHit,
        aborted: false,
        failed: false,
        planRisk: plan.risk,
        quarantinedCount: 0,
        rejectedCount: 0,
      });
      return Object.freeze({
        response,
        plan,
        cursorPage,
        catalog: this.catalog.get(dataset.key),
      });
    } catch (error) {
      this.observability.recordFailure(
        'search-page',
        dataset.key,
        Math.max(0, this.now() - startedAt),
        { aborted: isAbort(error), queryLength: queryLength(request) },
      );
      throw error;
    }
  }

  createSession(options: SearchSessionOptions = {}): SearchSession {
    this.ensureActive();
    const session = createSearchSession(
      (datasetKey, request) => this.search(datasetKey, request).response,
      options,
    );
    this.sessions.add(session);
    const originalDispose = session.dispose.bind(session);
    session.dispose = (): void => {
      originalDispose();
      this.sessions.delete(session);
    };
    return session;
  }

  async geocodeForward(
    request: ForwardGeocodeRequest,
    options: GeocodingExecutionOptions = {},
  ): Promise<GeocodingRuntimeResult> {
    this.ensureActive();
    const startedAt = this.now();
    try {
      const result = await this.geocoding.forward(request, options);
      this.observability.record({
        operation: 'geocode-forward',
        durationMs: Math.max(0, this.now() - startedAt),
        datasetBucket: 'geocoding',
        queryLengthBucket: '',
        candidateCount: result.page.diagnostics.inputCount,
        resultCount: result.page.candidates.length,
        cacheHit: result.cacheHit,
        aborted: false,
        failed: false,
        planRisk: null,
        quarantinedCount: 0,
        rejectedCount: 0,
      });
      return result;
    } catch (error) {
      this.observability.recordFailure('geocode-forward', 'geocoding', Math.max(0, this.now() - startedAt), {
        aborted: isAbort(error),
        queryLength: request.query.length,
      });
      throw error;
    }
  }

  async geocodeReverse(
    request: ReverseGeocodeRequest,
    options: GeocodingExecutionOptions = {},
  ): Promise<GeocodingRuntimeResult> {
    this.ensureActive();
    const startedAt = this.now();
    try {
      const result = await this.geocoding.reverse(request, options);
      this.observability.record({
        operation: 'geocode-reverse',
        durationMs: Math.max(0, this.now() - startedAt),
        datasetBucket: 'geocoding',
        queryLengthBucket: 'empty',
        candidateCount: result.page.diagnostics.inputCount,
        resultCount: result.page.candidates.length,
        cacheHit: result.cacheHit,
        aborted: false,
        failed: false,
        planRisk: null,
        quarantinedCount: 0,
        rejectedCount: 0,
      });
      return result;
    } catch (error) {
      this.observability.recordFailure('geocode-reverse', 'geocoding', Math.max(0, this.now() - startedAt), {
        aborted: isAbort(error),
      });
      throw error;
    }
  }

  invalidate(datasetKeyInput: unknown): boolean {
    this.ensureActive();
    const key = this.resolveDatasetKey(datasetKeyInput);
    this.searchRuntime.invalidateCache(key);
    this.catalog.markStale(key);
    return Boolean(this.searchRuntime.get(key));
  }

  remove(datasetKeyInput: unknown): boolean {
    this.ensureActive();
    const key = this.resolveDatasetKey(datasetKeyInput);
    this.catalog.remove(key);
    return this.searchRuntime.remove(key);
  }

  diagnostics(): ProductionRuntimeSnapshot {
    return Object.freeze({
      search: this.searchRuntime.snapshot(),
      catalog: this.catalog.snapshot(),
      geocoding: this.geocoding.snapshot(),
      observability: this.observability.snapshot(),
      performanceGate: this.observability.evaluate(),
      migrations: this.migrations.snapshot(),
      sessions: this.sessions.size,
    });
  }

  dispose(): void {
    if (this.disposed) return;
    for (const session of this.sessions) session.dispose();
    this.sessions.clear();
    this.geocoding.abortAll();
    this.geocoding.clearCache();
    this.searchRuntime.clear();
    this.catalog.clear();
    this.disposed = true;
  }
}

export const createProductionDataSearchRuntime = (
  options: ProductionDataSearchOptions = {},
): ProductionDataSearchRuntime => new ProductionDataSearchRuntime(options);

export const normalizeProductionPageLimit = (value: unknown): number => normalizeInteger(value, {
  min: 1,
  max: 250,
  fallback: 50,
});
