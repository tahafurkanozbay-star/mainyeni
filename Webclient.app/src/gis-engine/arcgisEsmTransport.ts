import type { ArcgisModuleTransport } from './arcgisModuleRuntime';

export type ArcgisEsmImporter = (specifier: string) => Promise<unknown>;

interface RemovableHandle {
  remove: () => void;
}

type ReactiveWatch = (
  getValue: () => unknown,
  callback: (newValue: unknown, oldValue?: unknown) => void,
  options?: Readonly<{ initial?: boolean; once?: boolean; sync?: boolean }>,
) => RemovableHandle;

type QueryRestFunction = (url: string, query: unknown, requestOptions?: unknown) => Promise<unknown>;

const LEGACY_ARCGIS_PREFIX = 'esri/';
const ESM_ARCGIS_PREFIX = '@arcgis/core/';

const LEGACY_ESM_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  'esri/core/watchUtils': '@arcgis/core/core/reactiveUtils.js',
  'esri/tasks/QueryTask': '@arcgis/core/rest/query.js',
  'esri/tasks/support/Query': '@arcgis/core/rest/support/Query.js',
});

const defaultImporters: Readonly<Record<string, () => Promise<unknown>>> = Object.freeze({
  '@arcgis/core/Basemap.js': () => import('@arcgis/core/Basemap.js'),
  '@arcgis/core/Graphic.js': () => import('@arcgis/core/Graphic.js'),
  '@arcgis/core/Map.js': () => import('@arcgis/core/Map.js'),
  '@arcgis/core/config.js': () => import('@arcgis/core/config.js'),
  '@arcgis/core/core/reactiveUtils.js': () => import('@arcgis/core/core/reactiveUtils.js'),
  '@arcgis/core/core/urlUtils.js': () => import('@arcgis/core/core/urlUtils.js'),
  '@arcgis/core/geometry/Circle.js': () => import('@arcgis/core/geometry/Circle.js'),
  '@arcgis/core/geometry/Point.js': () => import('@arcgis/core/geometry/Point.js'),
  '@arcgis/core/geometry/Polygon.js': () => import('@arcgis/core/geometry/Polygon.js'),
  '@arcgis/core/geometry/Polyline.js': () => import('@arcgis/core/geometry/Polyline.js'),
  '@arcgis/core/geometry/SpatialReference.js': () => import('@arcgis/core/geometry/SpatialReference.js'),
  '@arcgis/core/geometry/geometryEngine.js': () => import('@arcgis/core/geometry/geometryEngine.js'),
  '@arcgis/core/geometry/projection.js': () => import('@arcgis/core/geometry/projection.js'),
  '@arcgis/core/geometry/support/geodesicUtils.js': () => import('@arcgis/core/geometry/support/geodesicUtils.js'),
  '@arcgis/core/geometry/support/webMercatorUtils.js': () => import('@arcgis/core/geometry/support/webMercatorUtils.js'),
  '@arcgis/core/layers/FeatureLayer.js': () => import('@arcgis/core/layers/FeatureLayer.js'),
  '@arcgis/core/layers/GeoJSONLayer.js': () => import('@arcgis/core/layers/GeoJSONLayer.js'),
  '@arcgis/core/layers/GraphicsLayer.js': () => import('@arcgis/core/layers/GraphicsLayer.js'),
  '@arcgis/core/layers/MapImageLayer.js': () => import('@arcgis/core/layers/MapImageLayer.js'),
  '@arcgis/core/layers/WMSLayer.js': () => import('@arcgis/core/layers/WMSLayer.js'),
  '@arcgis/core/rest/identify.js': () => import('@arcgis/core/rest/identify.js'),
  '@arcgis/core/rest/query.js': () => import('@arcgis/core/rest/query.js'),
  '@arcgis/core/rest/support/IdentifyParameters.js': () => import('@arcgis/core/rest/support/IdentifyParameters.js'),
  '@arcgis/core/rest/support/Query.js': () => import('@arcgis/core/rest/support/Query.js'),
  '@arcgis/core/views/MapView.js': () => import('@arcgis/core/views/MapView.js'),
  '@arcgis/core/views/SceneView.js': () => import('@arcgis/core/views/SceneView.js'),
  '@arcgis/core/widgets/BasemapGallery.js': () => import('@arcgis/core/widgets/BasemapGallery.js'),
  '@arcgis/core/widgets/Legend.js': () => import('@arcgis/core/widgets/Legend.js'),
  '@arcgis/core/widgets/Measurement.js': () => import('@arcgis/core/widgets/Measurement.js'),
  '@arcgis/core/widgets/Sketch.js': () => import('@arcgis/core/widgets/Sketch.js'),
  '@arcgis/core/widgets/Sketch/SketchViewModel.js': () => import('@arcgis/core/widgets/Sketch/SketchViewModel.js'),
});

const normalizeModuleId = (moduleIdInput: string): string => {
  const moduleId = String(moduleIdInput ?? '').trim();
  if (!moduleId) throw new Error('ArcGIS module id is required.');
  return moduleId;
};

const withJavascriptExtension = (specifier: string): string =>
  specifier.endsWith('.js') ? specifier : `${specifier}.js`;

export const resolveArcgisEsmSpecifier = (moduleIdInput: string): string => {
  const moduleId = normalizeModuleId(moduleIdInput);
  const alias = LEGACY_ESM_ALIASES[moduleId];
  if (alias) return alias;

  if (moduleId.startsWith(ESM_ARCGIS_PREFIX)) {
    return withJavascriptExtension(moduleId);
  }

  if (moduleId.startsWith(LEGACY_ARCGIS_PREFIX)) {
    return withJavascriptExtension(`${ESM_ARCGIS_PREFIX}${moduleId.slice(LEGACY_ARCGIS_PREFIX.length)}`);
  }

  throw new Error(`Unsupported ArcGIS module id: ${moduleId}`);
};

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

const readTargetProperty = (target: unknown, propertyName: string): unknown => {
  if (target === null || target === undefined) return undefined;
  return (target as Record<string, unknown>)[propertyName];
};

const createWatchUtilsCompatibility = (moduleNamespace: unknown): Readonly<Record<string, unknown>> => {
  const reactive = moduleNamespace as { watch?: ReactiveWatch; when?: ReactiveWatch };
  if (typeof reactive.watch !== 'function' || typeof reactive.when !== 'function') {
    throw new TypeError('ArcGIS reactiveUtils compatibility requires watch() and when().');
  }

  const watch = reactive.watch;
  const when = reactive.when;
  return Object.freeze({
    init: (target: unknown, propertyName: string, callback: (value: unknown) => void) =>
      watch(() => readTargetProperty(target, propertyName), callback, { initial: true }),
    watch: (target: unknown, propertyName: string, callback: (value: unknown, oldValue?: unknown) => void) =>
      watch(() => readTargetProperty(target, propertyName), callback),
    when: (target: unknown, propertyName: string, callback: (value: unknown) => void) =>
      when(() => Boolean(readTargetProperty(target, propertyName)), callback, { initial: true }),
    whenOnce: (target: unknown, propertyName: string, callback: (value: unknown) => void) =>
      when(() => Boolean(readTargetProperty(target, propertyName)), callback, { initial: true, once: true }),
    whenTrue: (target: unknown, propertyName: string, callback: (value: unknown) => void) =>
      when(() => readTargetProperty(target, propertyName) === true, callback, { initial: true }),
    whenFalse: (target: unknown, propertyName: string, callback: (value: unknown) => void) =>
      when(() => readTargetProperty(target, propertyName) === false, callback, { initial: true }),
  });
};

const createQueryTaskCompatibility = (moduleNamespace: unknown): unknown => {
  const queryRest = moduleNamespace as {
    executeQueryJSON?: QueryRestFunction;
    executeForCount?: QueryRestFunction;
    executeForIds?: QueryRestFunction;
  };
  if (typeof queryRest.executeQueryJSON !== 'function') {
    throw new TypeError('ArcGIS QueryTask compatibility requires rest/query.executeQueryJSON().');
  }

  const executeQueryJSON = queryRest.executeQueryJSON;
  const executeForCount = queryRest.executeForCount;
  const executeForIds = queryRest.executeForIds;

  return class QueryTaskCompatibility {
    readonly url: string;

    constructor(options: Readonly<{ url?: unknown }> = {}) {
      this.url = String(options.url ?? '').trim();
      if (!this.url) throw new Error('ArcGIS QueryTask compatibility requires a layer URL.');
    }

    execute(query: unknown, requestOptions?: unknown): Promise<unknown> {
      return executeQueryJSON(this.url, query, requestOptions);
    }

    executeForCount(query: unknown, requestOptions?: unknown): Promise<unknown> {
      if (typeof executeForCount !== 'function') {
        return Promise.reject(new Error('ArcGIS rest/query does not expose executeForCount().'));
      }
      return executeForCount(this.url, query, requestOptions);
    }

    executeForIds(query: unknown, requestOptions?: unknown): Promise<unknown> {
      if (typeof executeForIds !== 'function') {
        return Promise.reject(new Error('ArcGIS rest/query does not expose executeForIds().'));
      }
      return executeForIds(this.url, query, requestOptions);
    }
  };
};

export const adaptArcgisEsmModule = (moduleIdInput: string, moduleNamespace: unknown): unknown => {
  const moduleId = normalizeModuleId(moduleIdInput);
  if (moduleId === 'esri/core/watchUtils') return createWatchUtilsCompatibility(moduleNamespace);
  if (moduleId === 'esri/tasks/QueryTask') return createQueryTaskCompatibility(moduleNamespace);
  return unwrapArcgisEsmModule(moduleNamespace);
};

export const importArcgisCoreModule: ArcgisEsmImporter = async (specifierInput: string) => {
  const specifier = String(specifierInput ?? '').trim();
  const importer = defaultImporters[specifier];
  if (!importer) {
    throw new Error(`ArcGIS ESM module is not registered for bundling: ${specifier}`);
  }
  return importer();
};

export const getDefaultArcgisEsmSpecifiers = (): readonly string[] =>
  Object.freeze(Object.keys(defaultImporters).sort());

export const createArcgisEsmTransport = (importModule: ArcgisEsmImporter): ArcgisModuleTransport => {
  if (typeof importModule !== 'function') {
    throw new TypeError('ArcGIS ESM transport requires an import function.');
  }

  return Object.freeze({
    name: 'arcgis-core-esm',
    loadModules: async (moduleIds: readonly string[]) => Promise.all(
      moduleIds.map(async (moduleId) => {
        const namespace = await importModule(resolveArcgisEsmSpecifier(moduleId));
        return adaptArcgisEsmModule(moduleId, namespace);
      }),
    ),
  });
};

export const createDefaultArcgisEsmTransport = (): ArcgisModuleTransport =>
  createArcgisEsmTransport(importArcgisCoreModule);
