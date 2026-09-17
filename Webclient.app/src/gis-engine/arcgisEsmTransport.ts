import type { ArcgisModuleTransport } from './arcgisModuleRuntime';

export type ArcgisEsmImporter = (specifier: string) => Promise<unknown>;

const LEGACY_ARCGIS_PREFIX = 'esri/';
const ESM_ARCGIS_PREFIX = '@arcgis/core/';

const normalizeModuleId = (moduleIdInput: string): string => {
  const moduleId = String(moduleIdInput ?? '').trim();
  if (!moduleId) throw new Error('ArcGIS module id is required.');
  return moduleId;
};

const withJavascriptExtension = (specifier: string): string =>
  specifier.endsWith('.js') ? specifier : `${specifier}.js`;

/**
 * Converts the retired AMD-style module ids used throughout the existing app
 * into @arcgis/core ESM specifiers. Keeping this translation in one place lets
 * the migration proceed consumer-by-consumer without spreading package-path
 * knowledge across the application.
 */
export const resolveArcgisEsmSpecifier = (moduleIdInput: string): string => {
  const moduleId = normalizeModuleId(moduleIdInput);

  if (moduleId.startsWith(ESM_ARCGIS_PREFIX)) {
    return withJavascriptExtension(moduleId);
  }

  if (moduleId.startsWith(LEGACY_ARCGIS_PREFIX)) {
    return withJavascriptExtension(`${ESM_ARCGIS_PREFIX}${moduleId.slice(LEGACY_ARCGIS_PREFIX.length)}`);
  }

  throw new Error(`Unsupported ArcGIS module id: ${moduleId}`);
};

/**
 * @arcgis/core classes are normally default exports while utility/rest modules
 * are namespace exports. The legacy AMD loader returned the usable value in
 * both cases, so the transport normalizes those two ESM shapes here.
 */
export const unwrapArcgisEsmModule = (moduleNamespace: unknown): unknown => {
  if (
    moduleNamespace
    && typeof moduleNamespace === 'object'
    && 'default' in moduleNamespace
    && (moduleNamespace as { default?: unknown }).default !== undefined
  ) {
    return (moduleNamespace as { default: unknown }).default;
  }
  return moduleNamespace;
};

export const createArcgisEsmTransport = (importModule: ArcgisEsmImporter): ArcgisModuleTransport => {
  if (typeof importModule !== 'function') {
    throw new TypeError('ArcGIS ESM transport requires an import function.');
  }

  return Object.freeze({
    name: 'arcgis-core-esm',
    loadModules: async (moduleIds: readonly string[]) => Promise.all(
      moduleIds.map(async (moduleId) => {
        const namespace = await importModule(resolveArcgisEsmSpecifier(moduleId));
        return unwrapArcgisEsmModule(namespace);
      }),
    ),
  });
};
