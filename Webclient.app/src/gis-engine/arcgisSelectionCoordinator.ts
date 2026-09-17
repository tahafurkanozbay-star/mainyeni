import { type ArcGisMetadataContract } from './arcgisMetadataAdapter';
import { type ArcGisEnvelope, type ArcGisQuerySpec } from './arcgisQueryContract';
import {
  createArcGisQueryExecutor,
  type ArcGisFeature,
  type ArcGisQueryExecutionOptions,
  type ArcGisQueryResult,
  type ArcGisQueryTransport,
  type ArcGisScheduler,
} from './arcgisQueryExecutor';

export type ArcGisSelectionMode = 'replace' | 'add' | 'remove';
export type ArcGisSelectionIdentity = string | number;

export type ArcGisSelectionRequest = Readonly<{
  layerId: string;
  contract: ArcGisMetadataContract;
  where?: string;
  geometry?: ArcGisEnvelope;
  outFields?: readonly string[];
  mode?: ArcGisSelectionMode;
}>;

export type ArcGisSelectionSnapshot = Readonly<{
  layerId: string;
  revision: number;
  status: 'idle' | 'loading' | 'ready' | 'error';
  identities: readonly ArcGisSelectionIdentity[];
  features: readonly ArcGisFeature[];
  requestKey: string | null;
  error: string | null;
}>;

export type ArcGisSelectionExecutionOptions = ArcGisQueryExecutionOptions & Readonly<{
  maxSelectionSize?: number;
}>;

export class ArcGisSelectionCoordinatorError extends Error {
  readonly code: string;
  constructor(message: string, code = 'ARCGIS_SELECTION_COORDINATOR_ERROR') {
    super(message);
    this.name = 'ArcGisSelectionCoordinatorError';
    this.code = code;
  }
}

type LayerState = {
  revision: number;
  controller: AbortController | null;
  snapshot: ArcGisSelectionSnapshot;
};

const boundedSelectionSize = (value: unknown, fallback: number): number => {
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric) || numeric <= 0) return fallback;
  return Math.min(numeric, 25_000);
};

const normalizedLayerId = (value: unknown): string => {
  const layerId = String(value ?? '').trim();
  if (!layerId || layerId.length > 256) {
    throw new ArcGisSelectionCoordinatorError('Selection requires a bounded non-empty layer id.', 'INVALID_LAYER_ID');
  }
  return layerId;
};

const stableIdentity = (contract: ArcGisMetadataContract, feature: ArcGisFeature): ArcGisSelectionIdentity | null => {
  const objectId = contract.objectIdField ? feature.attributes[contract.objectIdField] : undefined;
  if (typeof objectId === 'string' || typeof objectId === 'number') return objectId;
  const globalId = contract.globalIdField ? feature.attributes[contract.globalIdField] : undefined;
  if (typeof globalId === 'string' || typeof globalId === 'number') return globalId;
  return null;
};

const emptySnapshot = (layerId: string): ArcGisSelectionSnapshot => Object.freeze({
  layerId,
  revision: 0,
  status: 'idle' as const,
  identities: Object.freeze([]),
  features: Object.freeze([]),
  requestKey: null,
  error: null,
});

const querySpec = (request: ArcGisSelectionRequest): ArcGisQuerySpec => Object.freeze({
  where: String(request.where ?? '1=1').trim() || '1=1',
  // An empty outFields list is the query-contract representation of ArcGIS `*`.
  // Do not inject `*` as a field token: explicit field names are intentionally
  // validated by createArcGisQueryPlan and wildcard is serialized only there.
  outFields: request.outFields?.length ? request.outFields : Object.freeze([]),
  returnGeometry: true,
  ...(request.geometry ? {
    geometry: request.geometry,
    geometryType: 'esriGeometryEnvelope' as const,
    spatialRel: 'esriSpatialRelIntersects' as const,
  } : {}),
});

const mergeSelection = (
  previous: ArcGisSelectionSnapshot,
  contract: ArcGisMetadataContract,
  result: ArcGisQueryResult,
  mode: ArcGisSelectionMode,
  maximum: number,
): Readonly<{ identities: readonly ArcGisSelectionIdentity[]; features: readonly ArcGisFeature[] }> => {
  const incoming = new Map<ArcGisSelectionIdentity, ArcGisFeature>();
  for (const feature of result.features) {
    const identity = stableIdentity(contract, feature);
    if (identity === null) {
      throw new ArcGisSelectionCoordinatorError('Selection result contains a feature without stable service identity.', 'UNSTABLE_SELECTION_IDENTITY');
    }
    if (!incoming.has(identity)) incoming.set(identity, feature);
  }

  const selected = new Map<ArcGisSelectionIdentity, ArcGisFeature>();
  if (mode !== 'replace') {
    for (let index = 0; index < previous.identities.length; index += 1) {
      const identity = previous.identities[index];
      const feature = previous.features[index];
      if (identity !== undefined && feature !== undefined) selected.set(identity, feature);
    }
  }
  if (mode === 'remove') {
    for (const identity of incoming.keys()) selected.delete(identity);
  } else {
    for (const [identity, feature] of incoming) selected.set(identity, feature);
  }
  if (selected.size > maximum) {
    throw new ArcGisSelectionCoordinatorError(`Selection exceeds bounded size of ${maximum}.`, 'SELECTION_BUDGET_EXCEEDED');
  }
  return Object.freeze({
    identities: Object.freeze(Array.from(selected.keys())),
    features: Object.freeze(Array.from(selected.values())),
  });
};

const abortError = (reason: unknown): Error => {
  const error = new Error(String(reason ?? 'Selection superseded'));
  error.name = 'AbortError';
  return error;
};

/**
 * Owns interactive ArcGIS selection concurrency without owning transport.
 * A new request for a layer cancels the previous request for that layer while
 * requests for unrelated layers remain independent. Stale completions are
 * ignored by revision so a transport that resolves after abort cannot overwrite
 * newer user intent.
 */
export const createArcGisSelectionCoordinator = (dependencies: Readonly<{
  transport: ArcGisQueryTransport;
  scheduler?: ArcGisScheduler;
  defaultMaxSelectionSize?: number;
}>): Readonly<{
  select(request: ArcGisSelectionRequest, options?: ArcGisSelectionExecutionOptions): Promise<ArcGisSelectionSnapshot>;
  snapshot(layerId: string): ArcGisSelectionSnapshot;
  cancel(layerId: string, reason?: unknown): boolean;
  clear(layerId: string): ArcGisSelectionSnapshot;
  dispose(): void;
}> => {
  const executor = createArcGisQueryExecutor(dependencies);
  const layers = new Map<string, LayerState>();
  const defaultMaximum = boundedSelectionSize(dependencies.defaultMaxSelectionSize, 5_000);
  let disposed = false;

  const requireActive = (): void => {
    if (disposed) throw new ArcGisSelectionCoordinatorError('Selection coordinator is disposed.', 'COORDINATOR_DISPOSED');
  };

  const stateFor = (layerId: string): LayerState => {
    const existing = layers.get(layerId);
    if (existing) return existing;
    const created: LayerState = { revision: 0, controller: null, snapshot: emptySnapshot(layerId) };
    layers.set(layerId, created);
    return created;
  };

  const snapshot = (rawLayerId: string): ArcGisSelectionSnapshot => {
    const layerId = normalizedLayerId(rawLayerId);
    return layers.get(layerId)?.snapshot ?? emptySnapshot(layerId);
  };

  const cancel = (rawLayerId: string, reason: unknown = 'Selection cancelled'): boolean => {
    const layerId = normalizedLayerId(rawLayerId);
    const state = layers.get(layerId);
    if (!state?.controller || state.controller.signal.aborted) return false;
    state.controller.abort(reason);
    state.controller = null;
    return true;
  };

  const clear = (rawLayerId: string): ArcGisSelectionSnapshot => {
    requireActive();
    const layerId = normalizedLayerId(rawLayerId);
    const state = stateFor(layerId);
    state.controller?.abort('Selection cleared');
    state.controller = null;
    state.revision += 1;
    state.snapshot = Object.freeze({ ...emptySnapshot(layerId), revision: state.revision });
    return state.snapshot;
  };

  const select = async (
    request: ArcGisSelectionRequest,
    options: ArcGisSelectionExecutionOptions = {},
  ): Promise<ArcGisSelectionSnapshot> => {
    requireActive();
    const layerId = normalizedLayerId(request.layerId);
    if (!request.contract.queryReady || !request.contract.identityReady) {
      throw new ArcGisSelectionCoordinatorError('Selection requires query-ready metadata with stable identity.', 'SELECTION_CONTRACT_NOT_READY');
    }
    const state = stateFor(layerId);
    state.controller?.abort('Selection superseded');
    const controller = new AbortController();
    state.controller = controller;
    state.revision += 1;
    const revision = state.revision;
    const previous = state.snapshot;
    state.snapshot = Object.freeze({
      ...previous,
      revision,
      status: 'loading' as const,
      requestKey: null,
      error: null,
    });

    const outer = options.signal;
    const abortFromOuter = (): void => controller.abort(outer?.reason);
    if (outer?.aborted) abortFromOuter();
    else outer?.addEventListener('abort', abortFromOuter, { once: true });

    try {
      const result = await executor.execute(request.contract, querySpec(request), {
        ...options,
        signal: controller.signal,
        requireStableIdentity: true,
        rejectTransferLimit: true,
        cache: false,
      });
      if (controller.signal.aborted) throw abortError(controller.signal.reason);
      if (state.revision !== revision) return state.snapshot;
      const merged = mergeSelection(previous, request.contract, result, request.mode ?? 'replace', boundedSelectionSize(options.maxSelectionSize, defaultMaximum));
      state.snapshot = Object.freeze({
        layerId,
        revision,
        status: 'ready' as const,
        identities: merged.identities,
        features: merged.features,
        requestKey: result.requestKey,
        error: null,
      });
      return state.snapshot;
    } catch (error) {
      if (state.revision !== revision) return state.snapshot;
      if (controller.signal.aborted || (error instanceof Error && error.name === 'AbortError')) {
        state.snapshot = Object.freeze({ ...previous, revision, status: 'idle' as const, requestKey: null, error: null });
        throw abortError(controller.signal.reason);
      }
      state.snapshot = Object.freeze({
        ...previous,
        revision,
        status: 'error' as const,
        requestKey: null,
        error: error instanceof Error ? error.message : 'ArcGIS selection failed.',
      });
      throw error;
    } finally {
      outer?.removeEventListener('abort', abortFromOuter);
      if (state.revision === revision && state.controller === controller) state.controller = null;
    }
  };

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    for (const state of layers.values()) state.controller?.abort('Selection coordinator disposed');
    layers.clear();
  };

  return Object.freeze({ select, snapshot, cancel, clear, dispose });
};
