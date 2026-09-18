import {
  type SpatialQueryBatchOptions,
  type SpatialQueryBatchResult,
  type SpatialQueryBatchTask,
  executeSpatialQueryBatch,
} from "./spatialQueryBatchRuntime";
import type { SpatialQueryBudgetPolicy } from "./spatialQueryBudgetRuntime";
import type { SpatialQueryContractInput } from "./spatialQueryContractRuntime";
import type {
  SpatialQuerySession,
  SpatialQuerySessionRequest,
} from "./spatialQuerySessionRuntime";
import type {
  SpatialViewQueryState,
  SpatialViewQueryStateCoordinator,
} from "./spatialViewQueryStateRuntime";

export interface SpatialLayerQueryBinding {
  readonly layerId: string;
  readonly session: SpatialQuerySession;
  readonly contract?: SpatialQueryContractInput;
  readonly budget: SpatialQueryBudgetPolicy;
  readonly integrity?: SpatialQuerySessionRequest["integrity"];
  readonly priority?: number;
  readonly estimatedBytes?: number;
  readonly cache?: boolean;
  readonly dedupe?: boolean;
  readonly cacheTtlMs?: number;
}

export interface SpatialQueryParityOptions {
  readonly coordinator: SpatialViewQueryStateCoordinator;
  readonly maxBindings?: number;
  readonly maxIdentifierLength?: number;
  readonly unknownVisibleLayer?: "skip" | "error";
  readonly batch?: Omit<SpatialQueryBatchOptions, "signal">;
}

export interface SpatialViewLayerQueryPlan {
  readonly viewId: string;
  readonly viewRevision: number;
  readonly viewFingerprint: string;
  readonly taskCount: number;
  readonly tasks: readonly SpatialQueryBatchTask[];
  readonly missingLayerIds: readonly string[];
  readonly fingerprint: string;
}

export interface SpatialQueryParityStats {
  readonly registeredLayers: number;
  readonly plans: number;
  readonly executions: number;
  readonly invalidations: number;
  readonly skippedUnknownLayers: number;
  readonly fulfilledTasks: number;
  readonly rejectedTasks: number;
  readonly cancelledTasks: number;
}

export interface SpatialQueryParityRuntime {
  readonly register: (binding: SpatialLayerQueryBinding) => void;
  readonly unregister: (layerId: string) => boolean;
  readonly has: (layerId: string) => boolean;
  readonly plan: (viewId: string) => SpatialViewLayerQueryPlan;
  readonly execute: (viewId: string, signal?: AbortSignal) => Promise<SpatialQueryBatchResult>;
  readonly invalidateLayer: (layerId: string) => number;
  readonly equivalentViews: (leftViewId: string, rightViewId: string) => boolean;
  readonly stats: () => SpatialQueryParityStats;
  readonly clear: () => void;
}

const DEFAULT_MAX_BINDINGS = 512;
const DEFAULT_MAX_IDENTIFIER_LENGTH = 256;

function positiveInteger(value: number | undefined, fallback: number, label: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new RangeError(`${label} must be a positive safe integer`);
  }
  return resolved;
}

function normalizeIdentifier(value: string, maxLength: number, label: string): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maxLength) {
    throw new RangeError(`${label} has invalid length`);
  }
  return normalized;
}

function finitePriority(value: number | undefined): number {
  const priority = value ?? 0;
  if (!Number.isFinite(priority)) {
    throw new TypeError("layer query priority must be finite");
  }
  return priority;
}

function finiteBytes(value: number | undefined): number {
  const bytes = value ?? 0;
  if (!Number.isFinite(bytes) || bytes < 0) {
    throw new RangeError("layer query estimatedBytes must be finite and non-negative");
  }
  return Math.floor(bytes);
}

function hash(value: string): string {
  let state = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    state = Math.imul(state ^ value.charCodeAt(index), 0x01000193);
  }
  return (state >>> 0).toString(16).padStart(8, "0");
}

function bindingFingerprint(binding: SpatialLayerQueryBinding): string {
  return hash(JSON.stringify({
    layerId: binding.layerId,
    contract: binding.contract ?? null,
    budget: binding.budget,
    priority: binding.priority ?? 0,
    estimatedBytes: binding.estimatedBytes ?? 0,
    cache: binding.cache !== false,
    dedupe: binding.dedupe !== false,
    cacheTtlMs: binding.cacheTtlMs ?? null,
  }));
}

function requestFor(
  binding: SpatialLayerQueryBinding,
  signal?: AbortSignal,
): SpatialQuerySessionRequest {
  return {
    ...(binding.contract === undefined ? {} : { contract: binding.contract }),
    budget: binding.budget,
    ...(binding.integrity === undefined ? {} : { integrity: binding.integrity }),
    ...(binding.cache === undefined ? {} : { cache: binding.cache }),
    ...(binding.dedupe === undefined ? {} : { dedupe: binding.dedupe }),
    ...(binding.cacheTtlMs === undefined ? {} : { cacheTtlMs: binding.cacheTtlMs }),
    ...(signal === undefined ? {} : { signal }),
  };
}

export function createSpatialQueryParityRuntime(
  options: SpatialQueryParityOptions,
): SpatialQueryParityRuntime {
  const maxBindings = positiveInteger(
    options.maxBindings,
    DEFAULT_MAX_BINDINGS,
    "maxBindings",
  );
  const maxIdentifierLength = positiveInteger(
    options.maxIdentifierLength,
    DEFAULT_MAX_IDENTIFIER_LENGTH,
    "maxIdentifierLength",
  );
  const unknownVisibleLayer = options.unknownVisibleLayer ?? "skip";
  const bindings = new Map<string, SpatialLayerQueryBinding>();
  const bindingVersions = new Map<string, number>();

  let plans = 0;
  let executions = 0;
  let invalidations = 0;
  let skippedUnknownLayers = 0;
  let fulfilledTasks = 0;
  let rejectedTasks = 0;
  let cancelledTasks = 0;

  const normalizedLayerId = (layerId: string): string =>
    normalizeIdentifier(layerId, maxIdentifierLength, "layer id");

  const register = (binding: SpatialLayerQueryBinding): void => {
    const layerId = normalizedLayerId(binding.layerId);
    if (!bindings.has(layerId) && bindings.size >= maxBindings) {
      throw new RangeError("query parity runtime exceeds binding budget");
    }
    finitePriority(binding.priority);
    finiteBytes(binding.estimatedBytes);
    const normalized: SpatialLayerQueryBinding = Object.freeze({
      ...binding,
      layerId,
    });
    const previous = bindings.get(layerId);
    bindings.set(layerId, normalized);
    if (!previous || bindingFingerprint(previous) !== bindingFingerprint(normalized)) {
      bindingVersions.set(layerId, (bindingVersions.get(layerId) ?? 0) + 1);
      options.coordinator.invalidateLayer(layerId);
      previous?.session.invalidate();
    }
  };

  const unregister = (layerIdInput: string): boolean => {
    const layerId = normalizedLayerId(layerIdInput);
    const previous = bindings.get(layerId);
    if (!previous) {
      return false;
    }
    bindings.delete(layerId);
    bindingVersions.delete(layerId);
    options.coordinator.invalidateLayer(layerId);
    previous.session.invalidate();
    return true;
  };

  const has = (layerId: string): boolean =>
    bindings.has(normalizedLayerId(layerId));

  const stateFor = (viewId: string): SpatialViewQueryState => {
    const state = options.coordinator.get(viewId);
    if (!state) {
      throw new RangeError("view state is not registered");
    }
    return state;
  };

  const plan = (viewId: string): SpatialViewLayerQueryPlan => {
    const state = stateFor(viewId);
    const tasks: SpatialQueryBatchTask[] = [];
    const missingLayerIds: string[] = [];
    const planParts: string[] = [state.fingerprint];

    for (const layerId of state.visibleLayerIds) {
      const binding = bindings.get(layerId);
      if (!binding) {
        missingLayerIds.push(layerId);
        if (unknownVisibleLayer === "error") {
          throw new RangeError(`visible layer ${layerId} has no query binding`);
        }
        skippedUnknownLayers += 1;
        continue;
      }

      const version = bindingVersions.get(layerId) ?? 0;
      const bindingKey = bindingFingerprint(binding);
      const taskId = `${state.viewId}:${layerId}:r${state.revision}:b${version}`;
      planParts.push(`${layerId}:${version}:${bindingKey}`);
      tasks.push(Object.freeze({
        id: taskId,
        session: binding.session,
        request: requestFor(binding),
        priority: finitePriority(binding.priority),
        estimatedBytes: finiteBytes(binding.estimatedBytes),
      }));
    }

    plans += 1;
    return Object.freeze({
      viewId: state.viewId,
      viewRevision: state.revision,
      viewFingerprint: state.fingerprint,
      taskCount: tasks.length,
      tasks: Object.freeze(tasks),
      missingLayerIds: Object.freeze(missingLayerIds),
      fingerprint: hash(planParts.join("|")),
    });
  };

  const execute = async (
    viewId: string,
    signal?: AbortSignal,
  ): Promise<SpatialQueryBatchResult> => {
    const queryPlan = plan(viewId);
    const tasks = queryPlan.tasks.map((task) => Object.freeze({
      ...task,
      request: {
        ...task.request,
        ...(signal === undefined ? {} : { signal }),
      },
    }));
    executions += 1;
    const result = await executeSpatialQueryBatch(tasks, {
      ...options.batch,
      ...(signal === undefined ? {} : { signal }),
    });
    fulfilledTasks += result.fulfilled;
    rejectedTasks += result.rejected;
    cancelledTasks += result.cancelled;
    return result;
  };

  const invalidateLayer = (layerIdInput: string): number => {
    const layerId = normalizedLayerId(layerIdInput);
    const binding = bindings.get(layerId);
    if (!binding) {
      return 0;
    }
    invalidations += 1;
    bindingVersions.set(layerId, (bindingVersions.get(layerId) ?? 0) + 1);
    binding.session.invalidate();
    return options.coordinator.invalidateLayer(layerId);
  };

  const equivalentViews = (leftViewId: string, rightViewId: string): boolean =>
    options.coordinator.queryEquivalent(leftViewId, rightViewId);

  const stats = (): SpatialQueryParityStats =>
    Object.freeze({
      registeredLayers: bindings.size,
      plans,
      executions,
      invalidations,
      skippedUnknownLayers,
      fulfilledTasks,
      rejectedTasks,
      cancelledTasks,
    });

  const clear = (): void => {
    for (const [layerId, binding] of bindings) {
      binding.session.invalidate();
      options.coordinator.invalidateLayer(layerId);
    }
    bindings.clear();
    bindingVersions.clear();
  };

  return Object.freeze({
    register,
    unregister,
    has,
    plan,
    execute,
    invalidateLayer,
    equivalentViews,
    stats,
    clear,
  });
}
