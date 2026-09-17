import * as esriLoaderNamespace from 'esri-loader';

export interface ArcgisModuleRuntimeConfiguration {
  version?: string;
  css?: boolean;
  insertCssBefore?: string;
}

export interface ArcgisModuleRuntimeSnapshot {
  backend: 'legacy-amd';
  configured: boolean;
  version: string | null;
  cachedModules: number;
  loadRequests: number;
  cacheHits: number;
  failures: number;
}

type LegacyLoaderNamespace = typeof esriLoaderNamespace & {
  setDefaultOptions?: (options: ArcgisModuleRuntimeConfiguration) => void;
};

const legacyLoader = esriLoaderNamespace as LegacyLoaderNamespace;
const moduleCache = new Map<string, Promise<unknown>>();
let configured = false;
let configuredVersion: string | null = null;
let loadRequests = 0;
let cacheHits = 0;
let failures = 0;

const normalizeModuleId = (moduleId: string): string => {
  const normalized = String(moduleId ?? '').trim();
  if (!normalized) throw new Error('ArcGIS module id is required.');
  return normalized;
};

/**
 * Temporary ArcGIS module boundary used while the application transitions from
 * the retired esri-loader AMD transport to @arcgis/core ESM. Application code
 * must depend on this module instead of importing esri-loader directly so the
 * transport can be replaced without touching every GIS consumer again.
 */
export const configureArcgisModuleRuntime = (
  configuration: ArcgisModuleRuntimeConfiguration = {},
): ArcgisModuleRuntimeSnapshot => {
  legacyLoader.setDefaultOptions?.(configuration);
  configured = true;
  configuredVersion = typeof configuration.version === 'string' && configuration.version.trim()
    ? configuration.version.trim()
    : null;
  return getArcgisModuleRuntimeSnapshot();
};

export const loadArcgisModule = async <T = unknown>(moduleIdInput: string): Promise<T> => {
  const moduleId = normalizeModuleId(moduleIdInput);
  const cached = moduleCache.get(moduleId);
  if (cached) {
    cacheHits += 1;
    return cached as Promise<T>;
  }

  loadRequests += 1;
  const request = legacyLoader.loadModules([moduleId])
    .then((modules) => modules[0] as T)
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
  backend: 'legacy-amd',
  configured,
  version: configuredVersion,
  cachedModules: moduleCache.size,
  loadRequests,
  cacheHits,
  failures,
});

export const resetArcgisModuleRuntimeCache = (): void => {
  moduleCache.clear();
  loadRequests = 0;
  cacheHits = 0;
  failures = 0;
};
