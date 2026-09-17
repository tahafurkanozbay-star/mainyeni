import type { ArcGisMetadataContract } from './arcgisMetadataAdapter';
import type { ArcGisQuerySpec } from './arcgisQueryContract';
import {
  createArcGisFeatureWindowExecutor,
  type ArcGisFeatureWindowExecutionOptions,
} from './arcgisFeatureWindowExecutor';
import {
  createArcGisQueryExecutor,
  type ArcGisFeature,
  type ArcGisQueryExecutionOptions,
  type ArcGisQueryResult,
  type ArcGisQueryTransport,
  type ArcGisScheduler,
} from './arcgisQueryExecutor';
import type { FeatureWindowResult } from './arcgisFeatureWindow';
import {
  createSpatialRequestCoordinator,
  type SpatialRequestPriority,
  type SpatialRequestSnapshot,
} from './spatialRequestCoordinator';

export type ArcGisPipelineMode = 'single' | 'window';

export type ArcGisPipelineExecutionOptions = Readonly<{
  signal?: AbortSignal;
  requestPriority?: SpatialRequestPriority;
  cacheTtlMs?: number;
  query?: Omit<ArcGisQueryExecutionOptions, 'signal'>;
}>;

export type ArcGisPipelineWindowOptions = ArcGisPipelineExecutionOptions & Readonly<{
  pageSize?: number;
  maxFeatures?: number;
  maxPages?: number;
}>;

export type ArcGisPipelineSingleResult = Readonly<{
  mode: 'single';
  key: string;
  result: ArcGisQueryResult;
}>;

export type ArcGisPipelineWindowResult = Readonly<{
  mode: 'window';
  key: string;
  result: FeatureWindowResult<ArcGisFeature>;
}>;

export type ArcGisPipelineResult = ArcGisPipelineSingleResult | ArcGisPipelineWindowResult;

export type ArcGisPipelineBatchItem = Readonly<{
  contract: ArcGisMetadataContract;
  spec: ArcGisQuerySpec;
  mode?: ArcGisPipelineMode;
  options?: ArcGisPipelineWindowOptions;
}>;

export type ArcGisPipelineBatchResult = Readonly<{
  index: number;
  resourceUrl: string;
  result: ArcGisPipelineResult;
}>;

export class ArcGisQueryPipelineError extends Error {
  readonly code: string;

  constructor(message: string, code = 'ARCGIS_QUERY_PIPELINE_ERROR') {
    super(message);
    this.name = 'ArcGisQueryPipelineError';
    this.code = code;
  }
}

const boundedInteger = (value: unknown, fallback: number, maximum: number): number => {
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric) || numeric <= 0) return fallback;
  return Math.min(numeric, maximum);
};

const boundedTtl = (value: unknown): number => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return 0;
  return Math.min(Math.floor(numeric), 300_000);
};

const stableNumber = (value: unknown, fallback: number, maximum: number): number => {
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && numeric > 0 ? Math.min(numeric, maximum) : fallback;
};

const assertContract = (contract: ArcGisMetadataContract): void => {
  if (!contract.queryReady) {
    throw new ArcGisQueryPipelineError('ArcGIS metadata contract is not query-ready.', 'METADATA_NOT_QUERY_READY');
  }
  if (!/^https?:\/\//i.test(contract.resourceUrl) && !contract.resourceUrl.startsWith('/')) {
    throw new ArcGisQueryPipelineError('ArcGIS pipeline requires a verified resource URL.', 'INVALID_RESOURCE_URL');
  }
  if (!/(?:FeatureServer|MapServer)\/\d+$/i.test(contract.resourceUrl.replace(/\/+$/, ''))) {
    throw new ArcGisQueryPipelineError('ArcGIS pipeline accepts only concrete FeatureServer/MapServer layers.', 'INVALID_RESOURCE_URL');
  }
};

const specWithoutWindow = (spec: ArcGisQuerySpec): ArcGisQuerySpec => {
  const {
    window: _window,
    ...rest
  } = spec;
  return Object.freeze(rest);
};

const windowKeySuffix = (options: ArcGisPipelineWindowOptions, contract: ArcGisMetadataContract): string => {
  const pageSize = stableNumber(options.pageSize, Math.min(500, contract.maxRecordCount), Math.max(1, contract.maxRecordCount));
  const maxFeatures = stableNumber(options.maxFeatures, 10_000, 100_000);
  const maxPages = stableNumber(options.maxPages, 50, 1_000);
  return `page:${pageSize}|features:${maxFeatures}|pages:${maxPages}`;
};

const mergeQueryOptions = (
  options: ArcGisPipelineExecutionOptions,
  signal: AbortSignal,
): ArcGisQueryExecutionOptions => Object.freeze({
  ...options.query,
  signal,
});

const mergeWindowOptions = (
  options: ArcGisPipelineWindowOptions,
  signal: AbortSignal,
): ArcGisFeatureWindowExecutionOptions => Object.freeze({
  ...options.query,
  ...(options.pageSize !== undefined ? { pageSize: options.pageSize } : {}),
  ...(options.maxFeatures !== undefined ? { maxFeatures: options.maxFeatures } : {}),
  ...(options.maxPages !== undefined ? { maxPages: options.maxPages } : {}),
  signal,
});

export type ArcGisQueryPipeline = Readonly<{
  executeSingle(contract: ArcGisMetadataContract, spec: ArcGisQuerySpec, options?: ArcGisPipelineExecutionOptions): Promise<ArcGisPipelineSingleResult>;
  executeWindow(contract: ArcGisMetadataContract, spec: ArcGisQuerySpec, options?: ArcGisPipelineWindowOptions): Promise<ArcGisPipelineWindowResult>;
  execute(item: ArcGisPipelineBatchItem): Promise<ArcGisPipelineResult>;
  executeBatch(items: readonly ArcGisPipelineBatchItem[], maximum?: number): Promise<readonly ArcGisPipelineBatchResult[]>;
  keyForSingle(contract: ArcGisMetadataContract, spec: ArcGisQuerySpec): string;
  keyForWindow(contract: ArcGisMetadataContract, spec: ArcGisQuerySpec, options?: ArcGisPipelineWindowOptions): string;
  cancelKey(key: string, reason?: unknown): boolean;
  invalidateKey(key: string): number;
  invalidateResource(resourceUrl: string): number;
  snapshots(): readonly SpatialRequestSnapshot[];
  dispose(): void;
}>;

/**
 * High-level query composition boundary. The pipeline reuses the existing
 * ArcGIS executor and injected transport; it does not issue fetch calls or
 * derive service endpoints. Equal logical requests share one bounded spatial
 * coordinator execution while each subscriber keeps independent cancellation.
 */
export const createArcGisQueryPipeline = (dependencies: Readonly<{
  transport: ArcGisQueryTransport;
  scheduler?: ArcGisScheduler;
  concurrency?: number;
  maximumQueued?: number;
  maximumCacheEntries?: number;
  defaultCacheTtlMs?: number;
  defaultPageSize?: number;
  defaultMaxFeatures?: number;
  defaultMaxPages?: number;
}>): ArcGisQueryPipeline => {
  if (!dependencies || typeof dependencies.transport !== 'function') {
    throw new ArcGisQueryPipelineError('ArcGIS query pipeline requires an injected transport.', 'MISSING_TRANSPORT');
  }

  const queryExecutor = createArcGisQueryExecutor({
    transport: dependencies.transport,
    ...(dependencies.scheduler ? { scheduler: dependencies.scheduler } : {}),
  });
  const windowExecutor = createArcGisFeatureWindowExecutor({
    transport: dependencies.transport,
    ...(dependencies.scheduler ? { scheduler: dependencies.scheduler } : {}),
    ...(dependencies.defaultPageSize !== undefined ? { defaultPageSize: dependencies.defaultPageSize } : {}),
    ...(dependencies.defaultMaxFeatures !== undefined ? { defaultMaxFeatures: dependencies.defaultMaxFeatures } : {}),
    ...(dependencies.defaultMaxPages !== undefined ? { defaultMaxPages: dependencies.defaultMaxPages } : {}),
  });
  const coordinator = createSpatialRequestCoordinator({
    concurrency: boundedInteger(dependencies.concurrency, 6, 64),
    maximumQueued: boundedInteger(dependencies.maximumQueued, 256, 4_096),
    maximumCacheEntries: boundedInteger(dependencies.maximumCacheEntries, 128, 2_048),
  });
  const defaultCacheTtlMs = boundedTtl(dependencies.defaultCacheTtlMs);
  const resourceKeys = new Map<string, Set<string>>();
  let disposed = false;

  const assertLive = (): void => {
    if (disposed) throw new ArcGisQueryPipelineError('ArcGIS query pipeline is disposed.', 'DISPOSED');
  };

  const rememberKey = (resourceUrl: string, key: string): void => {
    let keys = resourceKeys.get(resourceUrl);
    if (!keys) {
      keys = new Set<string>();
      resourceKeys.set(resourceUrl, keys);
    }
    keys.add(key);
  };

  const singleKey = (contract: ArcGisMetadataContract, spec: ArcGisQuerySpec): string => {
    assertLive();
    assertContract(contract);
    return `single:${queryExecutor.requestKey(contract, spec)}`;
  };

  const windowKey = (
    contract: ArcGisMetadataContract,
    spec: ArcGisQuerySpec,
    options: ArcGisPipelineWindowOptions = {},
  ): string => {
    assertLive();
    assertContract(contract);
    if (!contract.capabilities.has('pagination')) {
      throw new ArcGisQueryPipelineError('Window queries require verified pagination capability.', 'PAGINATION_UNSUPPORTED');
    }
    if (!contract.identityReady) {
      throw new ArcGisQueryPipelineError('Window queries require stable service identity.', 'STABLE_IDENTITY_REQUIRED');
    }
    const base = specWithoutWindow(spec);
    const firstPageSpec: ArcGisQuerySpec = Object.freeze({
      ...base,
      window: Object.freeze({ resultOffset: 0, resultRecordCount: stableNumber(options.pageSize, Math.min(500, contract.maxRecordCount), Math.max(1, contract.maxRecordCount)) }),
    });
    return `window:${queryExecutor.requestKey(contract, firstPageSpec)}|${windowKeySuffix(options, contract)}`;
  };

  const runOptions = (options: ArcGisPipelineExecutionOptions): Readonly<{
    priority: SpatialRequestPriority;
    signal?: AbortSignal;
    cacheTtlMs: number;
  }> => Object.freeze({
    priority: options.requestPriority ?? 'visible',
    ...(options.signal ? { signal: options.signal } : {}),
    cacheTtlMs: options.cacheTtlMs === undefined ? defaultCacheTtlMs : boundedTtl(options.cacheTtlMs),
  });

  const executeSingle = async (
    contract: ArcGisMetadataContract,
    spec: ArcGisQuerySpec,
    options: ArcGisPipelineExecutionOptions = {},
  ): Promise<ArcGisPipelineSingleResult> => {
    assertLive();
    const key = singleKey(contract, spec);
    rememberKey(contract.resourceUrl, key);
    const result = await coordinator.run(
      key,
      ({ signal }) => queryExecutor.execute(contract, spec, mergeQueryOptions(options, signal)),
      runOptions(options),
    );
    return Object.freeze({ mode: 'single' as const, key, result });
  };

  const executeWindow = async (
    contract: ArcGisMetadataContract,
    spec: ArcGisQuerySpec,
    options: ArcGisPipelineWindowOptions = {},
  ): Promise<ArcGisPipelineWindowResult> => {
    assertLive();
    const base = specWithoutWindow(spec);
    const key = windowKey(contract, base, options);
    rememberKey(contract.resourceUrl, key);
    const result = await coordinator.run(
      key,
      ({ signal }) => windowExecutor.execute(contract, base, mergeWindowOptions(options, signal)),
      runOptions(options),
    );
    return Object.freeze({ mode: 'window' as const, key, result });
  };

  const execute = (item: ArcGisPipelineBatchItem): Promise<ArcGisPipelineResult> => (
    item.mode === 'window'
      ? executeWindow(item.contract, item.spec, item.options)
      : executeSingle(item.contract, item.spec, item.options)
  );

  const executeBatch = async (
    items: readonly ArcGisPipelineBatchItem[],
    maximum = 128,
  ): Promise<readonly ArcGisPipelineBatchResult[]> => {
    assertLive();
    const boundedMaximum = boundedInteger(maximum, 128, 1_024);
    if (items.length > boundedMaximum) {
      throw new ArcGisQueryPipelineError(`ArcGIS query batch exceeds bounded maximum of ${boundedMaximum}.`, 'BATCH_BUDGET_EXCEEDED');
    }
    const output = await Promise.all(items.map(async (item, index) => Object.freeze({
      index,
      resourceUrl: item.contract.resourceUrl,
      result: await execute(item),
    })));
    return Object.freeze(output);
  };

  const cancelKey = (key: string, reason: unknown = 'ArcGIS pipeline request cancelled'): boolean => {
    assertLive();
    return coordinator.cancel(key, reason);
  };

  const invalidateKey = (key: string): number => {
    assertLive();
    for (const keys of resourceKeys.values()) keys.delete(key);
    return coordinator.invalidate(key);
  };

  const invalidateResource = (rawResourceUrl: string): number => {
    assertLive();
    const resourceUrl = String(rawResourceUrl ?? '').trim();
    if (!resourceUrl) return 0;
    const keys = resourceKeys.get(resourceUrl);
    if (!keys) return 0;
    let invalidated = 0;
    for (const key of keys) invalidated += coordinator.invalidate(key);
    resourceKeys.delete(resourceUrl);
    return invalidated;
  };

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    resourceKeys.clear();
    coordinator.dispose();
  };

  return Object.freeze({
    executeSingle,
    executeWindow,
    execute,
    executeBatch,
    keyForSingle: singleKey,
    keyForWindow: windowKey,
    cancelKey,
    invalidateKey,
    invalidateResource,
    snapshots: coordinator.snapshots,
    dispose,
  });
};
