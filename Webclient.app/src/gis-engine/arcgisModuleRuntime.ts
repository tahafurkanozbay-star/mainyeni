import { createDefaultArcgisEsmTransport } from './arcgisEsmTransport';

export interface ArcgisModuleRuntimeConfiguration {
  version?: string;
  css?: boolean;
  insertCssBefore?: string;
}

export interface ArcgisModuleTransport {
  readonly name: string;
  readonly configure?: (configuration: ArcgisModuleRuntimeConfiguration) => void;
  readonly loadModules: (moduleIds: readonly string[]) => Promise<readonly unknown[]>;
}

export interface ArcgisModuleRuntimeSnapshot {
  backend: string;
  configured: boolean;
  version: string | null;
  cachedModules: number;
  loadRequests: number;
  cacheHits: number;
  failures: number;
  transportChanges: number;
}

const defaultEsmTransport = createDefaultArcgisEsmTransport();

const moduleCache = new Map<string, Promise<unknown>>();
let activeTransport: ArcgisModuleTransport = defaultEsmTransport;
let configured = false;
let configuredVersion: string | null = null;
let loadRequests = 0;
let cacheHits = 0;
let failures = 0;
let transportChanges = 0;

const normalizeModuleId = (moduleId: string): string => {
  const normalized = String(moduleId ?? '').trim();
  if (!normalized) throw new Error('ArcGIS module id is required.');
  return normalized;
};

const validateTransport = (transport: ArcgisModuleTransport): ArcgisModuleTransport => {
  if (!transport || typeof transport.loadModules !== 'function') {
    throw new TypeError('ArcGIS module transport must provide loadModules().');
  }
  const name = String(transport.name ?? '').trim();
  if (!name) throw new TypeError('ArcGIS module transport name is required.');
  return transport;
};

const clearModuleCache = (): void => {
  moduleCache.clear();
};

const unique = <T>(values: readonly T[]): T[] => [...new Set(values)];

const loadMissingModules = (moduleIds: readonly string[]): void => {
  const missing = unique(moduleIds.filter((moduleId) => !moduleCache.has(moduleId)));
  if (missing.length === 0) return;

  loadRequests += 1;
  const transportAtRequestTime = activeTransport;
  const batchPromise = transportAtRequestTime.loadModules(missing)
    .then((modules) => {
      if (!Array.isArray(modules)) {
        throw new TypeError(`ArcGIS module transport ${transportAtRequestTime.name} returned a non-array payload.`);
      }
      if (modules.length !== missing.length) {
        throw new Error(
          `ArcGIS module transport ${transportAtRequestTime.name} returned ${modules.length} module(s) for ${missing.length} request(s).`,
        );
      }
      return modules;
    })
    .catch((error: unknown) => {
      failures += 1;
      for (const moduleId of missing) moduleCache.delete(moduleId);
      throw error;
    });

  for (const [index, moduleId] of missing.entries()) {
    moduleCache.set(moduleId, batchPromise.then((modules) => modules[index]));
  }
};

/**
 * ArcGIS module boundary backed by @arcgis/core ESM. Consumers keep a stable
 * module-loading contract while the runtime owns bundling, cache de-duplication,
 * compatibility adapters and test-only transport injection in one place.
 */
export const configureArcgisModuleRuntime = (
  configuration: ArcgisModuleRuntimeConfiguration = {},
): ArcgisModuleRuntimeSnapshot => {
  activeTransport.configure?.(configuration);
  configured = true;
  configuredVersion = typeof configuration.version === 'string' && configuration.version.trim()
    ? configuration.version.trim()
    : null;
  return getArcgisModuleRuntimeSnapshot();
};

export const setArcgisModuleTransport = (transport: ArcgisModuleTransport): ArcgisModuleRuntimeSnapshot => {
  const nextTransport = validateTransport(transport);
  if (nextTransport === activeTransport) return getArcgisModuleRuntimeSnapshot();
  activeTransport = nextTransport;
  clearModuleCache();
  configured = false;
  configuredVersion = null;
  transportChanges += 1;
  return getArcgisModuleRuntimeSnapshot();
};

export const resetArcgisModuleTransport = (): ArcgisModuleRuntimeSnapshot => {
  if (activeTransport !== defaultEsmTransport) {
    activeTransport = defaultEsmTransport;
    clearModuleCache();
    configured = false;
    configuredVersion = null;
    transportChanges += 1;
  }
  return getArcgisModuleRuntimeSnapshot();
};

export const evictArcgisModule = (moduleIdInput: string): boolean => {
  const moduleId = normalizeModuleId(moduleIdInput);
  return moduleCache.delete(moduleId);
};

export const evictArcgisModules = (moduleIds: readonly string[]): number => {
  let removed = 0;
  for (const moduleId of unique(moduleIds.map(normalizeModuleId))) {
    if (moduleCache.delete(moduleId)) removed += 1;
  }
  return removed;
};

export const loadArcgisModules = async <TModules extends readonly unknown[] = readonly unknown[]>(
  moduleIdsInput: readonly string[],
): Promise<TModules> => {
  const moduleIds = moduleIdsInput.map(normalizeModuleId);
  if (moduleIds.length === 0) return [] as unknown as TModules;

  const cachedAtStart = new Set(moduleIds.filter((moduleId) => moduleCache.has(moduleId)));
  cacheHits += cachedAtStart.size;
  loadMissingModules(moduleIds);

  const modules = await Promise.all(moduleIds.map((moduleId) => {
    const cached = moduleCache.get(moduleId);
    if (!cached) {
      throw new Error(`ArcGIS module ${moduleId} was not cached after scheduling.`);
    }
    return cached;
  }));
  return modules as unknown as TModules;
};

export const loadArcgisModule = async <T = unknown>(moduleIdInput: string): Promise<T> => {
  const [module] = await loadArcgisModules<readonly [T]>([moduleIdInput]);
  return module;
};

export const getArcgisModuleRuntimeSnapshot = (): ArcgisModuleRuntimeSnapshot => Object.freeze({
  backend: activeTransport.name,
  configured,
  version: configuredVersion,
  cachedModules: moduleCache.size,
  loadRequests,
  cacheHits,
  failures,
  transportChanges,
});

export const resetArcgisModuleRuntimeCache = (): void => {
  clearModuleCache();
  loadRequests = 0;
  cacheHits = 0;
  failures = 0;
};
