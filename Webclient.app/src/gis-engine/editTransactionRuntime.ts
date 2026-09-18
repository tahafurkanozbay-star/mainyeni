import {
  createDeterministicFingerprint,
  normalizeIdentifier,
  positiveInteger,
} from './runtimeContracts';

export type GisEditOperationKind = 'add' | 'update' | 'delete';
export type GisEditTransactionState =
  | 'open'
  | 'committing'
  | 'committed'
  | 'rolled-back'
  | 'failed';

export type GisFeatureId = string | number;

export interface GisEditAddOperationInput {
  readonly kind: 'add';
  readonly layerId: string;
  readonly attributes?: Readonly<Record<string, unknown>>;
  readonly geometry?: unknown;
  readonly clientId?: string | null;
}

export interface GisEditUpdateOperationInput {
  readonly kind: 'update';
  readonly layerId: string;
  readonly featureId: GisFeatureId;
  readonly attributes?: Readonly<Record<string, unknown>>;
  readonly geometry?: unknown;
  readonly baseRevision?: string | number | null;
}

export interface GisEditDeleteOperationInput {
  readonly kind: 'delete';
  readonly layerId: string;
  readonly featureId: GisFeatureId;
  readonly baseRevision?: string | number | null;
}

export type GisEditOperationInput =
  | GisEditAddOperationInput
  | GisEditUpdateOperationInput
  | GisEditDeleteOperationInput;

export interface GisEditOperation {
  readonly operationId: string;
  readonly sequence: number;
  readonly kind: GisEditOperationKind;
  readonly layerId: string;
  readonly featureId: GisFeatureId | null;
  readonly clientId: string | null;
  readonly attributes: Readonly<Record<string, unknown>> | null;
  readonly geometry: unknown;
  readonly baseRevision: string | number | null;
  readonly estimatedBytes: number;
  readonly fingerprint: string;
}

export interface GisEditTransactionOptions {
  readonly transactionId?: string;
  readonly baseRevision?: string | number | null;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface GisEditCommitContext {
  readonly transactionId: string;
  readonly baseRevision: string | number | null;
  readonly operations: readonly GisEditOperation[];
  readonly signal: AbortSignal;
  readonly fingerprint: string;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface GisEditOperationResult {
  readonly operationId: string;
  readonly success: boolean;
  readonly featureId?: GisFeatureId | null;
  readonly errorCode?: string | null;
  readonly message?: string | null;
}

export interface GisEditAdapterResult {
  readonly revision?: string | number | null;
  readonly operationResults?: readonly GisEditOperationResult[];
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export type GisEditCommitAdapter = (
  context: Readonly<GisEditCommitContext>,
) => Promise<GisEditAdapterResult> | GisEditAdapterResult;

export interface GisEditCommitResult {
  readonly transactionId: string;
  readonly state: 'committed';
  readonly revision: string | number | null;
  readonly operationResults: readonly GisEditOperationResult[];
  readonly operationCount: number;
  readonly estimatedBytes: number;
  readonly fingerprint: string;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface GisEditTransactionSnapshot {
  readonly transactionId: string;
  readonly state: GisEditTransactionState;
  readonly baseRevision: string | number | null;
  readonly revision: string | number | null;
  readonly operationCount: number;
  readonly estimatedBytes: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly fingerprint: string;
  readonly failureCode: string | null;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface GisEditRuntimeSnapshot {
  readonly destroyed: boolean;
  readonly transactionCount: number;
  readonly openTransactionCount: number;
  readonly committingTransactionCount: number;
  readonly totalOperationsStaged: number;
  readonly totalCommits: number;
  readonly totalRollbacks: number;
  readonly totalFailures: number;
}

export interface GisEditRuntimeEvent {
  readonly type:
    | 'transaction-created'
    | 'operation-staged'
    | 'operation-removed'
    | 'transaction-cleared'
    | 'commit-started'
    | 'commit-succeeded'
    | 'commit-failed'
    | 'commit-aborted'
    | 'transaction-rolled-back'
    | 'transaction-removed'
    | 'destroyed';
  readonly timestamp: number;
  readonly transactionId?: string;
  readonly operationId?: string;
  readonly state?: GisEditTransactionState;
  readonly reason?: string;
  readonly errorCode?: string | null;
}

export interface GisEditTransactionRuntimeConfiguration {
  readonly now?: () => number;
  readonly maxTransactions?: number;
  readonly maxOperationsPerTransaction?: number;
  readonly maxTransactionBytes?: number;
  readonly maxAttributeKeys?: number;
  readonly maxStringLength?: number;
  readonly maxGeometryDepth?: number;
  readonly requireBaseRevision?: boolean;
  readonly retainCommitted?: boolean;
  readonly retainFailed?: boolean;
  readonly onListenerError?: (
    error: unknown,
    event: Readonly<GisEditRuntimeEvent>,
  ) => void;
}

export interface GisEditTransactionRuntime {
  beginTransaction: (options?: GisEditTransactionOptions) => GisEditTransactionSnapshot;
  stage: (transactionId: unknown, operation: GisEditOperationInput) => GisEditOperation;
  stageAdd: (
    transactionId: unknown,
    input: Omit<GisEditAddOperationInput, 'kind'>,
  ) => GisEditOperation;
  stageUpdate: (
    transactionId: unknown,
    input: Omit<GisEditUpdateOperationInput, 'kind'>,
  ) => GisEditOperation;
  stageDelete: (
    transactionId: unknown,
    input: Omit<GisEditDeleteOperationInput, 'kind'>,
  ) => GisEditOperation;
  removeOperation: (transactionId: unknown, operationId: unknown) => boolean;
  clearTransaction: (transactionId: unknown) => GisEditTransactionSnapshot;
  commit: (
    transactionId: unknown,
    adapter: GisEditCommitAdapter,
    options?: { readonly signal?: AbortSignal | null },
  ) => Promise<GisEditCommitResult>;
  abortCommit: (transactionId: unknown, reason?: string) => boolean;
  rollback: (transactionId: unknown, reason?: string) => GisEditTransactionSnapshot;
  removeTransaction: (transactionId: unknown) => boolean;
  getTransaction: (transactionId: unknown) => GisEditTransactionSnapshot;
  listTransactions: () => readonly GisEditTransactionSnapshot[];
  getOperations: (transactionId: unknown) => readonly GisEditOperation[];
  subscribe: (listener: (event: Readonly<GisEditRuntimeEvent>) => void) => () => boolean;
  getSnapshot: () => GisEditRuntimeSnapshot;
  destroy: () => void;
}

interface TransactionEntry {
  readonly transactionId: string;
  readonly createdAt: number;
  readonly baseRevision: string | number | null;
  readonly metadata: Readonly<Record<string, unknown>>;
  state: GisEditTransactionState;
  revision: string | number | null;
  operations: GisEditOperation[];
  estimatedBytes: number;
  updatedAt: number;
  fingerprint: string;
  failureCode: string | null;
  commitController: AbortController | null;
  externalAbortCleanup: (() => void) | null;
}

const DEFAULT_MAX_TRANSACTIONS = 32;
const DEFAULT_MAX_OPERATIONS = 500;
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_ATTRIBUTE_KEYS = 256;
const DEFAULT_MAX_STRING_LENGTH = 64 * 1024;
const DEFAULT_MAX_GEOMETRY_DEPTH = 64;

const cloneRecord = (
  value: Readonly<Record<string, unknown>> | undefined,
): Readonly<Record<string, unknown>> => Object.freeze({ ...value });

const normalizeFeatureId = (value: unknown): GisFeatureId => {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('GIS feature id must be finite.');
    return value;
  }
  const normalized = String(value ?? '').trim();
  if (!normalized) throw new TypeError('GIS feature id is required.');
  if (normalized.length > 512) throw new RangeError('GIS feature id is too long.');
  return normalized;
};

const normalizeRevision = (
  value: unknown,
): string | number | null => {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Revision numbers must be finite.');
    return value;
  }
  const normalized = String(value).trim();
  if (!normalized) return null;
  if (normalized.length > 512) throw new RangeError('Revision value is too long.');
  return normalized;
};

const abortError = (reason = 'GIS edit commit aborted.'): Error => {
  const error = new Error(reason);
  error.name = 'AbortError';
  return error;
};

const throwIfAborted = (signal: AbortSignal): void => {
  if (signal.aborted) throw abortError(String(signal.reason || 'GIS edit commit aborted.'));
};

const errorCode = (error: unknown): string => {
  if (error && typeof error === 'object') {
    const source = error as Record<string, unknown>;
    const code = source.code ?? source.name;
    if (code !== undefined && code !== null && String(code).trim()) {
      return String(code).slice(0, 128);
    }
  }
  return 'EDIT_COMMIT_FAILED';
};

const stableJsonBytes = (
  value: unknown,
  maxStringLength: number,
  maxDepth: number,
): number => {
  const seen = new Set<object>();

  const visit = (candidate: unknown, depth: number): number => {
    if (depth > maxDepth) throw new RangeError('GIS edit payload nesting exceeds the configured depth budget.');
    if (candidate === null || candidate === undefined) return 4;

    if (typeof candidate === 'string') {
      if (candidate.length > maxStringLength) {
        throw new RangeError('GIS edit payload string exceeds the configured length budget.');
      }
      return candidate.length * 2 + 2;
    }

    if (typeof candidate === 'number') {
      if (!Number.isFinite(candidate)) throw new TypeError('GIS edit payload numbers must be finite.');
      return 16;
    }

    if (typeof candidate === 'boolean') return 5;

    if (typeof candidate === 'bigint' || typeof candidate === 'symbol' || typeof candidate === 'function') {
      throw new TypeError('GIS edit payload contains a non-serializable value.');
    }

    if (Array.isArray(candidate)) {
      if (seen.has(candidate)) throw new TypeError('GIS edit payload cannot contain cycles.');
      seen.add(candidate);
      let bytes = 2;
      for (const item of candidate) bytes += visit(item, depth + 1) + 1;
      seen.delete(candidate);
      return bytes;
    }

    if (typeof candidate === 'object') {
      const objectValue = candidate as Record<string, unknown>;
      if (seen.has(objectValue)) throw new TypeError('GIS edit payload cannot contain cycles.');
      seen.add(objectValue);
      let bytes = 2;
      for (const [key, item] of Object.entries(objectValue)) {
        if (key.length > maxStringLength) {
          throw new RangeError('GIS edit payload key exceeds the configured length budget.');
        }
        bytes += key.length * 2 + 3;
        bytes += visit(item, depth + 1) + 1;
      }
      seen.delete(objectValue);
      return bytes;
    }

    throw new TypeError('GIS edit payload contains an unsupported value.');
  };

  return visit(value, 0);
};

const cloneSerializableValue = (
  value: unknown,
  maxStringLength: number,
  maxDepth: number,
): unknown => {
  const seen = new Set<object>();

  const clone = (candidate: unknown, depth: number): unknown => {
    if (depth > maxDepth) {
      throw new RangeError('GIS edit payload nesting exceeds the configured depth budget.');
    }
    if (candidate === null || candidate === undefined) return candidate;

    if (typeof candidate === 'string') {
      if (candidate.length > maxStringLength) {
        throw new RangeError('GIS edit payload string exceeds the configured length budget.');
      }
      return candidate;
    }

    if (typeof candidate === 'number') {
      if (!Number.isFinite(candidate)) {
        throw new TypeError('GIS edit payload numbers must be finite.');
      }
      return candidate;
    }

    if (typeof candidate === 'boolean') return candidate;

    if (
      typeof candidate === 'bigint'
      || typeof candidate === 'symbol'
      || typeof candidate === 'function'
    ) {
      throw new TypeError('GIS edit payload contains a non-serializable value.');
    }

    if (Array.isArray(candidate)) {
      if (seen.has(candidate)) throw new TypeError('GIS edit payload cannot contain cycles.');
      seen.add(candidate);
      const snapshot = Object.freeze(candidate.map((item) => clone(item, depth + 1)));
      seen.delete(candidate);
      return snapshot;
    }

    if (typeof candidate === 'object') {
      const source = candidate as Record<string, unknown>;
      if (seen.has(source)) throw new TypeError('GIS edit payload cannot contain cycles.');
      seen.add(source);
      const snapshot: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(source)) {
        if (key.length > maxStringLength) {
          throw new RangeError('GIS edit payload key exceeds the configured length budget.');
        }
        snapshot[key] = clone(item, depth + 1);
      }
      seen.delete(source);
      return Object.freeze(snapshot);
    }

    throw new TypeError('GIS edit payload contains an unsupported value.');
  };

  return clone(value, 0);
};

const freezeOperation = (operation: GisEditOperation): GisEditOperation => Object.freeze({
  ...operation,
  attributes: operation.attributes ? Object.freeze({ ...operation.attributes }) : null,
});

export const createGisEditTransactionRuntime = (
  configuration: GisEditTransactionRuntimeConfiguration = {},
): GisEditTransactionRuntime => {
  const now = typeof configuration.now === 'function' ? configuration.now : () => Date.now();
  const maxTransactions = positiveInteger(
    configuration.maxTransactions,
    DEFAULT_MAX_TRANSACTIONS,
    10_000,
  );
  const maxOperationsPerTransaction = positiveInteger(
    configuration.maxOperationsPerTransaction,
    DEFAULT_MAX_OPERATIONS,
    100_000,
  );
  const maxTransactionBytes = positiveInteger(
    configuration.maxTransactionBytes,
    DEFAULT_MAX_BYTES,
    512 * 1024 * 1024,
  );
  const maxAttributeKeys = positiveInteger(
    configuration.maxAttributeKeys,
    DEFAULT_MAX_ATTRIBUTE_KEYS,
    10_000,
  );
  const maxStringLength = positiveInteger(
    configuration.maxStringLength,
    DEFAULT_MAX_STRING_LENGTH,
    4 * 1024 * 1024,
  );
  const maxGeometryDepth = positiveInteger(
    configuration.maxGeometryDepth,
    DEFAULT_MAX_GEOMETRY_DEPTH,
    1024,
  );

  const transactions = new Map<string, TransactionEntry>();
  const listeners = new Set<(event: Readonly<GisEditRuntimeEvent>) => void>();
  let destroyed = false;
  let transactionSequence = 0;
  let operationSequence = 0;
  let totalOperationsStaged = 0;
  let totalCommits = 0;
  let totalRollbacks = 0;
  let totalFailures = 0;

  const assertActive = (): void => {
    if (destroyed) throw new Error('GIS edit transaction runtime has been destroyed.');
  };

  const emit = (
    type: GisEditRuntimeEvent['type'],
    details: Omit<GisEditRuntimeEvent, 'type' | 'timestamp'> = {},
  ): void => {
    const event: Readonly<GisEditRuntimeEvent> = Object.freeze({
      type,
      timestamp: Math.trunc(now()),
      ...details,
    });
    for (const listener of listeners) {
      try {
        listener(event);
      } catch (error: unknown) {
        configuration.onListenerError?.(error, event);
      }
    }
  };

  const updateFingerprint = (entry: TransactionEntry): void => {
    entry.fingerprint = createDeterministicFingerprint('gis-edit-transaction', {
      transactionId: entry.transactionId,
      baseRevision: entry.baseRevision,
      operations: entry.operations.map((operation) => ({
        operationId: operation.operationId,
        fingerprint: operation.fingerprint,
      })),
      metadata: entry.metadata,
    });
  };

  const snapshotOf = (entry: TransactionEntry): GisEditTransactionSnapshot => Object.freeze({
    transactionId: entry.transactionId,
    state: entry.state,
    baseRevision: entry.baseRevision,
    revision: entry.revision,
    operationCount: entry.operations.length,
    estimatedBytes: entry.estimatedBytes,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    fingerprint: entry.fingerprint,
    failureCode: entry.failureCode,
    metadata: entry.metadata,
  });

  const getEntry = (transactionId: unknown): TransactionEntry => {
    const id = normalizeIdentifier(transactionId, 'transactionId');
    const entry = transactions.get(id);
    if (!entry) throw new Error(`GIS edit transaction is not registered: ${id}`);
    return entry;
  };

  const assertMutable = (entry: TransactionEntry): void => {
    if (entry.state !== 'open') {
      throw new Error(
        `GIS edit transaction ${entry.transactionId} is not mutable while state=${entry.state}.`,
      );
    }
  };

  const validateAttributes = (
    attributes: Readonly<Record<string, unknown>> | undefined,
  ): Readonly<Record<string, unknown>> | null => {
    if (attributes === undefined) return null;
    const entries = Object.entries(attributes);
    if (entries.length > maxAttributeKeys) {
      throw new RangeError(
        `GIS edit attributes exceed the configured key budget (${maxAttributeKeys}).`,
      );
    }
    const clone: Record<string, unknown> = {};
    for (const [key, value] of entries) {
      const normalizedKey = String(key).trim();
      if (!normalizedKey) throw new TypeError('GIS edit attribute names cannot be empty.');
      if (normalizedKey.length > 512) throw new RangeError('GIS edit attribute name is too long.');
      clone[normalizedKey] = value;
    }
    stableJsonBytes(clone, maxStringLength, maxGeometryDepth);
    return cloneSerializableValue(
      clone,
      maxStringLength,
      maxGeometryDepth,
    ) as Readonly<Record<string, unknown>>;
  };

  const normalizeOperation = (
    input: GisEditOperationInput,
  ): GisEditOperation => {
    const layerId = normalizeIdentifier(input.layerId, 'layerId');
    const attributes = input.kind === 'delete'
      ? null
      : validateAttributes(input.attributes);
    const geometryInput = input.kind === 'delete' ? null : input.geometry ?? null;
    const geometry = geometryInput === null
      ? null
      : cloneSerializableValue(geometryInput, maxStringLength, maxGeometryDepth);

    if (geometry !== null) {
      stableJsonBytes(geometry, maxStringLength, maxGeometryDepth);
    }

    const featureId = input.kind === 'add'
      ? null
      : normalizeFeatureId(input.featureId);
    const clientId = input.kind === 'add' && input.clientId
      ? normalizeIdentifier(input.clientId, 'clientId')
      : null;
    const baseRevision = input.kind === 'add'
      ? null
      : normalizeRevision(input.baseRevision);
    const estimatedBytes = stableJsonBytes({
      kind: input.kind,
      layerId,
      featureId,
      clientId,
      attributes,
      geometry,
      baseRevision,
    }, maxStringLength, maxGeometryDepth);

    operationSequence += 1;
    const operationId = `edit-${operationSequence.toString(36)}`;
    const fingerprint = createDeterministicFingerprint('gis-edit-operation', {
      kind: input.kind,
      layerId,
      featureId,
      clientId,
      attributes,
      geometry,
      baseRevision,
    });

    return freezeOperation({
      operationId,
      sequence: operationSequence,
      kind: input.kind,
      layerId,
      featureId,
      clientId,
      attributes,
      geometry,
      baseRevision,
      estimatedBytes,
      fingerprint,
    });
  };

  const beginTransaction = (
    options: GisEditTransactionOptions = {},
  ): GisEditTransactionSnapshot => {
    assertActive();
    if (transactions.size >= maxTransactions) {
      throw new RangeError(`GIS edit transaction capacity exceeded (${maxTransactions}).`);
    }

    transactionSequence += 1;
    const transactionId = options.transactionId
      ? normalizeIdentifier(options.transactionId, 'transactionId')
      : `tx-${transactionSequence.toString(36)}`;

    if (transactions.has(transactionId)) {
      throw new Error(`GIS edit transaction already exists: ${transactionId}`);
    }

    const baseRevision = normalizeRevision(options.baseRevision);
    if (configuration.requireBaseRevision === true && baseRevision === null) {
      throw new Error('A base revision is required for GIS edit transactions.');
    }

    const timestamp = Math.trunc(now());
    const entry: TransactionEntry = {
      transactionId,
      createdAt: timestamp,
      baseRevision,
      metadata: cloneRecord(options.metadata),
      state: 'open',
      revision: null,
      operations: [],
      estimatedBytes: 0,
      updatedAt: timestamp,
      fingerprint: '',
      failureCode: null,
      commitController: null,
      externalAbortCleanup: null,
    };
    updateFingerprint(entry);
    transactions.set(transactionId, entry);
    emit('transaction-created', {
      transactionId,
      state: entry.state,
    });
    return snapshotOf(entry);
  };

  const stage = (
    transactionId: unknown,
    input: GisEditOperationInput,
  ): GisEditOperation => {
    assertActive();
    const entry = getEntry(transactionId);
    assertMutable(entry);

    if (entry.operations.length >= maxOperationsPerTransaction) {
      throw new RangeError(
        `GIS edit operation budget exceeded (${maxOperationsPerTransaction}).`,
      );
    }

    const operation = normalizeOperation(input);
    const nextBytes = entry.estimatedBytes + operation.estimatedBytes;
    if (nextBytes > maxTransactionBytes) {
      throw new RangeError(
        `GIS edit transaction payload exceeds the configured byte budget (${maxTransactionBytes}).`,
      );
    }

    entry.operations.push(operation);
    entry.estimatedBytes = nextBytes;
    entry.updatedAt = Math.trunc(now());
    entry.failureCode = null;
    updateFingerprint(entry);
    totalOperationsStaged += 1;
    emit('operation-staged', {
      transactionId: entry.transactionId,
      operationId: operation.operationId,
      state: entry.state,
    });
    return operation;
  };

  const removeOperation = (
    transactionId: unknown,
    operationId: unknown,
  ): boolean => {
    assertActive();
    const entry = getEntry(transactionId);
    assertMutable(entry);
    const id = normalizeIdentifier(operationId, 'operationId');
    const index = entry.operations.findIndex((operation) => operation.operationId === id);
    if (index < 0) return false;
    const [removed] = entry.operations.splice(index, 1);
    if (removed) entry.estimatedBytes = Math.max(0, entry.estimatedBytes - removed.estimatedBytes);
    entry.updatedAt = Math.trunc(now());
    updateFingerprint(entry);
    emit('operation-removed', {
      transactionId: entry.transactionId,
      operationId: id,
      state: entry.state,
    });
    return true;
  };

  const clearTransaction = (transactionId: unknown): GisEditTransactionSnapshot => {
    assertActive();
    const entry = getEntry(transactionId);
    assertMutable(entry);
    entry.operations = [];
    entry.estimatedBytes = 0;
    entry.updatedAt = Math.trunc(now());
    entry.failureCode = null;
    updateFingerprint(entry);
    emit('transaction-cleared', {
      transactionId: entry.transactionId,
      state: entry.state,
    });
    return snapshotOf(entry);
  };

  const attachExternalAbort = (
    entry: TransactionEntry,
    signal: AbortSignal | null | undefined,
  ): void => {
    entry.externalAbortCleanup?.();
    entry.externalAbortCleanup = null;
    if (!signal) return;
    if (signal.aborted) {
      entry.commitController?.abort(signal.reason);
      return;
    }
    const onAbort = (): void => entry.commitController?.abort(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    entry.externalAbortCleanup = () => signal.removeEventListener('abort', onAbort);
  };

  const normalizeOperationResults = (
    operations: readonly GisEditOperation[],
    value: readonly GisEditOperationResult[] | undefined,
  ): readonly GisEditOperationResult[] => {
    const byId = new Map(
      (value ?? []).map((result) => [result.operationId, result] as const),
    );
    return Object.freeze(operations.map((operation) => {
      const explicit = byId.get(operation.operationId);
      if (!explicit) {
        return Object.freeze({
          operationId: operation.operationId,
          success: true,
          featureId: operation.featureId,
          errorCode: null,
          message: null,
        });
      }
      return Object.freeze({
        operationId: operation.operationId,
        success: explicit.success === true,
        featureId: explicit.featureId ?? operation.featureId,
        errorCode: explicit.errorCode ?? null,
        message: explicit.message ?? null,
      });
    }));
  };

  const commit = async (
    transactionId: unknown,
    adapter: GisEditCommitAdapter,
    options: { readonly signal?: AbortSignal | null } = {},
  ): Promise<GisEditCommitResult> => {
    assertActive();
    const entry = getEntry(transactionId);
    assertMutable(entry);
    if (typeof adapter !== 'function') throw new TypeError('A GIS edit commit adapter is required.');
    if (!entry.operations.length) throw new Error('Cannot commit an empty GIS edit transaction.');

    const controller = new AbortController();
    entry.commitController = controller;
    attachExternalAbort(entry, options.signal);
    entry.state = 'committing';
    entry.failureCode = null;
    entry.updatedAt = Math.trunc(now());
    emit('commit-started', {
      transactionId: entry.transactionId,
      state: entry.state,
    });

    const operations = Object.freeze(entry.operations.map((operation) => freezeOperation(operation)));
    const commitFingerprint = entry.fingerprint;

    try {
      throwIfAborted(controller.signal);
      const result = await adapter(Object.freeze({
        transactionId: entry.transactionId,
        baseRevision: entry.baseRevision,
        operations,
        signal: controller.signal,
        fingerprint: commitFingerprint,
        metadata: entry.metadata,
      }));
      throwIfAborted(controller.signal);

      const normalizedRevision = normalizeRevision(result?.revision);
      const operationResults = normalizeOperationResults(
        operations,
        result?.operationResults,
      );
      const failedResult = operationResults.find((operationResult) => !operationResult.success);
      if (failedResult) {
        const error = new Error(
          failedResult.message || 'GIS edit adapter reported an unsuccessful operation.',
        );
        Object.assign(error, {
          code: failedResult.errorCode || 'EDIT_OPERATION_FAILED',
          operationId: failedResult.operationId,
        });
        throw error;
      }

      entry.state = 'committed';
      entry.revision = normalizedRevision;
      entry.updatedAt = Math.trunc(now());
      entry.failureCode = null;
      totalCommits += 1;
      emit('commit-succeeded', {
        transactionId: entry.transactionId,
        state: entry.state,
      });

      const commitResult: GisEditCommitResult = Object.freeze({
        transactionId: entry.transactionId,
        state: 'committed',
        revision: normalizedRevision,
        operationResults,
        operationCount: operations.length,
        estimatedBytes: entry.estimatedBytes,
        fingerprint: commitFingerprint,
        metadata: cloneRecord(result?.metadata),
      });

      if (configuration.retainCommitted !== true) {
        transactions.delete(entry.transactionId);
      }

      return commitResult;
    } catch (error: unknown) {
      const aborted = controller.signal.aborted
        || (error && typeof error === 'object' && String((error as Record<string, unknown>).name) === 'AbortError');
      entry.state = 'failed';
      entry.updatedAt = Math.trunc(now());
      entry.failureCode = aborted ? 'ABORTED' : errorCode(error);
      totalFailures += 1;
      emit(aborted ? 'commit-aborted' : 'commit-failed', {
        transactionId: entry.transactionId,
        state: entry.state,
        errorCode: entry.failureCode,
      });
      if (configuration.retainFailed !== true) {
        transactions.delete(entry.transactionId);
      }
      if (aborted) throw abortError(String(controller.signal.reason || 'GIS edit commit aborted.'));
      throw error;
    } finally {
      entry.externalAbortCleanup?.();
      entry.externalAbortCleanup = null;
      entry.commitController = null;
    }
  };

  const abortCommit = (
    transactionId: unknown,
    reason = 'GIS edit commit aborted by caller.',
  ): boolean => {
    assertActive();
    const entry = getEntry(transactionId);
    if (entry.state !== 'committing' || !entry.commitController) return false;
    entry.commitController.abort(reason);
    return true;
  };

  const rollback = (
    transactionId: unknown,
    reason = 'rollback',
  ): GisEditTransactionSnapshot => {
    assertActive();
    const entry = getEntry(transactionId);
    if (entry.state === 'committing') {
      entry.commitController?.abort('GIS edit transaction rolled back while committing.');
    }
    if (entry.state === 'committed') {
      throw new Error('Committed GIS edit transactions cannot be rolled back locally.');
    }
    entry.state = 'rolled-back';
    entry.operations = [];
    entry.estimatedBytes = 0;
    entry.updatedAt = Math.trunc(now());
    entry.failureCode = null;
    updateFingerprint(entry);
    totalRollbacks += 1;
    emit('transaction-rolled-back', {
      transactionId: entry.transactionId,
      state: entry.state,
      reason,
    });
    return snapshotOf(entry);
  };

  const removeTransaction = (transactionId: unknown): boolean => {
    assertActive();
    const entry = getEntry(transactionId);
    if (entry.state === 'committing') {
      throw new Error('Cannot remove a GIS edit transaction while it is committing.');
    }
    const removed = transactions.delete(entry.transactionId);
    if (removed) {
      emit('transaction-removed', {
        transactionId: entry.transactionId,
        state: entry.state,
      });
    }
    return removed;
  };

  const getSnapshot = (): GisEditRuntimeSnapshot => Object.freeze({
    destroyed,
    transactionCount: transactions.size,
    openTransactionCount: [...transactions.values()]
      .filter((entry) => entry.state === 'open').length,
    committingTransactionCount: [...transactions.values()]
      .filter((entry) => entry.state === 'committing').length,
    totalOperationsStaged,
    totalCommits,
    totalRollbacks,
    totalFailures,
  });

  const subscribe = (
    listener: (event: Readonly<GisEditRuntimeEvent>) => void,
  ): (() => boolean) => {
    assertActive();
    listeners.add(listener);
    return () => listeners.delete(listener);
  };

  const destroy = (): void => {
    if (destroyed) return;
    destroyed = true;
    for (const entry of transactions.values()) {
      entry.externalAbortCleanup?.();
      entry.commitController?.abort('GIS edit transaction runtime destroyed.');
      entry.commitController = null;
      entry.externalAbortCleanup = null;
    }
    transactions.clear();
    emit('destroyed');
    listeners.clear();
  };

  return Object.freeze({
    beginTransaction,
    stage,
    stageAdd(
      transactionId: unknown,
      input: Omit<GisEditAddOperationInput, 'kind'>,
    ) {
      return stage(transactionId, { kind: 'add', ...input });
    },
    stageUpdate(
      transactionId: unknown,
      input: Omit<GisEditUpdateOperationInput, 'kind'>,
    ) {
      return stage(transactionId, { kind: 'update', ...input });
    },
    stageDelete(
      transactionId: unknown,
      input: Omit<GisEditDeleteOperationInput, 'kind'>,
    ) {
      return stage(transactionId, { kind: 'delete', ...input });
    },
    removeOperation,
    clearTransaction,
    commit,
    abortCommit,
    rollback,
    removeTransaction,
    getTransaction(transactionId: unknown) {
      assertActive();
      return snapshotOf(getEntry(transactionId));
    },
    listTransactions() {
      assertActive();
      return Object.freeze(
        [...transactions.values()]
          .sort((left, right) => left.createdAt - right.createdAt
            || left.transactionId.localeCompare(right.transactionId))
          .map(snapshotOf),
      );
    },
    getOperations(transactionId: unknown) {
      assertActive();
      const entry = getEntry(transactionId);
      return Object.freeze(entry.operations.map((operation) => freezeOperation(operation)));
    },
    subscribe,
    getSnapshot,
    destroy,
  });
};
