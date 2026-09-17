import * as esriLoaderNamespace from 'esri-loader';

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

type LegacyLoaderNamespace = typeof esriLoaderNamespace & {
  setDefaultOptions?: (options: ArcgisModuleRuntimeConfiguration) => void;
};

const legacyLoader = esriLoaderNamespace as LegacyLoaderNamespace;
const legacyAmdTransport: ArcgisModuleTransport = Object.freeze({
  name: 'legacy-amd',
  configure: (configuration) => legacyLoader.setDefaultOptions?.(configuration),
  loadModules: (moduleIds) => legacyLoader.loadModules([...moduleIds]),
});

const moduleCache = new Map<string, Promise<unknown>>();
let activeTransport: ArcgisModuleTransport = legacyAmdTransport;
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

/**
 * ArcGIS module boundary used while the application transitions from the retired
 * esri-loader AMD transport to @arcgis/core ESM. Consumers depend only on this
 * module, while the active transport can be swapped atomically and verified in
 * isolation before the package-level migration is completed.
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
  if (activeTransport !== legacyAmdTransport) {
    activeTransport = legacyAmdTransport;
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

export const loadArcgisModule = async <T = unknown>(moduleIdInput: string): Promise<T> => {
  const moduleId = normalizeModuleId(moduleIdInput);
  const cached = moduleCache.get(moduleId);
  if (cached) {
    cacheHits += 1;
    return cached as Promise<T>;
  }

  loadRequests += 1;
  const transportAtRequestTime = activeTransport;
  const request = transportAtRequestTime.loadModules([moduleId])
    .then((modules) => {
      if (!Array.isArray(modules) || modules.length === 0) {
        throw new Error(`ArcGIS module transport returned no module for ${moduleId}.`);
      }
      return modules[0] as T;
    })
    .catch((error: unknown) => {
      failures += 1;
      moduleCache.delete(moduleId);
      throw error;
    });
  moduleCache.set(moduleId, request as Promise<unknown>);
  return request;
};

export const loadArcgisModules = async <TModules extends readonly unknown[] = readonly unknown[]>(
  moduleIds: readonly string[],
): Promise<TModules> => {
  const modules = await Promise.all(moduleIds.map((moduleId) => loadArcgisModule(moduleId)));
  return modules as unknown as TModules;
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
