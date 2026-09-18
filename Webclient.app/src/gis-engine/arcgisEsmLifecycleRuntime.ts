import {
  expandArcgisRuntimeFeatureProfile,
  planArcgisBundle,
  type ArcgisBundleBudget,
  type ArcgisBundlePlan,
  type ArcgisFeatureIntent,
  type ArcgisFeatureRequest,
  type ArcgisRuntimeFeatureProfile,
} from './arcgisBundlePlanner';
import {
  auditArcgisModuleCatalog,
  resolveArcgisCatalogModules,
  sumArcgisModuleRelativeWeight,
  type ArcgisModuleCatalogAudit,
} from './arcgisEsmModuleCatalog';
import { getDefaultArcgisEsmSpecifiers } from './arcgisEsmTransport';
import {
  createArcgisModuleLoadGovernor,
  type ArcgisGovernedModuleLoader,
  type ArcgisModuleLoadGovernor,
  type ArcgisModuleLoadGovernorConfiguration,
  type ArcgisModuleLoadGovernorSnapshot,
  type ArcgisModuleLoadPriority,
} from './arcgisModuleLoadGovernor';
import { loadArcgisModules } from './arcgisModuleRuntime';

export type ArcgisEsmLifecycleConfiguration = Readonly<{
  bundleBudget: ArcgisBundleBudget;
  governor: ArcgisModuleLoadGovernorConfiguration;
  maxEvents: number;
}>;

export type ArcgisEsmLifecycleOptions = Readonly<{
  priority?: ArcgisModuleLoadPriority;
  timeoutMs?: number;
  signal?: AbortSignal;
  requireComplete?: boolean;
}>;

export type ArcgisEsmLoadedModule = Readonly<{
  moduleId: string;
  specifier: string;
  value: unknown;
}>;

export type ArcgisEsmBundleResult = Readonly<{
  plan: ArcgisBundlePlan;
  modules: readonly ArcgisEsmLoadedModule[];
}>;

export type ArcgisEsmLifecycleEventKind =
  | 'bundle-planned'
  | 'bundle-completed'
  | 'bundle-deferred'
  | 'bundle-failed'
  | 'direct-load-completed'
  | 'disposed';

export type ArcgisEsmLifecycleEvent = Readonly<{
  kind: ArcgisEsmLifecycleEventKind;
  timestamp: number;
  requestedFeatures: number;
  moduleCount: number;
  detail: string | null;
}>;

export type ArcgisEsmLifecycleSnapshot = Readonly<{
  disposed: boolean;
  featureRequests: number;
  directRequests: number;
  incompletePlans: number;
  failedRequests: number;
  loadedSpecifiers: number;
  coverageValid: boolean;
  retainedEvents: number;
  governor: ArcgisModuleLoadGovernorSnapshot;
}>;

const positiveInteger = (value: number, name: string): number => {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return value;
};

const lifecycleDisposedError = (): Error & { code: string } => Object.assign(
  new Error('ArcGIS ESM lifecycle runtime is disposed.'),
  { code: 'LIFECYCLE_DISPOSED' },
);

const incompletePlanError = (plan: ArcgisBundlePlan): Error & { code: string; deferred: readonly ArcgisFeatureIntent[] } =>
  Object.assign(
    new Error(`ArcGIS ESM bundle budget deferred: ${plan.deferredFeatures.join(', ')}`),
    { code: 'BUNDLE_BUDGET_EXCEEDED', deferred: plan.deferredFeatures },
  );

const throwIfAborted = (signal?: AbortSignal): void => {
  if (signal?.aborted) throw signal.reason ?? Object.assign(
    new Error('ArcGIS ESM lifecycle request was cancelled.'),
    { code: 'CANCELLED' },
  );
};

const defaultLoader: ArcgisGovernedModuleLoader = async (moduleIds, signal) => {
  throwIfAborted(signal);
  const modules = await loadArcgisModules(moduleIds);
  throwIfAborted(signal);
  return modules;
};

const createLoadOptions = (
  options: ArcgisEsmLifecycleOptions,
  dedupeKey: string,
) => ({
  dedupeKey,
  priority: options.priority ?? 'interactive' as ArcgisModuleLoadPriority,
  ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  ...(options.signal === undefined ? {} : { signal: options.signal }),
});

export class ArcgisEsmLifecycleRuntime {
  #configuration: ArcgisEsmLifecycleConfiguration;
  #governor: ArcgisModuleLoadGovernor;
  #coverage: ArcgisModuleCatalogAudit;
  #disposed = false;
  #featureRequests = 0;
  #directRequests = 0;
  #incompletePlans = 0;
  #failedRequests = 0;
  #loadedSpecifiers = new Set<string>();
  #events: ArcgisEsmLifecycleEvent[] = [];

  constructor(
    configuration: ArcgisEsmLifecycleConfiguration,
    loader: ArcgisGovernedModuleLoader = defaultLoader,
  ) {
    this.#configuration = Object.freeze({
      bundleBudget: configuration.bundleBudget,
      governor: configuration.governor,
      maxEvents: positiveInteger(configuration.maxEvents, 'maxEvents'),
    });
    this.#governor = createArcgisModuleLoadGovernor(configuration.governor, loader);
    this.#coverage = auditArcgisModuleCatalog(getDefaultArcgisEsmSpecifiers());
    if (!this.#coverage.valid) {
      throw new Error('ArcGIS ESM static importer registry does not match the module catalog.');
    }
  }

  get disposed(): boolean {
    return this.#disposed;
  }

  auditStaticCoverage(): ArcgisModuleCatalogAudit {
    return this.#coverage;
  }

  async ensureFeatures(
    requests: readonly (ArcgisFeatureIntent | ArcgisFeatureRequest)[],
    options: ArcgisEsmLifecycleOptions = {},
  ): Promise<ArcgisEsmBundleResult> {
    this.#assertActive();
    throwIfAborted(options.signal);
    const plan = planArcgisBundle(requests, this.#configuration.bundleBudget);
    this.#featureRequests += 1;
    this.#record('bundle-planned', plan.requestedFeatures.length, plan.moduleIds.length, null);

    if (!plan.complete) {
      this.#incompletePlans += 1;
      this.#record(
        'bundle-deferred',
        plan.requestedFeatures.length,
        plan.moduleIds.length,
        plan.deferredFeatures.join(','),
      );
      if (options.requireComplete) throw incompletePlanError(plan);
    }

    if (plan.moduleIds.length === 0) {
      return Object.freeze({ plan, modules: Object.freeze([]) });
    }

    try {
      const values = await this.#governor.submit(
        plan.moduleIds,
        createLoadOptions(options, `bundle:${plan.specifiers.join('|')}`),
      );
      const modules = plan.moduleIds.map((moduleId, index) => {
        const resolved = resolveArcgisCatalogModules([moduleId])[0]!;
        this.#loadedSpecifiers.add(resolved.descriptor.specifier);
        return Object.freeze({
          moduleId,
          specifier: resolved.descriptor.specifier,
          value: values[index],
        });
      });
      this.#record('bundle-completed', plan.requestedFeatures.length, modules.length, null);
      return Object.freeze({ plan, modules: Object.freeze(modules) });
    } catch (error: unknown) {
      this.#failedRequests += 1;
      this.#record(
        'bundle-failed',
        plan.requestedFeatures.length,
        plan.moduleIds.length,
        error instanceof Error ? error.message : String(error),
      );
      throw error;
    }
  }

  ensureProfile(
    profile: ArcgisRuntimeFeatureProfile,
    options: ArcgisEsmLifecycleOptions = {},
  ): Promise<ArcgisEsmBundleResult> {
    return this.ensureFeatures(expandArcgisRuntimeFeatureProfile(profile), options);
  }

  prewarmProfile(
    profile: ArcgisRuntimeFeatureProfile,
    options: Omit<ArcgisEsmLifecycleOptions, 'priority'> = {},
  ): Promise<ArcgisEsmBundleResult> {
    return this.ensureProfile(profile, { ...options, priority: 'prefetch' });
  }

  async ensureModuleIds(
    moduleIdsInput: readonly string[],
    options: ArcgisEsmLifecycleOptions = {},
  ): Promise<readonly ArcgisEsmLoadedModule[]> {
    this.#assertActive();
    throwIfAborted(options.signal);
    const resolved = resolveArcgisCatalogModules(moduleIdsInput);
    if (resolved.length > this.#configuration.bundleBudget.maxModules) {
      throw Object.assign(new Error('Direct ArcGIS ESM load exceeds the module-count budget.'), {
        code: 'DIRECT_MODULE_BUDGET_EXCEEDED',
      });
    }
    const requestedIds = resolved.map((item) => item.requestedId);
    const relativeWeight = sumArcgisModuleRelativeWeight(requestedIds);
    if (relativeWeight > this.#configuration.bundleBudget.maxRelativeWeight) {
      throw Object.assign(new Error('Direct ArcGIS ESM load exceeds the relative-weight budget.'), {
        code: 'DIRECT_WEIGHT_BUDGET_EXCEEDED',
      });
    }
    if (requestedIds.length === 0) return Object.freeze([]);

    this.#directRequests += 1;
    const specifiers = resolved.map((item) => item.descriptor.specifier);
    try {
      const values = await this.#governor.submit(
        requestedIds,
        createLoadOptions(options, `direct:${specifiers.join('|')}`),
      );
      const modules = resolved.map((item, index) => {
        this.#loadedSpecifiers.add(item.descriptor.specifier);
        return Object.freeze({
          moduleId: item.requestedId,
          specifier: item.descriptor.specifier,
          value: values[index],
        });
      });
      this.#record('direct-load-completed', 0, modules.length, null);
      return Object.freeze(modules);
    } catch (error: unknown) {
      this.#failedRequests += 1;
      this.#record(
        'bundle-failed',
        0,
        requestedIds.length,
        error instanceof Error ? error.message : String(error),
      );
      throw error;
    }
  }

  listEvents(): readonly ArcgisEsmLifecycleEvent[] {
    return Object.freeze([...this.#events]);
  }

  snapshot(): ArcgisEsmLifecycleSnapshot {
    return Object.freeze({
      disposed: this.#disposed,
      featureRequests: this.#featureRequests,
      directRequests: this.#directRequests,
      incompletePlans: this.#incompletePlans,
      failedRequests: this.#failedRequests,
      loadedSpecifiers: this.#loadedSpecifiers.size,
      coverageValid: this.#coverage.valid,
      retainedEvents: this.#events.length,
      governor: this.#governor.snapshot(),
    });
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#governor.dispose();
    this.#record('disposed', 0, 0, null);
  }

  #assertActive(): void {
    if (this.#disposed) throw lifecycleDisposedError();
  }

  #record(
    kind: ArcgisEsmLifecycleEventKind,
    requestedFeatures: number,
    moduleCount: number,
    detail: string | null,
  ): void {
    this.#events.unshift(Object.freeze({
      kind,
      timestamp: Date.now(),
      requestedFeatures,
      moduleCount,
      detail,
    }));
    if (this.#events.length > this.#configuration.maxEvents) {
      this.#events.length = this.#configuration.maxEvents;
    }
  }
}

export const createArcgisEsmLifecycleRuntime = (
  configuration: ArcgisEsmLifecycleConfiguration,
  loader: ArcgisGovernedModuleLoader = defaultLoader,
): ArcgisEsmLifecycleRuntime => new ArcgisEsmLifecycleRuntime(configuration, loader);
