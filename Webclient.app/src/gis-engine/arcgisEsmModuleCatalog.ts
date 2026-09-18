import { resolveArcgisEsmSpecifier } from './arcgisEsmTransport';

export type ArcgisModuleGroup =
  | 'core'
  | 'reactivity'
  | 'geometry'
  | 'layer'
  | 'query'
  | 'view-2d'
  | 'view-3d'
  | 'widget';

export type ArcgisModulePrewarmClass = 'core' | 'feature' | 'on-demand';

export type ArcgisModuleDescriptor = Readonly<{
  moduleId: string;
  specifier: string;
  groups: readonly ArcgisModuleGroup[];
  relativeWeight: number;
  prewarmClass: ArcgisModulePrewarmClass;
}>;

export type ArcgisResolvedModule = Readonly<{
  requestedId: string;
  descriptor: ArcgisModuleDescriptor;
}>;

export type ArcgisModuleCatalogAudit = Readonly<{
  catalogSpecifiers: readonly string[];
  registeredSpecifiers: readonly string[];
  missingFromCatalog: readonly string[];
  missingFromTransport: readonly string[];
  valid: boolean;
}>;

const descriptor = (
  moduleId: string,
  specifier: string,
  groups: readonly ArcgisModuleGroup[],
  relativeWeight: number,
  prewarmClass: ArcgisModulePrewarmClass,
): ArcgisModuleDescriptor => Object.freeze({
  moduleId,
  specifier,
  groups: Object.freeze([...groups]),
  relativeWeight,
  prewarmClass,
});

const ARCGIS_MODULE_CATALOG: readonly ArcgisModuleDescriptor[] = Object.freeze([
  descriptor('esri/Basemap', '@arcgis/core/Basemap.js', ['core'], 2, 'feature'),
  descriptor('esri/Graphic', '@arcgis/core/Graphic.js', ['core'], 2, 'core'),
  descriptor('esri/Map', '@arcgis/core/Map.js', ['core'], 3, 'core'),
  descriptor('esri/config', '@arcgis/core/config.js', ['core'], 1, 'core'),
  descriptor('esri/core/reactiveUtils', '@arcgis/core/core/reactiveUtils.js', ['core', 'reactivity'], 1, 'core'),
  descriptor('esri/core/urlUtils', '@arcgis/core/core/urlUtils.js', ['core'], 1, 'feature'),
  descriptor('esri/geometry/Circle', '@arcgis/core/geometry/Circle.js', ['geometry'], 1, 'feature'),
  descriptor('esri/geometry/Point', '@arcgis/core/geometry/Point.js', ['geometry'], 1, 'core'),
  descriptor('esri/geometry/Polygon', '@arcgis/core/geometry/Polygon.js', ['geometry'], 1, 'feature'),
  descriptor('esri/geometry/Polyline', '@arcgis/core/geometry/Polyline.js', ['geometry'], 1, 'feature'),
  descriptor('esri/geometry/SpatialReference', '@arcgis/core/geometry/SpatialReference.js', ['geometry'], 1, 'feature'),
  descriptor('esri/geometry/geometryEngine', '@arcgis/core/geometry/geometryEngine.js', ['geometry'], 4, 'on-demand'),
  descriptor('esri/geometry/projection', '@arcgis/core/geometry/projection.js', ['geometry'], 4, 'on-demand'),
  descriptor(
    'esri/geometry/support/geodesicUtils',
    '@arcgis/core/geometry/support/geodesicUtils.js',
    ['geometry'],
    3,
    'on-demand',
  ),
  descriptor(
    'esri/geometry/support/webMercatorUtils',
    '@arcgis/core/geometry/support/webMercatorUtils.js',
    ['geometry'],
    2,
    'feature',
  ),
  descriptor('esri/layers/FeatureLayer', '@arcgis/core/layers/FeatureLayer.js', ['layer'], 5, 'feature'),
  descriptor('esri/layers/GeoJSONLayer', '@arcgis/core/layers/GeoJSONLayer.js', ['layer'], 5, 'on-demand'),
  descriptor('esri/layers/GraphicsLayer', '@arcgis/core/layers/GraphicsLayer.js', ['layer'], 2, 'core'),
  descriptor('esri/layers/ImageryLayer', '@arcgis/core/layers/ImageryLayer.js', ['layer'], 6, 'on-demand'),
  descriptor('esri/layers/MapImageLayer', '@arcgis/core/layers/MapImageLayer.js', ['layer'], 5, 'feature'),
  descriptor('esri/layers/SceneLayer', '@arcgis/core/layers/SceneLayer.js', ['layer', 'view-3d'], 6, 'on-demand'),
  descriptor('esri/layers/VectorTileLayer', '@arcgis/core/layers/VectorTileLayer.js', ['layer'], 5, 'feature'),
  descriptor('esri/rest/identify', '@arcgis/core/rest/identify.js', ['query'], 2, 'on-demand'),
  descriptor('esri/rest/query', '@arcgis/core/rest/query.js', ['query'], 2, 'feature'),
  descriptor(
    'esri/rest/support/IdentifyParameters',
    '@arcgis/core/rest/support/IdentifyParameters.js',
    ['query'],
    1,
    'on-demand',
  ),
  descriptor('esri/rest/support/Query', '@arcgis/core/rest/support/Query.js', ['query'], 1, 'feature'),
  descriptor('esri/views/MapView', '@arcgis/core/views/MapView.js', ['view-2d'], 7, 'feature'),
  descriptor('esri/views/SceneView', '@arcgis/core/views/SceneView.js', ['view-3d'], 8, 'feature'),
  descriptor('esri/widgets/BasemapGallery', '@arcgis/core/widgets/BasemapGallery.js', ['widget'], 4, 'on-demand'),
  descriptor('esri/widgets/Legend', '@arcgis/core/widgets/Legend.js', ['widget'], 3, 'on-demand'),
  descriptor('esri/widgets/Measurement', '@arcgis/core/widgets/Measurement.js', ['widget'], 5, 'on-demand'),
  descriptor('esri/widgets/Sketch', '@arcgis/core/widgets/Sketch.js', ['widget'], 5, 'on-demand'),
  descriptor(
    'esri/widgets/Sketch/SketchViewModel',
    '@arcgis/core/widgets/Sketch/SketchViewModel.js',
    ['widget'],
    4,
    'on-demand',
  ),
]);

const descriptorBySpecifier = new Map(
  ARCGIS_MODULE_CATALOG.map((item) => [item.specifier, item] as const),
);

const normalizeRequestedId = (moduleIdInput: string): string => {
  const moduleId = String(moduleIdInput ?? '').trim();
  if (!moduleId) throw new Error('ArcGIS module id is required.');
  return moduleId;
};

const normalizeRegisteredSpecifiers = (specifiers: readonly string[]): string[] => (
  [...new Set(specifiers.map((specifier) => String(specifier ?? '').trim()).filter(Boolean))].sort()
);

export const listArcgisModuleDescriptors = (): readonly ArcgisModuleDescriptor[] =>
  ARCGIS_MODULE_CATALOG;

export const getArcgisModuleDescriptor = (moduleIdInput: string): ArcgisModuleDescriptor | null => {
  const moduleId = normalizeRequestedId(moduleIdInput);
  const specifier = resolveArcgisEsmSpecifier(moduleId);
  return descriptorBySpecifier.get(specifier) ?? null;
};

export const requireArcgisModuleDescriptor = (moduleIdInput: string): ArcgisModuleDescriptor => {
  const moduleId = normalizeRequestedId(moduleIdInput);
  const found = getArcgisModuleDescriptor(moduleId);
  if (!found) {
    throw new Error(`ArcGIS module ${moduleId} is not present in the static ESM catalog.`);
  }
  return found;
};

export const resolveArcgisCatalogModules = (
  moduleIds: readonly string[],
): readonly ArcgisResolvedModule[] => {
  const seenSpecifiers = new Set<string>();
  const resolved: ArcgisResolvedModule[] = [];

  for (const moduleIdInput of moduleIds) {
    const requestedId = normalizeRequestedId(moduleIdInput);
    const descriptorValue = requireArcgisModuleDescriptor(requestedId);
    if (seenSpecifiers.has(descriptorValue.specifier)) continue;
    seenSpecifiers.add(descriptorValue.specifier);
    resolved.push(Object.freeze({ requestedId, descriptor: descriptorValue }));
  }

  return Object.freeze(resolved);
};

export const listArcgisModulesByGroup = (
  group: ArcgisModuleGroup,
): readonly ArcgisModuleDescriptor[] => Object.freeze(
  ARCGIS_MODULE_CATALOG.filter((item) => item.groups.includes(group)),
);

export const sumArcgisModuleRelativeWeight = (
  moduleIds: readonly string[],
): number => resolveArcgisCatalogModules(moduleIds)
  .reduce((total, item) => total + item.descriptor.relativeWeight, 0);

export const auditArcgisModuleCatalog = (
  registeredSpecifiersInput: readonly string[],
): ArcgisModuleCatalogAudit => {
  const registeredSpecifiers = normalizeRegisteredSpecifiers(registeredSpecifiersInput);
  const catalogSpecifiers = [...new Set(ARCGIS_MODULE_CATALOG.map((item) => item.specifier))].sort();
  const registeredSet = new Set(registeredSpecifiers);
  const catalogSet = new Set(catalogSpecifiers);
  const missingFromCatalog = registeredSpecifiers.filter((specifier) => !catalogSet.has(specifier));
  const missingFromTransport = catalogSpecifiers.filter((specifier) => !registeredSet.has(specifier));

  return Object.freeze({
    catalogSpecifiers: Object.freeze(catalogSpecifiers),
    registeredSpecifiers: Object.freeze(registeredSpecifiers),
    missingFromCatalog: Object.freeze(missingFromCatalog),
    missingFromTransport: Object.freeze(missingFromTransport),
    valid: missingFromCatalog.length === 0 && missingFromTransport.length === 0,
  });
};

export const describeArcgisModuleCatalog = (): Readonly<{
  moduleCount: number;
  relativeWeight: number;
  groups: Readonly<Record<ArcgisModuleGroup, number>>;
  prewarm: Readonly<Record<ArcgisModulePrewarmClass, number>>;
}> => {
  const groups: Record<ArcgisModuleGroup, number> = {
    core: 0,
    reactivity: 0,
    geometry: 0,
    layer: 0,
    query: 0,
    'view-2d': 0,
    'view-3d': 0,
    widget: 0,
  };
  const prewarm: Record<ArcgisModulePrewarmClass, number> = {
    core: 0,
    feature: 0,
    'on-demand': 0,
  };

  let relativeWeight = 0;
  for (const item of ARCGIS_MODULE_CATALOG) {
    relativeWeight += item.relativeWeight;
    prewarm[item.prewarmClass] += 1;
    for (const group of item.groups) groups[group] += 1;
  }

  return Object.freeze({
    moduleCount: ARCGIS_MODULE_CATALOG.length,
    relativeWeight,
    groups: Object.freeze(groups),
    prewarm: Object.freeze(prewarm),
  });
};
