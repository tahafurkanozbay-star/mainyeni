import type {
  DataQualitySummary,
  NormalizedRecord,
  RecordAliasSchema,
  RecordNormalizationOptions,
} from './contracts';
import {
  createDatasetFingerprint,
  hashFingerprint,
  normalizeInteger,
  normalizeRecordCollection,
  normalizeSearchText,
  normalizeText,
} from './normalization';
import {
  compareSchemaProfiles,
  profileDatasetSchema,
  type DatasetSchemaProfile,
  type SchemaCompatibility,
  type SchemaDriftReport,
  type SchemaProfileOptions,
} from './schemaEvolution';

export const DATASET_DELTA_VERSION = '2026-09-24.v1';

export type DatasetSchemaEnforcement = 'ignore' | 'warn' | 'reject-breaking' | 'reject-warning';
export type DatasetDeltaOperationKind = 'insert' | 'update' | 'remove' | 'noop';

export interface DatasetDeltaRuntimeOptions extends RecordNormalizationOptions {
  readonly datasetKey?: string;
  readonly maxRecords?: number;
  readonly maxBatchOperations?: number;
  readonly historySize?: number;
  readonly schemaEnforcement?: DatasetSchemaEnforcement;
  readonly schemaProfile?: SchemaProfileOptions;
  readonly clock?: () => number;
}

export interface DatasetDeltaMutation {
  readonly expectedRevision?: number | null;
  readonly upserts?: readonly unknown[];
  readonly removeKeys?: readonly string[];
  readonly schemaEnforcement?: DatasetSchemaEnforcement;
  readonly metadata?: Readonly<Record<string, string | number | boolean | null>>;
}

export interface DatasetDeltaOperation {
  readonly kind: DatasetDeltaOperationKind;
  readonly key: string;
  readonly beforeFingerprint: string | null;
  readonly afterFingerprint: string | null;
  readonly sourceIndex: number | null;
}

export interface DatasetDeltaPreview {
  readonly version: string;
  readonly datasetKey: string;
  readonly currentRevision: number;
  readonly nextRevision: number;
  readonly accepted: boolean;
  readonly changed: boolean;
  readonly inputUpsertCount: number;
  readonly inputRemoveCount: number;
  readonly insertCount: number;
  readonly updateCount: number;
  readonly removeCount: number;
  readonly noopCount: number;
  readonly duplicateMutationCount: number;
  readonly beforeCount: number;
  readonly afterCount: number;
  readonly beforeFingerprint: string;
  readonly afterFingerprint: string;
  readonly schemaCompatibility: SchemaCompatibility;
  readonly schemaReport: SchemaDriftReport;
  readonly quality: DataQualitySummary;
  readonly operations: readonly DatasetDeltaOperation[];
  readonly rejectionReasons: readonly string[];
  readonly metadata: Readonly<Record<string, string | number | boolean | null>>;
}

export interface DatasetDeltaCommit extends DatasetDeltaPreview {
  readonly committedAt: number;
}

export interface DatasetDeltaSnapshot {
  readonly version: string;
  readonly datasetKey: string;
  readonly revision: number;
  readonly recordCount: number;
  readonly fingerprint: string;
  readonly schemaFingerprint: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly commits: number;
  readonly rejectedMutations: number;
  readonly history: readonly DatasetDeltaCommit[];
}

interface NormalizedRuntimeOptions {
  readonly datasetKey: string;
  readonly maxRecords: number;
  readonly maxBatchOperations: number;
  readonly historySize: number;
  readonly schemaEnforcement: DatasetSchemaEnforcement;
  readonly schemaProfile: SchemaProfileOptions;
  readonly normalization: RecordNormalizationOptions;
  readonly clock: () => number;
}

interface PlannedMutation {
  readonly preview: DatasetDeltaPreview;
  readonly records: readonly NormalizedRecord[];
  readonly schema: DatasetSchemaProfile;
}

const emptyQuality = (): DataQualitySummary => Object.freeze({
  inputCount: 0,
  outputCount: 0,
  duplicateCount: 0,
  invalidCount: 0,
  missingIdCount: 0,
  invalidCoordinateCount: 0,
  issues: Object.freeze([]),
});

const safeClock = (clock: () => number): number => {
  const value = Number(clock());
  return Number.isFinite(value) ? value : Date.now();
};

const normalizeDatasetKey = (value: unknown): string => {
  const key = normalizeSearchText(value || 'default')
    .replace(/[^a-z0-9._:-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
  return key || 'default';
};

const normalizeEnforcement = (value: unknown): DatasetSchemaEnforcement => {
  const normalized = normalizeSearchText(value) as DatasetSchemaEnforcement;
  if (normalized === 'ignore'
    || normalized === 'warn'
    || normalized === 'reject-breaking'
    || normalized === 'reject-warning') return normalized;
  return 'reject-breaking';
};

const normalizeOptions = (
  options: DatasetDeltaRuntimeOptions = {},
): NormalizedRuntimeOptions => {
  const maxRecords = normalizeInteger(options.maxRecords, { min: 1, max: 1_000_000, fallback: 100_000 });
  const normalization: {
    schema?: RecordAliasSchema;
    dedupe?: boolean;
    keepInvalid?: boolean;
    maxRecords: number;
  } = { maxRecords };
  if (options.schema !== undefined) normalization.schema = options.schema;
  if (options.dedupe !== undefined) normalization.dedupe = options.dedupe;
  if (options.keepInvalid !== undefined) normalization.keepInvalid = options.keepInvalid;
  return Object.freeze({
    datasetKey: normalizeDatasetKey(options.datasetKey),
    maxRecords,
    maxBatchOperations: normalizeInteger(options.maxBatchOperations, {
      min: 1,
      max: 200_000,
      fallback: Math.min(20_000, maxRecords),
    }),
    historySize: normalizeInteger(options.historySize, { min: 0, max: 10_000, fallback: 128 }),
    schemaEnforcement: normalizeEnforcement(options.schemaEnforcement),
    schemaProfile: options.schemaProfile ?? {},
    normalization: Object.freeze(normalization),
    clock: typeof options.clock === 'function' ? options.clock : () => Date.now(),
  });
};

export const datasetRecordKey = (record: NormalizedRecord): string => {
  if (record.id) return `id:${normalizeSearchText(record.id)}`;
  return `fp:${record.fingerprint}`;
};

const normalizedRemoveKey = (value: unknown): string => {
  const text = normalizeText(value).slice(0, 256);
  if (!text) return '';
  if (text.startsWith('id:') || text.startsWith('fp:')) return text;
  return `id:${normalizeSearchText(text)}`;
};

const compareRecords = (left: NormalizedRecord, right: NormalizedRecord): number => {
  const leftKey = datasetRecordKey(left);
  const rightKey = datasetRecordKey(right);
  const key = leftKey.localeCompare(rightKey, 'en');
  if (key !== 0) return key;
  return left.sourceIndex - right.sourceIndex;
};

const schemaInput = (records: readonly NormalizedRecord[]): readonly unknown[] =>
  Object.freeze(records.map(record => record.source));

const emptySchemaReport = (profile: DatasetSchemaProfile): SchemaDriftReport => Object.freeze({
  baselineFingerprint: profile.fingerprint,
  candidateFingerprint: profile.fingerprint,
  compatibility: 'compatible' as const,
  breakingCount: 0,
  warningCount: 0,
  compatibleCount: 0,
  findings: Object.freeze([]),
  addedFields: Object.freeze([]),
  removedFields: Object.freeze([]),
  changedFields: Object.freeze([]),
});

const enforceSchema = (
  enforcement: DatasetSchemaEnforcement,
  report: SchemaDriftReport,
): readonly string[] => {
  if (enforcement === 'ignore' || enforcement === 'warn') return Object.freeze([]);
  if (enforcement === 'reject-warning') {
    if (report.breakingCount > 0 || report.warningCount > 0) {
      return Object.freeze([
        `Schema drift rejected: ${report.breakingCount} breaking and ${report.warningCount} warning finding(s).`,
      ]);
    }
    return Object.freeze([]);
  }
  if (report.breakingCount > 0) {
    return Object.freeze([`Schema drift rejected: ${report.breakingCount} breaking finding(s).`]);
  }
  return Object.freeze([]);
};

const mutationFingerprint = (mutation: DatasetDeltaMutation): string => hashFingerprint({
  expectedRevision: mutation.expectedRevision ?? null,
  upserts: mutation.upserts ?? [],
  removeKeys: mutation.removeKeys ?? [],
  schemaEnforcement: mutation.schemaEnforcement ?? null,
  metadata: mutation.metadata ?? {},
});

export class DatasetDeltaRuntime {
  readonly #options: NormalizedRuntimeOptions;
  readonly #history: DatasetDeltaCommit[] = [];
  #records: readonly NormalizedRecord[];
  #schema: DatasetSchemaProfile;
  #fingerprint: string;
  #revision = 1;
  #createdAt: number;
  #updatedAt: number;
  #commits = 0;
  #rejectedMutations = 0;
  #lastMutationFingerprint: string | null = null;
  #lastCommit: DatasetDeltaCommit | null = null;

  constructor(initialRecords: readonly unknown[] = [], options: DatasetDeltaRuntimeOptions = {}) {
    this.#options = normalizeOptions(options);
    const normalized = normalizeRecordCollection(initialRecords, this.#options.normalization);
    this.#records = Object.freeze([...normalized.records].sort(compareRecords));
    this.#schema = profileDatasetSchema(schemaInput(this.#records), this.#options.schemaProfile);
    this.#fingerprint = createDatasetFingerprint(this.#records);
    this.#createdAt = safeClock(this.#options.clock);
    this.#updatedAt = this.#createdAt;
  }

  preview(mutation: DatasetDeltaMutation): DatasetDeltaPreview {
    return this.#plan(mutation).preview;
  }

  apply(mutation: DatasetDeltaMutation): DatasetDeltaCommit {
    const mutationKey = mutationFingerprint(mutation);
    if (mutationKey === this.#lastMutationFingerprint && this.#lastCommit) return this.#lastCommit;
    const plan = this.#plan(mutation);
    if (!plan.preview.accepted) {
      this.#rejectedMutations += 1;
      const error = new Error(plan.preview.rejectionReasons.join(' ') || 'Dataset delta mutation rejected.');
      error.name = 'DatasetDeltaRejectedError';
      throw error;
    }
    const committedAt = safeClock(this.#options.clock);
    const commit: DatasetDeltaCommit = Object.freeze({ ...plan.preview, committedAt });
    if (plan.preview.changed) {
      this.#records = plan.records;
      this.#schema = plan.schema;
      this.#fingerprint = plan.preview.afterFingerprint;
      this.#revision = plan.preview.nextRevision;
      this.#updatedAt = committedAt;
    }
    this.#commits += 1;
    this.#lastMutationFingerprint = mutationKey;
    this.#lastCommit = commit;
    this.#pushHistory(commit);
    return commit;
  }

  replaceAll(
    records: readonly unknown[],
    expectedRevision: number | null = null,
    metadata: DatasetDeltaMutation['metadata'] = {},
  ): DatasetDeltaCommit {
    const removeKeys = this.#records.map(datasetRecordKey);
    return this.apply({
      expectedRevision,
      upserts: records,
      removeKeys,
      metadata,
    });
  }

  getRecords(): readonly NormalizedRecord[] {
    return this.#records;
  }

  getRecord(keyInput: string): NormalizedRecord | null {
    const key = normalizedRemoveKey(keyInput);
    if (!key) return null;
    return this.#records.find(record => datasetRecordKey(record) === key) ?? null;
  }

  getSchemaProfile(): DatasetSchemaProfile {
    return this.#schema;
  }

  getSnapshot(): DatasetDeltaSnapshot {
    return Object.freeze({
      version: DATASET_DELTA_VERSION,
      datasetKey: this.#options.datasetKey,
      revision: this.#revision,
      recordCount: this.#records.length,
      fingerprint: this.#fingerprint,
      schemaFingerprint: this.#schema.fingerprint,
      createdAt: this.#createdAt,
      updatedAt: this.#updatedAt,
      commits: this.#commits,
      rejectedMutations: this.#rejectedMutations,
      history: Object.freeze([...this.#history]),
    });
  }

  #plan(mutation: DatasetDeltaMutation): PlannedMutation {
    const rejectionReasons: string[] = [];
    const expectedRevision = mutation.expectedRevision;
    if (expectedRevision !== null && expectedRevision !== undefined && expectedRevision !== this.#revision) {
      rejectionReasons.push(`Revision mismatch: expected ${expectedRevision}, current ${this.#revision}.`);
    }

    const upserts = mutation.upserts ?? [];
    const removeKeys = mutation.removeKeys ?? [];
    if (upserts.length + removeKeys.length > this.#options.maxBatchOperations) {
      rejectionReasons.push(
        `Batch operation count ${upserts.length + removeKeys.length} exceeds ${this.#options.maxBatchOperations}.`,
      );
    }

    const normalizedUpserts = normalizeRecordCollection(upserts, {
      ...this.#options.normalization,
      maxRecords: Math.min(upserts.length || 1, this.#options.maxBatchOperations),
    });
    const current = new Map<string, NormalizedRecord>(
      this.#records.map(record => [datasetRecordKey(record), record]),
    );
    const operations: DatasetDeltaOperation[] = [];
    const touched = new Set<string>();
    let duplicateMutationCount = 0;
    let insertCount = 0;
    let updateCount = 0;
    let removeCount = 0;
    let noopCount = 0;

    for (const rawKey of removeKeys) {
      const key = normalizedRemoveKey(rawKey);
      if (!key) continue;
      if (touched.has(`remove:${key}`)) {
        duplicateMutationCount += 1;
        continue;
      }
      touched.add(`remove:${key}`);
      const before = current.get(key) ?? null;
      if (!before) {
        noopCount += 1;
        operations.push(Object.freeze({
          kind: 'noop',
          key,
          beforeFingerprint: null,
          afterFingerprint: null,
          sourceIndex: null,
        }));
        continue;
      }
      current.delete(key);
      removeCount += 1;
      operations.push(Object.freeze({
        kind: 'remove',
        key,
        beforeFingerprint: before.fingerprint,
        afterFingerprint: null,
        sourceIndex: before.sourceIndex,
      }));
    }

    for (const record of normalizedUpserts.records) {
      const key = datasetRecordKey(record);
      if (touched.has(`upsert:${key}`)) duplicateMutationCount += 1;
      touched.add(`upsert:${key}`);
      const before = current.get(key) ?? null;
      if (!before) {
        current.set(key, record);
        insertCount += 1;
        operations.push(Object.freeze({
          kind: 'insert',
          key,
          beforeFingerprint: null,
          afterFingerprint: record.fingerprint,
          sourceIndex: record.sourceIndex,
        }));
      } else if (before.fingerprint === record.fingerprint) {
        noopCount += 1;
        operations.push(Object.freeze({
          kind: 'noop',
          key,
          beforeFingerprint: before.fingerprint,
          afterFingerprint: record.fingerprint,
          sourceIndex: record.sourceIndex,
        }));
      } else {
        current.set(key, record);
        updateCount += 1;
        operations.push(Object.freeze({
          kind: 'update',
          key,
          beforeFingerprint: before.fingerprint,
          afterFingerprint: record.fingerprint,
          sourceIndex: record.sourceIndex,
        }));
      }
    }

    const nextRecords = Object.freeze(Array.from(current.values()).sort(compareRecords));
    if (nextRecords.length > this.#options.maxRecords) {
      rejectionReasons.push(`Dataset size ${nextRecords.length} exceeds bounded capacity ${this.#options.maxRecords}.`);
    }

    const candidateSchema = profileDatasetSchema(schemaInput(nextRecords), this.#options.schemaProfile);
    const schemaReport = this.#records.length === 0
      ? emptySchemaReport(candidateSchema)
      : compareSchemaProfiles(this.#schema, candidateSchema);
    const enforcement = normalizeEnforcement(mutation.schemaEnforcement ?? this.#options.schemaEnforcement);
    rejectionReasons.push(...enforceSchema(enforcement, schemaReport));

    const afterFingerprint = createDatasetFingerprint(nextRecords);
    const changed = afterFingerprint !== this.#fingerprint;
    const accepted = rejectionReasons.length === 0;
    const nextRevision = changed ? this.#revision + 1 : this.#revision;
    const metadata = Object.freeze({ ...mutation.metadata });
    const preview: DatasetDeltaPreview = Object.freeze({
      version: DATASET_DELTA_VERSION,
      datasetKey: this.#options.datasetKey,
      currentRevision: this.#revision,
      nextRevision,
      accepted,
      changed,
      inputUpsertCount: upserts.length,
      inputRemoveCount: removeKeys.length,
      insertCount,
      updateCount,
      removeCount,
      noopCount,
      duplicateMutationCount: duplicateMutationCount + normalizedUpserts.quality.duplicateCount,
      beforeCount: this.#records.length,
      afterCount: nextRecords.length,
      beforeFingerprint: this.#fingerprint,
      afterFingerprint,
      schemaCompatibility: schemaReport.compatibility,
      schemaReport,
      quality: normalizedUpserts.quality ?? emptyQuality(),
      operations: Object.freeze(operations),
      rejectionReasons: Object.freeze(rejectionReasons),
      metadata,
    });
    return Object.freeze({ preview, records: nextRecords, schema: candidateSchema });
  }

  #pushHistory(commit: DatasetDeltaCommit): void {
    if (this.#options.historySize <= 0) return;
    this.#history.push(commit);
    if (this.#history.length > this.#options.historySize) {
      this.#history.splice(0, this.#history.length - this.#options.historySize);
    }
  }
}

export interface DatasetDeltaDiff {
  readonly leftRevision: number;
  readonly rightRevision: number;
  readonly insertedKeys: readonly string[];
  readonly removedKeys: readonly string[];
  readonly changedKeys: readonly string[];
  readonly unchangedKeys: readonly string[];
  readonly fingerprint: string;
}

export const compareNormalizedDatasets = (
  left: readonly NormalizedRecord[],
  right: readonly NormalizedRecord[],
  leftRevision = 0,
  rightRevision = 0,
): DatasetDeltaDiff => {
  const leftByKey = new Map(left.map(record => [datasetRecordKey(record), record]));
  const rightByKey = new Map(right.map(record => [datasetRecordKey(record), record]));
  const insertedKeys: string[] = [];
  const removedKeys: string[] = [];
  const changedKeys: string[] = [];
  const unchangedKeys: string[] = [];
  for (const [key, record] of rightByKey) {
    const previous = leftByKey.get(key);
    if (!previous) insertedKeys.push(key);
    else if (previous.fingerprint !== record.fingerprint) changedKeys.push(key);
    else unchangedKeys.push(key);
  }
  for (const key of leftByKey.keys()) {
    if (!rightByKey.has(key)) removedKeys.push(key);
  }
  const sort = (values: string[]): readonly string[] => Object.freeze(values.sort((a, b) => a.localeCompare(b, 'en')));
  const result = {
    leftRevision,
    rightRevision,
    insertedKeys: sort(insertedKeys),
    removedKeys: sort(removedKeys),
    changedKeys: sort(changedKeys),
    unchangedKeys: sort(unchangedKeys),
  };
  return Object.freeze({ ...result, fingerprint: hashFingerprint(result) });
};

export const createDatasetDeltaRuntime = (
  initialRecords: readonly unknown[] = [],
  options: DatasetDeltaRuntimeOptions = {},
): DatasetDeltaRuntime => new DatasetDeltaRuntime(initialRecords, options);

export const createDatasetSchemaBaseline = (
  records: readonly unknown[],
  schema?: RecordAliasSchema,
  options: SchemaProfileOptions = {},
): DatasetSchemaProfile => {
  const normalization: { schema?: RecordAliasSchema; maxRecords: number } = {
    maxRecords: records.length || 1,
  };
  if (schema !== undefined) normalization.schema = schema;
  const normalized = normalizeRecordCollection(records, normalization);
  return profileDatasetSchema(schemaInput(normalized.records), options);
};