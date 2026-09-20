import {
  createSpatialRequestCoordinator,
  type SpatialRequestPriority,
} from './spatialRequestCoordinator';
import {
  createViewportBudgetController,
  type ViewportBudgetController,
  type ViewportBudgetControllerSnapshot,
  type ViewportPerformanceSample,
} from './viewportBudgetController';
import {
  createViewportQueryPolicy,
  type ViewportQueryInput,
  type ViewportQueryPlan,
  type ViewportQueryPolicy,
} from './viewportQueryPolicy';
import {
  createViewportResultWindowRuntime,
  type ViewportResultCommit,
  type ViewportResultFeature,
  type ViewportResultRuntimeSnapshot,
  type ViewportResultWindowRuntime,
} from './viewportResultWindowRuntime';
import {
  createViewportTilePlanner,
  type ViewportQueryTile,
  type ViewportTilePlan,
  type ViewportTilePlanner,
} from './viewportTilePlanner';

export interface ViewportTileExecutionResponse<TPayload = unknown> {
  readonly features: readonly ViewportResultFeature<TPayload>[];
  readonly complete?: boolean;
  readonly exceededTransferLimit?: boolean;
}

export interface ViewportTileExecutionContext {
  readonly signal: AbortSignal;
  readonly generation: number;
  readonly tile: ViewportQueryTile;
  readonly queryPlan: ViewportQueryPlan;
  readonly tilePlan: ViewportTilePlan;
}

export interface ViewportQueryExecutionInput extends ViewportQueryInput {
  readonly cacheTtlMs?: number;
  readonly signal?: AbortSignal;
  readonly failFast?: boolean;
}

export interface ViewportQueryExecutionTileResult {
  readonly tileId: string;
  readonly index: number;
  readonly status: 'fulfilled' | 'rejected' | 'cancelled' | 'skipped' | 'stale';
  readonly accepted: number;
  readonly replaced: number;
  readonly error: unknown | null;
}

export interface ViewportQueryExecutionResult<TPayload = unknown> {
  readonly layerId: string;
  readonly generation: number;
  readonly queryPlan: ViewportQueryPlan;
  readonly tilePlan: ViewportTilePlan;
  readonly pressure: ViewportBudgetControllerSnapshot;
  readonly status: 'complete' | 'partial' | 'cancelled' | 'stale' | 'skipped';
  readonly tileResults: readonly ViewportQueryExecutionTileResult[];
  readonly features: readonly ViewportResultFeature<TPayload>[];
  readonly warnings: readonly string[];
}

export interface ViewportQueryExecutionSnapshot {
  readonly disposed: boolean;
  readonly executionsStarted: number;
  readonly executionsCompleted: number;
  readonly executionsCancelled: number;
  readonly staleExecutions: number;
  readonly tileRequestsStarted: number;
  readonly tileRequestsFailed: number;
  readonly tileRequestsSkipped: number;
  readonly activeLayers: number;
  readonly pressure: ViewportBudgetControllerSnapshot;
  readonly results: ViewportResultRuntimeSnapshot;
}

export interface ViewportQueryExecutionConfiguration<TPayload = unknown> {
  readonly policy?: ViewportQueryPolicy;
  readonly budgetController?: ViewportBudgetController;
  readonly tilePlanner?: ViewportTilePlanner;
  readonly resultWindow?: ViewportResultWindowRuntime<TPayload>;
  readonly requestCoordinator?: ReturnType<typeof createSpatialRequestCoordinator>;
  readonly maximumConcurrentTiles?: number;
  readonly cacheTtlMs?: number;
  readonly cacheTtlMaximumMs?: number;
  readonly suppressCriticalPrefetch?: boolean;
  readonly now?: () => number;
}

interface LayerExecution {
  generation: number;
  controller: AbortController;
  startedAt: number;
}

const positiveInteger = (value: number | undefined, fallback: number, maximum: number, name: string): number => {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0 || resolved > maximum) {
    throw new RangeError(`${name} must be a positive safe integer <= ${maximum}`);
  }
  return resolved;
};

const boundedTtl = (value: number | undefined, fallback: number, maximum: number): number => {
  const resolved = value ?? fallback;
  if (!Number.isFinite(resolved) || resolved < 0) throw new RangeError('cacheTtlMs must be finite and non-negative');
  return Math.min(maximum, Math.floor(resolved));
};

const normalizeLayerId = (value: string): string => {
  const normalized = value.trim();
  if (!normalized) throw new TypeError('layerId is required');
  if (normalized.length > 256) throw new RangeError('layerId exceeds 256 characters');
  return normalized;
};

const isAbortError = (value: unknown): boolean => (
  value instanceof Error && value.name === 'AbortError'
);

const requestPriority = (priority: ViewportQueryPlan['priority']): SpatialRequestPriority => {
  if (priority === 'interactive') return 'interactive';
  if (priority === 'prefetch') return 'prefetch';
  return 'visible';
};

const linkAbortSignal = (
  parent: AbortSignal | undefined,
  controller: AbortController,
): (() => void) => {
  if (!parent) return () => undefined;
  if (parent.aborted) {
    controller.abort(parent.reason);
    return () => undefined;
  }
  const listener = (): void => controller.abort(parent.reason);
  parent.addEventListener('abort', listener, { once: true });
  return () => parent.removeEventListener('abort', listener);
};

const effectiveConcurrency = (
  maximum: number,
  factor: number,
  tileCount: number,
): number => Math.max(1, Math.min(tileCount, Math.floor(maximum * factor)));

const effectiveCacheTtl = (
  ttl: number,
  factor: number,
  maximum: number,
): number => Math.min(maximum, Math.max(0, Math.floor(ttl * factor)));

const mergeWarnings = (...groups: readonly (readonly string[])[]): readonly string[] => Object.freeze([
  ...new Set(groups.flatMap((group) => [...group])),
]);

export class ViewportQueryExecutionRuntime<TPayload = unknown> {
  readonly #policy: ViewportQueryPolicy;
  readonly #budget: ViewportBudgetController;
  readonly #tiles: ViewportTilePlanner;
  readonly #results: ViewportResultWindowRuntime<TPayload>;
  readonly #requests: ReturnType<typeof createSpatialRequestCoordinator>;
  readonly #maximumConcurrentTiles: number;
  readonly #defaultCacheTtlMs: number;
  readonly #cacheTtlMaximumMs: number;
  readonly #suppressCriticalPrefetch: boolean;
  readonly #now: () => number;
  readonly #layers = new Map<string, LayerExecution>();
  #disposed = false;
  #executionsStarted = 0;
  #executionsCompleted = 0;
  #executionsCancelled = 0;
  #staleExecutions = 0;
  #tileRequestsStarted = 0;
  #tileRequestsFailed = 0;
  #tileRequestsSkipped = 0;

  constructor(configuration: ViewportQueryExecutionConfiguration<TPayload> = {}) {
    this.#policy = configuration.policy ?? createViewportQueryPolicy();
    this.#budget = configuration.budgetController ?? createViewportBudgetController();
    this.#tiles = configuration.tilePlanner ?? createViewportTilePlanner();
    this.#results = configuration.resultWindow ?? createViewportResultWindowRuntime<TPayload>();
    this.#maximumConcurrentTiles = positiveInteger(
      configuration.maximumConcurrentTiles,
      6,
      64,
      'maximumConcurrentTiles',
    );
    this.#defaultCacheTtlMs = boundedTtl(configuration.cacheTtlMs, 5_000, 300_000);
    this.#cacheTtlMaximumMs = boundedTtl(configuration.cacheTtlMaximumMs, 300_000, 300_000);
    if (this.#defaultCacheTtlMs > this.#cacheTtlMaximumMs) {
      throw new RangeError('cacheTtlMs cannot exceed cacheTtlMaximumMs');
    }
    this.#suppressCriticalPrefetch = configuration.suppressCriticalPrefetch !== false;
    this.#now = configuration.now ?? (() => Date.now());
    this.#requests = configuration.requestCoordinator ?? createSpatialRequestCoordinator({
      concurrency: this.#maximumConcurrentTiles,
      maximumQueued: 512,
      maximumCacheEntries: 256,
      now: this.#now,
    });
  }

  samplePerformance(sample: ViewportPerformanceSample): ViewportBudgetControllerSnapshot {
    this.#assertActive();
    return this.#budget.sample(sample);
  }

  async execute(
    input: ViewportQueryExecutionInput,
    executor: (
      context: ViewportTileExecutionContext,
    ) => Promise<ViewportTileExecutionResponse<TPayload>>,
  ): Promise<ViewportQueryExecutionResult<TPayload>> {
    this.#assertActive();
    if (typeof executor !== 'function') throw new TypeError('viewport tile executor is required');
    const layerId = normalizeLayerId(input.layerId);
    const queryPlan = this.#policy.plan({ ...input, layerId });
    const pressure = this.#budget.snapshot();
    const warnings: string[] = [...queryPlan.warnings];

    if (
      this.#suppressCriticalPrefetch
      && queryPlan.priority === 'prefetch'
      && pressure.pressure === 'critical'
    ) {
      this.#tileRequestsSkipped += 1;
      return Object.freeze({
        layerId,
        generation: this.#layers.get(layerId)?.generation ?? 0,
        queryPlan,
        tilePlan: this.#tiles.plan({
          extent: queryPlan.extent,
          pixelWidth: input.pixelWidth,
          pixelHeight: input.pixelHeight,
          maxFeatures: 1,
          estimatedFeatureDensity: input.estimatedFeatureDensity,
          priority: queryPlan.priority,
          moving: input.moving,
        }),
        pressure,
        status: 'skipped',
        tileResults: Object.freeze([]),
        features: Object.freeze([]),
        warnings: Object.freeze([...warnings, 'critical-pressure-prefetch-suppressed']),
      });
    }

    const previous = this.#layers.get(layerId);
    const generation = (previous?.generation ?? 0) + 1;
    previous?.controller.abort('viewport superseded');
    const controller = new AbortController();
    const unlink = linkAbortSignal(input.signal, controller);
    const execution: LayerExecution = {
      generation,
      controller,
      startedAt: this.#now(),
    };
    this.#layers.set(layerId, execution);
    this.#executionsStarted += 1;

    const adjustedMaxFeatures = Math.max(
      1,
      Math.floor(queryPlan.maxFeatures * pressure.profile.maxFeaturesFactor),
    );
    if (adjustedMaxFeatures < queryPlan.maxFeatures) warnings.push('pressure-feature-budget-reduced');

    const tilePlan = this.#tiles.plan({
      extent: queryPlan.extent,
      pixelWidth: input.pixelWidth,
      pixelHeight: input.pixelHeight,
      maxFeatures: adjustedMaxFeatures,
      estimatedFeatureDensity: input.estimatedFeatureDensity,
      priority: queryPlan.priority,
      moving: input.moving,
    });
    warnings.push(...tilePlan.warnings);
    const windowKey = `layer:${layerId}`;
    this.#results.begin(windowKey, generation, { pinned: true, timestamp: this.#now() });

    if (controller.signal.aborted) {
      unlink();
      this.#executionsCancelled += 1;
      this.#results.pin(windowKey, false);
      return this.#finalize(
        layerId,
        generation,
        queryPlan,
        tilePlan,
        pressure,
        [],
        warnings,
        'cancelled',
      );
    }

    const concurrency = effectiveConcurrency(
      this.#maximumConcurrentTiles,
      pressure.profile.concurrencyFactor,
      tilePlan.tileCount,
    );
    const cacheTtl = effectiveCacheTtl(
      boundedTtl(input.cacheTtlMs, this.#defaultCacheTtlMs, this.#cacheTtlMaximumMs),
      pressure.profile.cacheTtlFactor,
      this.#cacheTtlMaximumMs,
    );
    const tileResults: Array<ViewportQueryExecutionTileResult | undefined> = Array.from({ length: tilePlan.tiles.length }, () => undefined);
    let nextIndex = 0;
    let failFastError: unknown = null;

    const worker = async (): Promise<void> => {
      while (nextIndex < tilePlan.tiles.length) {
        if (controller.signal.aborted || failFastError !== null) return;
        const position = nextIndex;
        nextIndex += 1;
        const tile = tilePlan.tiles[position];
        if (!tile) return;

        const latest = this.#layers.get(layerId);
        if (!latest || latest.generation !== generation) {
          tileResults[position] = Object.freeze({
            tileId: tile.id,
            index: tile.index,
            status: 'stale',
            accepted: 0,
            replaced: 0,
            error: null,
          });
          continue;
        }

        const requestKey = `viewport|${queryPlan.key}|${tile.id}`;
        this.#tileRequestsStarted += 1;
        try {
          const response = await this.#requests.run(
            requestKey,
            ({ signal }) => executor({
              signal,
              generation,
              tile,
              queryPlan,
              tilePlan,
            }),
            {
              priority: requestPriority(queryPlan.priority),
              signal: controller.signal,
              cacheTtlMs: cacheTtl,
            },
          );

          const current = this.#layers.get(layerId);
          if (!current || current.generation !== generation) {
            tileResults[position] = Object.freeze({
              tileId: tile.id,
              index: tile.index,
              status: 'stale',
              accepted: 0,
              replaced: 0,
              error: null,
            });
            continue;
          }

          const commit: ViewportResultCommit = this.#results.commitPage({
            windowKey,
            generation,
            pageIndex: tile.index,
            features: response.features,
            complete: response.complete === true,
            timestamp: this.#now(),
          });
          if (response.exceededTransferLimit === true) warnings.push('transport-transfer-limit-exceeded');
          tileResults[position] = Object.freeze({
            tileId: tile.id,
            index: tile.index,
            status: commit.stale ? 'stale' : 'fulfilled',
            accepted: commit.accepted,
            replaced: commit.replaced,
            error: null,
          });
        } catch (error) {
          const cancelled = controller.signal.aborted || isAbortError(error);
          if (!cancelled) this.#tileRequestsFailed += 1;
          tileResults[position] = Object.freeze({
            tileId: tile.id,
            index: tile.index,
            status: cancelled ? 'cancelled' : 'rejected',
            accepted: 0,
            replaced: 0,
            error,
          });
          if (!cancelled && input.failFast === true) {
            failFastError = error;
            controller.abort('viewport tile failed fast');
          }
        }
      }
    };

    try {
      await Promise.all(Array.from({ length: concurrency }, () => worker()));
    } finally {
      unlink();
      this.#results.pin(windowKey, false);
    }

    const current = this.#layers.get(layerId);
    if (!current || current.generation !== generation) {
      this.#staleExecutions += 1;
      return this.#finalize(
        layerId,
        generation,
        queryPlan,
        tilePlan,
        pressure,
        tileResults,
        warnings,
        'stale',
      );
    }

    if (controller.signal.aborted) {
      this.#executionsCancelled += 1;
      return this.#finalize(
        layerId,
        generation,
        queryPlan,
        tilePlan,
        pressure,
        tileResults,
        warnings,
        failFastError === null ? 'cancelled' : 'partial',
      );
    }

    const rejected = tileResults.filter((result) => result?.status === 'rejected').length;
    const stale = tileResults.filter((result) => result?.status === 'stale').length;
    const status = rejected > 0 || stale > 0 ? 'partial' : 'complete';
    this.#executionsCompleted += 1;
    return this.#finalize(
      layerId,
      generation,
      queryPlan,
      tilePlan,
      pressure,
      tileResults,
      warnings,
      status,
    );
  }

  cancelLayer(layerId: string, reason: unknown = 'viewport layer cancelled'): boolean {
    this.#assertActive();
    const id = normalizeLayerId(layerId);
    const execution = this.#layers.get(id);
    if (!execution) return false;
    execution.controller.abort(reason);
    this.#layers.delete(id);
    this.#results.pin(`layer:${id}`, false);
    return true;
  }

  clearLayer(layerId: string): boolean {
    this.#assertActive();
    const id = normalizeLayerId(layerId);
    this.cancelLayer(id, 'viewport layer cleared');
    return this.#results.drop(`layer:${id}`);
  }

  readLayer(layerId: string): readonly ViewportResultFeature<TPayload>[] {
    this.#assertActive();
    return this.#results.read(`layer:${normalizeLayerId(layerId)}`);
  }

  snapshot(): ViewportQueryExecutionSnapshot {
    this.#assertActive();
    return Object.freeze({
      disposed: false,
      executionsStarted: this.#executionsStarted,
      executionsCompleted: this.#executionsCompleted,
      executionsCancelled: this.#executionsCancelled,
      staleExecutions: this.#staleExecutions,
      tileRequestsStarted: this.#tileRequestsStarted,
      tileRequestsFailed: this.#tileRequestsFailed,
      tileRequestsSkipped: this.#tileRequestsSkipped,
      activeLayers: this.#layers.size,
      pressure: this.#budget.snapshot(),
      results: this.#results.snapshot(),
    });
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const execution of this.#layers.values()) execution.controller.abort('viewport runtime disposed');
    this.#layers.clear();
    this.#requests.dispose();
    this.#results.dispose();
  }

  #finalize(
    layerId: string,
    generation: number,
    queryPlan: ViewportQueryPlan,
    tilePlan: ViewportTilePlan,
    pressure: ViewportBudgetControllerSnapshot,
    values: readonly (ViewportQueryExecutionTileResult | undefined)[],
    warnings: readonly string[],
    status: ViewportQueryExecutionResult<TPayload>['status'],
  ): ViewportQueryExecutionResult<TPayload> {
    const tileResults = Object.freeze(values.filter(
      (value): value is ViewportQueryExecutionTileResult => value !== undefined,
    ));
    return Object.freeze({
      layerId,
      generation,
      queryPlan,
      tilePlan,
      pressure,
      status,
      tileResults,
      features: this.#results.read(`layer:${layerId}`, generation),
      warnings: mergeWarnings(warnings),
    });
  }

  #assertActive(): void {
    if (this.#disposed) throw new Error('viewport query execution runtime is disposed');
  }
}

export const createViewportQueryExecutionRuntime = <TPayload = unknown>(
  configuration: ViewportQueryExecutionConfiguration<TPayload> = {},
): ViewportQueryExecutionRuntime<TPayload> => new ViewportQueryExecutionRuntime(configuration);
